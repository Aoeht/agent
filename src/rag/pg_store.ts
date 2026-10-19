// src/rag/pg_store.ts
/**
 * 知识库的 PostgreSQL 后端：PgKnowledgeStore（文档/块）+ PgVectorCache（向量缓存）。
 * 与 JSON 文件实现（knowledge_store.ts / vector_store.ts）同接口、可互换，由 RAG_PG_URL 自动切换。
 *
 * 设计取舍：
 * - 全部表建在独立 schema（默认 rag）里，与库里其它项目的数据集互不干扰；DDL 幂等。
 * - 并发写靠 PG 事务，JSON 后端那套跨进程文件锁在这里不存在；多进程/多机共享同一知识库。
 * - 读路径不每次全量拉库：docs/chunks/revision 在一个 REPEATABLE READ 快照里读（revision 与数据严格配套），
 *   上层用 getRevision()（一条 meta 查询）探测变化，没变就不 list()；向量缓存进程内常驻，只补缺的 key。
 * - 向量存 real[] 而不是 pgvector：语料在数千块量级时应用层暴力余弦毫秒级（与 JSON 后端同一路径，
 *   复用 cosineTopK），零扩展依赖；语料上万块、需要 SQL 内相似度检索时再迁移 pgvector + HNSW。
 * - BM25/中文分词仍留在应用层（bm25.ts / tokenizer.ts）：PG 原生全文检索不支持中文，
 *   zhparser 在 Windows 上难装，且排序行为必须与 JSON 后端一致才能共用测试。
 * - fetched_at 用 bigint 存毫秒时间戳，与 KnowledgeDoc.fetchedAt 一一对应。
 */
import { createHash } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { chunkText, normalizeText, type ChunkOptions } from "./chunker";
import {
  KnowledgeChunk,
  KnowledgeDoc,
  KnowledgeInput,
  KnowledgeStoreApi,
  TrustLevel,
  normalizeSource,
} from "./knowledge_store";
import { vectorKey } from "./vector_store";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DOCS = 500;
const DEFAULT_MAX_CONTENT_CHARS = 8_000;
const VECTOR_INSERT_BATCH = 64;
/** 向量长尾清理：超过这个时长没被读写的条目按垃圾删掉（换模型换 key 后旧条目自然过期） */
const VECTOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 连接池按连接串共享：知识库与向量缓存两个实例复用同一个池 */
const pools = new Map<string, Pool>();

export function getPool(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString, max: 4 });
    pools.set(connectionString, pool);
  }
  return pool;
}

/** 脚本/测试进程退出前必须调用：连接池不关，bun 进程不会退出 */
export async function closePgPools(): Promise<void> {
  for (const [key, pool] of [...pools]) {
    pools.delete(key);
    await pool.end().catch(() => undefined);
  }
}

const SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error(`非法的 schema 名：${schema}（只允许字母数字下划线）`);
  return schema;
}

interface DocsRow {
  id: string;
  source: string;
  title: string | null;
  trust: string;
  fetched_at: string;
  content_hash: string;
}

interface ChunksRow {
  id: string;
  doc_id: string;
  text: string;
}

function rowToDoc(row: DocsRow, chunks: KnowledgeChunk[]): KnowledgeDoc {
  const title = row.title ?? undefined;
  return {
    id: row.id,
    source: row.source,
    ...(title ? { title } : {}),
    trust: row.trust as TrustLevel,
    fetchedAt: Number(row.fetched_at),
    contentHash: row.content_hash,
    chunks,
  };
}

const schemaReady = new WeakMap<Pool, Set<string>>();

