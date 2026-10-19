// src/rag/knowledge_store.ts
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chunkText, ChunkOptions, normalizeText } from "./chunker";

export type TrustLevel = "web" | "internal";

export interface KnowledgeChunk {
  id: string;
  text: string;
}

export interface KnowledgeDoc {
  id: string;
  source: string;
  title?: string;
  trust: TrustLevel;
  fetchedAt: number;
  contentHash: string;
  chunks: KnowledgeChunk[];
}

export interface KnowledgeInput {
  source: string;
  content: string;
  trust: TrustLevel;
  title?: string | undefined;
}

/**
 * 知识库后端的公开接口。JSON 文件实现是本文件的 KnowledgeStore，
 * PostgreSQL 实现见 pg_store.ts —— 二者按此接口可互换（选项 store 注入，或 RAG_PG_URL 自动切换）。
 */
export interface KnowledgeStoreApi {
  /** 仅供展示（日志/控制台输出）；PG 后端返回 pg:<schema> 形式 */
  readonly filePath: string;
  /** 正文入库前的长度上限，超出部分截断 */
  readonly maxContentChars: number;
  /** 内容每变化一次自增，供上层缓存检索索引；其它进程写入后实现方必须让它变化 */
  readonly revision: number;
  /**
   * 廉价探测当前 revision：顺带发现外部写入（PG 查一次 meta 表；JSON stat 一次文件签名），
   * 与上次见到的一致就说明语料没变，调用方可据此跳过 list() 的全量拉取。
   */
  getRevision(): Promise<number>;
  isFresh(doc: KnowledgeDoc): boolean;
  list(): Promise<KnowledgeDoc[]>;
  get(id: string): Promise<KnowledgeDoc | undefined>;
  upsert(inputs: KnowledgeInput[]): Promise<KnowledgeDoc[]>;
  /** 删除 source 以任一前缀开头的 internal 文档（keepIds 除外），返回被删的完整文档 */
  pruneInternal(prefixes: string[], keepIds: Set<string>): Promise<KnowledgeDoc[]>;
  docId(source: string): string;
  fingerprint(content: string): string;
}

export interface KnowledgeStoreOptions {
  filePath: string;
  /** 仅对 web 来源生效；internal 资料由导入方自己管理生命周期 */
  ttlMs?: number;
  maxDocs?: number;
  maxContentChars?: number;
  chunk?: ChunkOptions;
  now?: () => number;
  /** 等待其它进程释放写锁的时间上限，超时抛错而不是无锁写入（会丢失对方的删除） */
  lockTimeoutMs?: number;
  /** 抢锁重试间隔，测试可调小 */
  lockRetryDelayMs?: number;
}

interface StoreFileV2 {
  version: 2;
  docs: KnowledgeDoc[];
}

/** 用于判断磁盘文件是否被其它进程改动：mtime 单独用不够稳，配上 size */
interface FileSignature {
  mtimeMs: number;
  size: number;
}

interface LegacyEntry {
  content?: unknown;
  source?: unknown;
  timestamp?: unknown;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/** 锁文件超过这个时长视为进程崩溃残留（正常临界区只有读盘+落盘，毫秒级），可被抢占 */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 25;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只归一化 http(s) 链接（锚点、utm、末尾斜杠、主机大小写）；internal:// 等自定义来源原样保留 */
export function normalizeSource(source: string): string {
  const trimmed = source.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed;
  }
}

export class KnowledgeStore implements KnowledgeStoreApi {
  private docs = new Map<string, KnowledgeDoc>();
  private loaded = false;
  /** 最近一次读/写盘时文件的 mtime+size，用来发现其它进程的写入 */
  private lastSig: FileSignature | undefined;
  /** 本进程删过的文档 id：读盘合并时跳过，防止其它进程的旧副本把它们复活 */
  private readonly deletedIds = new Set<string>();
  /** 写事务链：upsert 与 pruneInternal 在同一进程内也串行，保证锁覆盖完整读-改-写 */
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly ttlMs: number;
  private readonly maxDocs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly now: () => number;
  /** 正文入库前的长度上限，超出部分截断 */
  readonly maxContentChars: number;
  /** 内容每变化一次自增，供上层缓存检索索引 */
  revision = 0;

  constructor(private readonly options: KnowledgeStoreOptions) {
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxDocs = options.maxDocs ?? 500;
    this.maxContentChars = options.maxContentChars ?? 8_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? LOCK_RETRY_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  get filePath(): string {
    return this.options.filePath;
  }

  private get lockPath(): string {
    return `${this.options.filePath}.lock`;
  }

  /**
   * 跨进程写锁：exclusive create（'wx'）在 Windows/Linux 都原子。
   * 拿不到且对方未超龄就重试；超龄锁（崩溃残留）直接抢占。
   */
  private async acquireLock(): Promise<void> {
    const deadline = this.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        await handle.writeFile(String(process.pid), "utf-8");
        await handle.close();
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          if (code === "ENOENT") {
            await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
            continue;
          }
          throw error;
        }
        const stat = await fs.stat(this.lockPath).catch(() => undefined);
        if (stat === undefined) continue;
        if (this.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(this.lockPath, { force: true });
          continue;
        }
        if (this.now() >= deadline) {
          throw new Error(
            `知识缓存被其它进程占用（锁 ${this.lockPath}，持有者 pid ${await fs.readFile(this.lockPath, "utf-8").catch(() => "?")}），等待 ${this.lockTimeoutMs}ms 后放弃`
          );
        }
        await sleep(this.lockRetryDelayMs);
      }
    }
  }

  private async releaseLock(): Promise<void> {
    await fs.rm(this.lockPath, { force: true }).catch(() => undefined);
  }

  /** 事务 = 取锁 → 读盘合并（含 prune）→ 落盘 → 放锁；期间内存视图不被对方吞掉 */
  private withLock<T>(task: () => Promise<T>): Promise<T> {
    return this.writeChain.then(async () => {
      await this.acquireLock();
      try {
        return await task();
      } finally {
        await this.releaseLock();
      }
    });
  }

  private async runWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.withLock(task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  isFresh(doc: KnowledgeDoc): boolean {
    return doc.trust !== "web" || this.now() - doc.fetchedAt <= this.ttlMs;
  }

  async list(): Promise<KnowledgeDoc[]> {
    if (!this.loaded) await this.reload();
    else await this.syncWithDisk();
    return [...this.docs.values()];
  }

  /** 只探测 revision 不拉全量：发现磁盘被其它进程改写时重载并自增，之后 revision 即与内存视图配套 */
  async getRevision(): Promise<number> {
    if (!this.loaded) await this.reload();
    else await this.syncWithDisk();
    return this.revision;
  }

  async get(id: string): Promise<KnowledgeDoc | undefined> {
    if (!this.loaded) await this.reload();
    return this.docs.get(id);
  }

  /** 按来源去重合并写入；同一进程内的写入串行，落盘走临时文件 + rename 保证不会写出半截 JSON */
  upsert(inputs: KnowledgeInput[]): Promise<KnowledgeDoc[]> {
    if (inputs.length === 0) return Promise.resolve([]);
    return this.runWrite(async () => {
      // 锁内重读，尽量不吞掉其它进程刚写入的内容
      await this.reload();
      const saved: KnowledgeDoc[] = [];
      for (const input of inputs) {
        const doc = this.merge(input);
        if (doc) saved.push(doc);
      }
      this.prune();
      await this.persist();
      this.revision++;
      return saved;
    });
  }

  /**
   * 删除 source 以任一前缀开头的 internal 文档（keepIds 除外），供 ingest --sync 清理改名/删除后留下的孤儿章节。
   * 只碰 internal：web 缓存由 TTL 和 prune 管理，不在导入范围内。
   */
  pruneInternal(prefixes: string[], keepIds: Set<string>): Promise<KnowledgeDoc[]> {
    if (prefixes.length === 0) return Promise.resolve([]);
    return this.runWrite(async () => {
      await this.reload();
      const removed: KnowledgeDoc[] = [];
      for (const [id, doc] of this.docs) {
        if (doc.trust !== "internal" || keepIds.has(id)) continue;
        if (prefixes.some((prefix) => doc.source.startsWith(prefix))) {
          this.docs.delete(id);
          this.deletedIds.add(id);
          removed.push(doc);
        }
      }
      if (removed.length > 0) {
        await this.persist();
        this.revision++;
      }
      return removed;
    });
  }

  /** 归一化来源后得到稳定 id，供调用方在写入前判断新增/更新/未变 */
  docId(source: string): string {
    return sha1(normalizeSource(source));
  }

  /** 与实际入库正文一致的指纹（已归一并截断），内容不变则 id 与块均复用 */
  fingerprint(content: string): string {
    return sha1(normalizeText(content).slice(0, this.maxContentChars));
  }

  private merge(input: KnowledgeInput): KnowledgeDoc | undefined {
    const content = normalizeText(input.content).slice(0, this.maxContentChars);
    if (!content || !input.source) return undefined;

    const source = normalizeSource(input.source);
    const id = this.docId(input.source);
    const contentHash = this.fingerprint(input.content);
    const existing = this.docs.get(id);
    const title = input.title?.trim() || existing?.title;

    const chunks =
      existing && existing.contentHash === contentHash
        ? existing.chunks
        : chunkText(content, this.options.chunk).map((text, i) => ({ id: `${id.slice(0, 12)}#${i}`, text }));

    const doc: KnowledgeDoc = {
      id,
      source,
      ...(title ? { title } : {}),
      trust: existing?.trust === "internal" ? "internal" : input.trust,
      fetchedAt: this.now(),
      contentHash,
      chunks,
    };
    this.docs.set(id, doc);
    this.deletedIds.delete(id);
    return doc;
  }

  private prune(): void {
    for (const [id, doc] of this.docs) {
      if (!this.isFresh(doc)) this.docs.delete(id);
    }
    const web = [...this.docs.values()].filter((doc) => doc.trust === "web");
    const overflow = this.docs.size - this.maxDocs;
    if (overflow <= 0) return;
    web.sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const doc of web.slice(0, overflow)) this.docs.delete(doc.id);
  }

  private async statSignature(): Promise<FileSignature | undefined> {
    const stat = await fs.stat(this.filePath).catch(() => undefined);
    return stat === undefined ? undefined : { mtimeMs: stat.mtimeMs, size: stat.size };
  }

  /** 读路径发现磁盘被其它进程改写（如另一个进程刚跑完 rag:ingest）时重新加载，否则沿用内存视图 */
  private async syncWithDisk(): Promise<void> {
    const sig = await this.statSignature();
    const changed =
      sig === undefined
        ? this.lastSig !== undefined // 文件被挪走/删除（例如坏文件被改名成 .corrupt）
        : this.lastSig === undefined || sig.mtimeMs !== this.lastSig.mtimeMs || sig.size !== this.lastSig.size;
    if (changed) await this.reload();
  }

  private async reload(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.docs = new Map();
      this.loaded = true;
      this.lastSig = undefined;
      this.revision++;
      return;
    }
    this.lastSig = await this.statSignature();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 坏文件挪到旁边而不是直接覆盖，方便人工恢复
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${this.now()}`).catch(() => undefined);
      parsed = { version: 2, docs: [] };
    }

    this.docs = new Map(
      this.parse(parsed)
        .filter((doc) => !this.deletedIds.has(doc.id))
        .map((doc) => [doc.id, doc])
    );
    this.loaded = true;
    this.revision++;
  }

  private parse(parsed: unknown): KnowledgeDoc[] {
    if (Array.isArray(parsed)) return this.migrateLegacy(parsed as LegacyEntry[]);
    const file = parsed as Partial<StoreFileV2> | null;
    return Array.isArray(file?.docs) ? file.docs : [];
  }

  /** 旧版是 {content, source, timestamp}[]，同一来源保留最新一条 */
  private migrateLegacy(entries: LegacyEntry[]): KnowledgeDoc[] {
    const latest = new Map<string, { content: string; source: string; timestamp: number }>();
    for (const entry of entries) {
      if (typeof entry.content !== "string" || typeof entry.source !== "string") continue;
      const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : 0;
      const key = normalizeSource(entry.source);
      const prev = latest.get(key);
      if (!prev || prev.timestamp <= timestamp) latest.set(key, { content: entry.content, source: entry.source, timestamp });
    }

    const docs: KnowledgeDoc[] = [];
    for (const [source, entry] of latest) {
      const content = normalizeText(entry.content);
      if (!content) continue;
      const id = sha1(source);
      docs.push({
        id,
        source,
        trust: "web",
        fetchedAt: entry.timestamp,
        contentHash: sha1(content),
        chunks: chunkText(content, this.options.chunk).map((text, i) => ({ id: `${id.slice(0, 12)}#${i}`, text })),
      });
    }
    return docs;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: StoreFileV2 = { version: 2, docs: [...this.docs.values()] };
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf-8");

    // Windows 上目标文件正被读取时 rename 可能短暂 EPERM/EBUSY，退避重试几次
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, this.filePath);
        // 记下自己刚写的内容签名，避免下一次读路径把自家写入误判成外部改动而重载
        this.lastSig = await this.statSignature();
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
          await fs.rm(tmp, { force: true });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
}