/** 建 schema + 四张表（幂等）；同一 pool+schema 只执行一次 */
async function ensureSchema(pool: Pool, schema: string): Promise<void> {
  let ready = schemaReady.get(pool);
  if (!ready) {
    ready = new Set();
    schemaReady.set(pool, ready);
  }
  if (ready.has(schema)) return;
  const s = quoteSchema(schema);
  const client = await pool.connect().catch((error: NodeJS.ErrnoException) => {
    throw new Error(`连不上 PostgreSQL（${maskedUrlHint(error)}）：确认服务已启动、RAG_PG_URL 的主机/端口/口令正确`);
  });
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.docs (
      id text PRIMARY KEY,
      source text NOT NULL UNIQUE,
      title text,
      trust text NOT NULL CHECK (trust IN ('web', 'internal')),
      fetched_at bigint NOT NULL,
      content_hash text NOT NULL
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.chunks (
      id text PRIMARY KEY,
      doc_id text NOT NULL REFERENCES ${s}.docs (id) ON DELETE CASCADE,
      seq int NOT NULL,
      text text NOT NULL
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${s}_chunks_doc_idx ON ${s}.chunks (doc_id, seq)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.meta (key text PRIMARY KEY, value text NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${s}.vectors (
      key text PRIMARY KEY,
      model text NOT NULL,
      dims int NOT NULL,
      embedding real[] NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query("COMMIT");
    ready.add(schema);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error instanceof Error && /permission|权限/i.test(error.message)
      ? new Error(`在 PostgreSQL 里建 schema 失败：当前用户缺 CREATE 权限，或改用已有 schema（RAG_PG_SCHEMA）`)
      : error;
  } finally {
    client.release();
  }
}

function maskedUrlHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message) ? "连接被拒绝/超时" : "认证或连接失败";
}

export interface PgStoreOptions {
  connectionString: string;
  /** 独立 schema，默认 rag */
  schema?: string;
  ttlMs?: number;
  maxDocs?: number;
  maxContentChars?: number;
  chunk?: ChunkOptions;
  now?: () => number;
}

export class PgKnowledgeStore implements KnowledgeStoreApi {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly ttlMs: number;
  private readonly maxDocs: number;
  private readonly now: () => number;
  private revisionValue = 0;

  readonly maxContentChars: number;

  constructor(private readonly options: PgStoreOptions) {
    this.pool = getPool(options.connectionString);
    this.schema = quoteSchema(options.schema ?? "rag");
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxDocs = options.maxDocs ?? DEFAULT_MAX_DOCS;
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
    this.now = options.now ?? Date.now;
  }

  /** 仅用于展示，不回显连接串（里面有口令） */
  get filePath(): string {
    return `pg:${this.schema}`;
  }

  get revision(): number {
    return this.revisionValue;
  }

  isFresh(doc: KnowledgeDoc): boolean {
    return doc.trust !== "web" || this.now() - doc.fetchedAt <= this.ttlMs;
  }

  docId(source: string): string {
    return sha1(normalizeSource(source));
  }

  fingerprint(content: string): string {
    return sha1(normalizeText(content).slice(0, this.maxContentChars));
  }

  private get t(): string {
    return this.schema;
  }

  private async withTransaction<T>(task: (client: PoolClient) => Promise<T>): Promise<T> {
    await ensureSchema(this.pool, this.schema);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await task(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 只读快照事务：REPEATABLE READ + READ ONLY，事务内多条查询看到同一份已提交状态 */
  private async withSnapshot<T>(task: (client: PoolClient) => Promise<T>): Promise<T> {
    await ensureSchema(this.pool, this.schema);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await task(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** revision 存 meta 表：本进程或其它进程每次写都自增，list() 读回，上层据此重建 BM25 索引 */
  private async bumpRevision(client: PoolClient): Promise<void> {
    const result = await client.query<{ value: string }>(
      `INSERT INTO ${this.t}.meta (key, value) VALUES ('revision', '1')
       ON CONFLICT (key) DO UPDATE SET value = ((${this.t}.meta.value::bigint) + 1)::text
       RETURNING value`
    );
    this.revisionValue = Number(result.rows[0]?.value ?? 1);
  }

  private async readRevision(): Promise<void> {
    const result = await this.pool.query<{ value: string }>(`SELECT value FROM ${this.t}.meta WHERE key = 'revision'`);
    this.revisionValue = Number(result.rows[0]?.value ?? 0);
  }

  /** 廉价 revision 探测：一条 meta 查询，调用方据此决定要不要付 list() 的全量读取 */
  async getRevision(): Promise<number> {
    await ensureSchema(this.pool, this.schema);
    await this.readRevision();
    return this.revisionValue;
  }

  /**
   * 文档/块/revision 在同一 REPEATABLE READ READ ONLY 快照里读取：快照开始后的并发提交对本次不可见，
   * 返回的 docs 与 revision 严格配套 —— 否则"旧文档 + 新 revision"会让上层缓存出一份不再重建的旧索引。
   */
  async list(): Promise<KnowledgeDoc[]> {
    const loaded = await this.withSnapshot(async (client) => {
      const docs = await client.query<DocsRow>(
        `SELECT id, source, title, trust, fetched_at, content_hash FROM ${this.t}.docs ORDER BY id`
      );
      const chunks = await client.query<ChunksRow>(
        `SELECT id, doc_id, text FROM ${this.t}.chunks ORDER BY doc_id, seq`
      );
      const revision = Number(
        (await client.query<{ value: string }>(`SELECT value FROM ${this.t}.meta WHERE key = 'revision'`)).rows[0]?.value ??
          0
      );
      const byDoc = new Map<string, KnowledgeChunk[]>();
      for (const row of chunks.rows) {
        const list = byDoc.get(row.doc_id) ?? [];
        list.push({ id: row.id, text: row.text });
        byDoc.set(row.doc_id, list);
      }
      return { docs: docs.rows.map((row) => rowToDoc(row, byDoc.get(row.id) ?? [])), revision };
    });
    this.revisionValue = loaded.revision;
    return loaded.docs;
  }

  async get(id: string): Promise<KnowledgeDoc | undefined> {
    await ensureSchema(this.pool, this.schema);
    const doc = await this.pool.query<DocsRow>(
      `SELECT id, source, title, trust, fetched_at, content_hash FROM ${this.t}.docs WHERE id = $1`,
      [id]
    );
    const row = doc.rows[0];
    if (!row) return undefined;
    const chunks = await this.pool.query<ChunksRow>(
      `SELECT id, doc_id, text FROM ${this.t}.chunks WHERE doc_id = $1 ORDER BY seq`,
      [id]
    );
    return rowToDoc(row, chunks.rows.map((c) => ({ id: c.id, text: c.text })));
  }

  /** 与 JSON 后端 merge() 完全同语义：同源合并、contentHash 未变复用块、internal 信任不被覆盖 */
  async upsert(inputs: KnowledgeInput[]): Promise<KnowledgeDoc[]> {
    if (inputs.length === 0) return [];
    return this.withTransaction(async (client) => {
      const now = this.now();
      const saved: KnowledgeDoc[] = [];
      for (const input of inputs) {
        const content = normalizeText(input.content).slice(0, this.maxContentChars);
        if (!content || !input.source) continue;
        const source = normalizeSource(input.source);
        const id = this.docId(input.source);
        const contentHash = sha1(content);
        const prev = (
          await client.query<Pick<DocsRow, "title" | "trust" | "content_hash">>(
            `SELECT title, trust, content_hash FROM ${this.t}.docs WHERE id = $1`,
            [id]
          )
        ).rows[0];
        const title = input.title?.trim() || prev?.title || undefined;
        const trust: TrustLevel = prev?.trust === "internal" ? "internal" : input.trust;
        const unchanged = prev !== undefined && prev.content_hash === contentHash;

        await client.query(
          `INSERT INTO ${this.t}.docs (id, source, title, trust, fetched_at, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             source = EXCLUDED.source,
             title = COALESCE(EXCLUDED.title, ${this.t}.docs.title),
             trust = CASE WHEN ${this.t}.docs.trust = 'internal' THEN 'internal' ELSE EXCLUDED.trust END,
             fetched_at = EXCLUDED.fetched_at,
             content_hash = EXCLUDED.content_hash`,
          [id, source, title ?? null, trust, now, contentHash]
        );

        let chunks: KnowledgeChunk[];
        if (unchanged) {
          const existing = await client.query<ChunksRow>(
            `SELECT id, doc_id, text FROM ${this.t}.chunks WHERE doc_id = $1 ORDER BY seq`,
            [id]
          );
          chunks = existing.rows.map((c) => ({ id: c.id, text: c.text }));
        } else {
          chunks = chunkText(content, this.options.chunk).map((text, i) => ({ id: `${id.slice(0, 12)}#${i}`, text }));
          await client.query(`DELETE FROM ${this.t}.chunks WHERE doc_id = $1`, [id]);
          if (chunks.length > 0) {
            await client.query(
              `INSERT INTO ${this.t}.chunks (id, doc_id, seq, text)
               SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS c(id, doc_id, seq, body)`,
              [chunks.map((c) => c.id), chunks.map(() => id), chunks.map((_, i) => i), chunks.map((c) => c.text)]
            );
          }
        }
        saved.push({ id, source, ...(title ? { title } : {}), trust, fetchedAt: now, contentHash, chunks });
      }
      await this.pruneWith(client, now);
      await this.bumpRevision(client);
      return saved;
    });
  }

  /** 与 JSON 后端 prune() 同语义：过期 web 清掉，超出 maxDocs 再按最旧 web 淘汰 */
  private async pruneWith(client: PoolClient, now: number): Promise<void> {
    await client.query(`DELETE FROM ${this.t}.docs WHERE trust = 'web' AND $1 - fetched_at > $2`, [now, this.ttlMs]);
    const count = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${this.t}.docs`)).rows[0]!.n;
    const overflow = count - this.maxDocs;
    if (overflow > 0) {
      await client.query(
        `DELETE FROM ${this.t}.docs WHERE id IN (
           SELECT id FROM ${this.t}.docs WHERE trust = 'web' ORDER BY fetched_at ASC, id ASC LIMIT $1
         )`,
        [overflow]
      );
    }
  }

  async pruneInternal(prefixes: string[], keepIds: Set<string>): Promise<KnowledgeDoc[]> {
    if (prefixes.length === 0) return [];
    return this.withTransaction(async (client) => {
      const internal = await client.query<DocsRow>(
        `SELECT id, source, title, trust, fetched_at, content_hash FROM ${this.t}.docs WHERE trust = 'internal'`
      );
      const candidates = internal.rows.map((row) => rowToDoc(row, []));
      const removed = candidates.filter(
        (doc) => !keepIds.has(doc.id) && prefixes.some((prefix) => doc.source.startsWith(prefix))
      );
      if (removed.length === 0) return [];
      const ids = removed.map((doc) => doc.id);
      const chunks = await client.query<ChunksRow>(
        `SELECT id, doc_id, text FROM ${this.t}.chunks WHERE doc_id = ANY($1::text[]) ORDER BY doc_id, seq`,
        [ids]
      );
      const byDoc = new Map<string, KnowledgeChunk[]>();
      for (const row of chunks.rows) {
        const list = byDoc.get(row.doc_id) ?? [];
        list.push({ id: row.id, text: row.text });
        byDoc.set(row.doc_id, list);
      }
      await client.query(`DELETE FROM ${this.t}.docs WHERE id = ANY($1::text[])`, [ids]);
      await this.bumpRevision(client);
      return removed.map((doc) => ({ ...doc, chunks: byDoc.get(doc.id) ?? [] }));
    });
  }

  /**
   * 迁移专用：把 JSON 后端的文档连同块原样搬进来（id/content_hash/chunk id 全保留，不走 merge 重切）。
   * 幂等：同 id 覆盖。这样迁移后 fingerprint 仍与源内容一致，后续增量更新不会误判"内容变了"。
   */
  async importDocs(docs: KnowledgeDoc[]): Promise<number> {
    if (docs.length === 0) return 0;
    return this.withTransaction(async (client) => {
      for (const doc of docs) {
        await client.query(
          `INSERT INTO ${this.t}.docs (id, source, title, trust, fetched_at, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             source = EXCLUDED.source, title = EXCLUDED.title, trust = EXCLUDED.trust,
             fetched_at = EXCLUDED.fetched_at, content_hash = EXCLUDED.content_hash`,
          [doc.id, doc.source, doc.title ?? null, doc.trust, doc.fetchedAt, doc.contentHash]
        );
        await client.query(`DELETE FROM ${this.t}.chunks WHERE doc_id = $1`, [doc.id]);
        if (doc.chunks.length > 0) {
          await client.query(
            `INSERT INTO ${this.t}.chunks (id, doc_id, seq, text)
             SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS c(id, doc_id, seq, body)`,
            [doc.chunks.map((c) => c.id), doc.chunks.map(() => doc.id), doc.chunks.map((_, i) => i), doc.chunks.map((c) => c.text)]
          );
        }
      }
      await this.bumpRevision(client);
      return docs.length;
    });
  }
}

export interface PgVectorCacheOptions {
  connectionString: string;
  schema?: string;
  /** 模型名参与缓存 key：换模型旧向量自然失效，30 天后被清理 */
  model: string;
  /** 内存层条目上限，超出按写入先后淘汰（DB 里还在，被淘汰的 key 下次重新查库）；与 JSON VectorCache 同默认 */
  maxEntries?: number;
  now?: () => number;
}

/**
 * 向量缓存的 PostgreSQL 实现：与 JSON 的 VectorCache 同一个 ensure() 契约，
 * rag_search 的语义通道不感知后端差异。key 与 JSON 版完全一致（sha1(model + text)），
 * 所以 migrate_to_pg 可以把 vectors.json 原样搬过来。
 *
 * 两级缓存：进程内 Map 常驻（命中零网络往返，与 JSON 后端一致），未命中的 key 才查 PG，
 * 再缺的批量 embed 并回写两层。内存层超上限按写入先后淘汰，只是省网络，不影响正确性。
 */
export class PgVectorCache {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly now: () => number;
  private readonly memory = new Map<string, number[]>();
  private readonly maxEntries: number;

  constructor(private readonly options: PgVectorCacheOptions) {
    this.pool = getPool(options.connectionString);
    this.schema = quoteSchema(options.schema ?? "rag");
    this.maxEntries = options.maxEntries ?? 8_000;
    this.now = options.now ?? Date.now;
  }

  private get t(): string {
    return this.schema;
  }

  /** 内存层写入：满员先淘汰最早写入的条目再放新的 */
  private remember(key: string, vector: number[]): void {
    while (this.memory.size >= this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
    this.memory.set(key, vector);
  }

  async ensure(texts: string[], embed: (batch: string[]) => Promise<number[][]>): Promise<Map<string, number[]>> {
    await ensureSchema(this.pool, this.schema);
    const unique = [...new Set(texts)];
    const textByKey = new Map(unique.map((text) => [vectorKey(this.options.model, text), text] as const));

    // 第一级：内存层。命中就不必把全部 key 发去 PG
    const result = new Map<string, number[]>();
    const missingKeys: string[] = [];
    for (const [key, text] of textByKey) {
      const cached = this.memory.get(key);
      if (cached !== undefined) result.set(text, cached);
      else missingKeys.push(key);
    }

    // 第二级：PG。只查内存里缺的 key
    if (missingKeys.length > 0) {
      const found = await this.pool.query<{ key: string; embedding: number[] }>(
        `SELECT key, embedding FROM ${this.t}.vectors WHERE key = ANY($1::text[])`,
        [missingKeys]
      );
      for (const row of found.rows) {
        const text = textByKey.get(row.key);
        if (text === undefined || !Array.isArray(row.embedding) || row.embedding.length === 0) continue;
        result.set(text, row.embedding);
        this.remember(row.key, row.embedding);
      }
    }

    const missing = unique.filter((text) => !result.has(text));
    if (missing.length === 0) return result;

    for (let i = 0; i < missing.length; i += VECTOR_INSERT_BATCH) {
      const batch = missing.slice(i, i + VECTOR_INSERT_BATCH);
      const vectors = await embed(batch);
      const keys: string[] = [];
      const dims: number[] = [];
      const embeddings: number[][] = [];
      batch.forEach((text, j) => {
        const vector = vectors[j];
        if (!Array.isArray(vector) || vector.length === 0) return;
        result.set(text, vector);
        const key = vectorKey(this.options.model, text);
        this.remember(key, vector);
        keys.push(key);
        dims.push(vector.length);
        embeddings.push(vector);
      });
      if (keys.length === 0) continue;
      // unnest 对多维数组只出标量行，驱动还会重排字面量；改传一维 text[]（每项一个向量的数组字面量）逐行 ::real[] 还原
      const embeddingLiterals = embeddings.map((vector) => `{${vector.join(",")}}`);
      await this.pool.query(
        `INSERT INTO ${this.t}.vectors (key, model, dims, embedding, updated_at)
         SELECT k, m, d, e::real[], $5::timestamptz FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS v(k, m, d, e)
         ON CONFLICT (key) DO NOTHING`,
        [keys, keys.map(() => this.options.model), dims, embeddingLiterals, new Date(this.now())]
      );
    }
    // 顺手清长尾：换模型后旧 key 不会再被读到，靠这条淘汰
    await this.pool
      .query(`DELETE FROM ${this.t}.vectors WHERE updated_at < $1`, [new Date(this.now() - VECTOR_RETENTION_MS)])
      .catch(() => undefined);
    return result;
  }

  /** 迁移专用：vectors.json 的 entries 原样入库（key 本来就含模型名，跨模型不冲突） */
  async importEntries(entries: Record<string, number[]>): Promise<number> {
    await ensureSchema(this.pool, this.schema);
    const usable = Object.entries(entries).filter(([, vector]) => Array.isArray(vector) && vector.length > 0);
    for (let i = 0; i < usable.length; i += VECTOR_INSERT_BATCH) {
      const batch = usable.slice(i, i + VECTOR_INSERT_BATCH);
      await this.pool.query(
        `INSERT INTO ${this.t}.vectors (key, model, dims, embedding, updated_at)
         SELECT k, $2::text, d, e::real[], now() FROM unnest($1::text[], $3::int[], $4::text[]) AS v(k, d, e)
         ON CONFLICT (key) DO NOTHING`,
        [
          batch.map(([key]) => key),
          this.options.model,
          batch.map(([, vector]) => vector.length),
          batch.map(([, vector]) => `{${vector.join(",")}}`),
        ]
      );
    }
    return usable.length;
  }
}
