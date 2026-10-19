// RAG PostgreSQL 后端集成测试：upsert/list 合并语义、TTL/容量淘汰、pruneInternal、跨实例可见性、
// revision 探测、向量缓存复用与内存层、JSON→PG 迁移、rag_search 端到端。
// 只在配置了 RAG_PG_URL（或 RAG_PG_TEST_URL）时运行，否则跳过；用独立 rag_test_* schema，结束即删。
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { EmbeddingClient } from "../src/rag/embeddings";
import { KnowledgeStore } from "../src/rag/knowledge_store";
import { PgKnowledgeStore, PgVectorCache, closePgPools } from "../src/rag/pg_store";
import { createRagSearchTool } from "../src/tools/rag_search";
import type { TavilyResponse, TavilySearchRequest } from "../src/tools/tavily_client";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

const url = process.env.RAG_PG_TEST_URL?.trim() || process.env.RAG_PG_URL?.trim();
const SCHEMA = `rag_test_${Date.now().toString(36)}`;
const ROOT = path.resolve(".sand-box/.tmp-rag-pg");

const SCAM_DOC =
  "冒充客服退款诈骗是常见的电信诈骗手法。骗子自称电商平台客服，以商品质量问题为由主动提出退款。随后诱导受害人下载会议软件开启屏幕共享，并把钱转到所谓的安全账户。";
const RULES_DOC = "平台退款流程规范：退款必须原路返回，客服不会要求开启屏幕共享，也不存在安全账户。";
const EN_SCAM_DOC = "Scammers posing as support agents promise quick refunds.";
const QUERY = "客服退款诈骗";

// —— 与 rag_vector.test.ts 相同的词袋假向量：主题命中同一维，余弦天然可判 ——
const TOPICS: string[][] = [
  ["退款", "refunds"],
  ["客服", "support"],
  ["诈骗", "scammers"],
  ["屏幕共享", "screen"],
  ["安全账户", "safe account"],
  ["平台", "规范"],
  ["红烧肉", "pork"],
  ["冰糖", "sugar"],
];

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector: number[] = TOPICS.map((words) => (words.some((word) => lower.includes(word)) ? 1 : 0));
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function makeFakeEmbeddings(): EmbeddingClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: "fake-embedding",
    calls,
    embed: async (inputs) => {
      calls.push([...inputs]);
      return inputs.map(fakeVector);
    },
  };
}

function fakeWeb(results: TavilyResponse["results"]) {
  const calls: TavilySearchRequest[] = [];
  return Object.assign(
    async (_request: TavilySearchRequest): Promise<TavilyResponse> => {
      calls.push(_request);
      return { results };
    },
    { calls }
  );
}

interface RagOutput {
  result_count: number;
  results: { source: string; relevance_score: number; coverage: number; similarity?: number }[];
}

async function testUpsertRoundtrip(): Promise<void> {
  const store = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  const saved = await store.upsert([
    { source: "https://ex.example/a?utm_source=x#frag", content: SCAM_DOC, trust: "web", title: "网页案例" },
    { source: "internal://docs/规则.md#客服退款诈骗", content: RULES_DOC, trust: "internal" },
  ]);
  check(saved.length === 2 && saved.every((doc) => doc.chunks.length > 0), "upsert 返回带块的文档", saved.length);

  const docs = await store.list();
  check(docs.length === 2, "list 读回全部文档", docs.map((d) => d.source));
  const web = docs.find((d) => d.source === "https://ex.example/a");
  check(web !== undefined && web.title === "网页案例" && web.trust === "web", "URL 归一化（utm/锚点/末尾斜杠）后入库", docs.map((d) => d.source));
  check(
    web !== undefined && web.chunks.every((c) => c.id.startsWith(web.id.slice(0, 12)) && c.text.length > 0),
    "块 id = doc id 前 12 位 + 序号，与 JSON 后端同一规则",
    web?.chunks.map((c) => c.id)
  );
  check(web !== undefined && store.isFresh(web), "新抓的 web 文档在 TTL 内是新鲜的");

  // 同一来源的不同写法归并为一条
  await store.upsert([{ source: "https://EX.example/a/", content: SCAM_DOC, trust: "web" }]);
  check((await store.list()).length === 2, "同源不同写法归并为同一文档", (await store.list()).map((d) => d.source));
}

async function testIdempotentUpsert(): Promise<void> {
  const store = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  const source = "https://idem.example/doc";
  const first = await store.upsert([{ source, content: SCAM_DOC, trust: "web" }]);
  const revision1 = store.revision;
  const second = await store.upsert([{ source, content: SCAM_DOC, trust: "web" }]);
  check(
    JSON.stringify(second[0]!.chunks.map((c) => c.id)) === JSON.stringify(first[0]!.chunks.map((c) => c.id)),
    "内容未变：块原样复用",
    { first: first[0]!.chunks.map((c) => c.id), second: second[0]!.chunks.map((c) => c.id) }
  );
  check(store.revision > revision1, "每次写入 revision 自增（供上层重建索引）", { revision1, revision2: store.revision });

  const third = await store.upsert([{ source, content: SCAM_DOC + "新增一段话。", trust: "web" }]);
  check(third[0]!.contentHash !== first[0]!.contentHash, "内容变化：contentHash 更新", third[0]!.contentHash);
}

/** internal 信任不被后续 web 覆盖；无 title 的写入保留旧 title */
async function testTrustAndTitleMerge(): Promise<void> {
  const store = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  await store.upsert([{ source: "https://trust.example/doc", content: SCAM_DOC, trust: "internal", title: "人工导入" }]);
  await store.upsert([{ source: "https://trust.example/doc", content: SCAM_DOC, trust: "web" }]);
  const doc = (await store.list()).find((d) => d.source === "https://trust.example/doc");
  check(doc?.trust === "internal" && doc.title === "人工导入", "internal 信任与人工 title 不被 web 覆盖", doc);

  await store.upsert([{ source: "https://title.example/doc", content: RULES_DOC, trust: "web", title: "原标题" }]);
  await store.upsert([{ source: "https://title.example/doc", content: RULES_DOC, trust: "web" }]);
  check((await store.list()).find((d) => d.source === "https://title.example/doc")?.title === "原标题", "title 缺省时保留旧值");
}

/** TTL 过期清 web 留 internal；超过 maxDocs 淘汰最旧 web */
async function testTtlAndMaxDocs(): Promise<void> {
  let nowMs = 1_000_000_000_000;
  const store = new PgKnowledgeStore({
    connectionString: url!,
    schema: SCHEMA,
    ttlMs: 1_000,
    maxDocs: 2,
    now: () => nowMs,
  });
  await store.upsert([
    { source: "https://ttl.example/old", content: RULES_DOC, trust: "web" },
    { source: "internal://docs/永久.md#节", content: SCAM_DOC, trust: "internal" },
  ]);
  nowMs += 2_000; // web 过期，internal 不受影响
  await store.upsert([{ source: "https://ttl.example/new", content: EN_SCAM_DOC, trust: "web" }]);
  let sources = (await store.list()).map((d) => d.source).sort();
  check(
    JSON.stringify(sources) === JSON.stringify(["https://ttl.example/new", "internal://docs/永久.md#节"]),
    "过 TTL 的 web 被清理，internal 永久保留",
    sources
  );

  await store.upsert([
    { source: "https://ttl.example/c", content: RULES_DOC, trust: "web" },
    { source: "https://ttl.example/d", content: RULES_DOC, trust: "web" },
  ]);
  sources = (await store.list()).map((d) => d.source).sort();
  check(
    (await store.list()).length === 2 && sources.includes("internal://docs/永久.md#节"),
    "超出 maxDocs 淘汰最旧 web（internal 不占淘汰名额）",
    sources
  );
}

async function testPruneInternal(): Promise<void> {
  const store = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  await store.upsert([
    { source: "internal://docs/f.md#甲", content: SCAM_DOC, trust: "internal" },
    { source: "internal://docs/f.md#乙", content: RULES_DOC, trust: "internal" },
    { source: "internal://docs/g.md#丙", content: RULES_DOC, trust: "internal" },
  ]);
  const keep = new Set([store.docId("internal://docs/f.md#甲"), store.docId("internal://docs/g.md#丙")]);
  const removed = await store.pruneInternal(["internal://docs/f.md"], keep);
  check(
    removed.length === 1 && removed[0]!.source === "internal://docs/f.md#乙" && removed[0]!.chunks.length > 0,
    "孤儿章节被删除且返回完整文档",
    removed.map((d) => d.source)
  );
  const sources = (await store.list()).map((d) => d.source).sort();
  check(
    JSON.stringify(sources) === JSON.stringify(["internal://docs/f.md#甲", "internal://docs/g.md#丙"]),
    "keepIds 保留、范围外前缀不误删",
    sources
  );
}

async function testCrossInstanceVisibility(): Promise<void> {
  const writer = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  const reader = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  await writer.upsert([{ source: "https://xinst.example/a", content: SCAM_DOC, trust: "web" }]);
  const docs = await reader.list();
  check(
    docs.some((d) => d.source === "https://xinst.example/a") && reader.revision >= 1,
    "另一实例立即读到写入，revision 从 meta 表读回",
    { sources: docs.map((d) => d.source), revision: reader.revision }
  );
}

/** getRevision 只查 meta 一条：跨实例探测写入；没变化时重复探测稳定（上层据此跳过全量 list） */
async function testGetRevisionProbe(): Promise<void> {
  const reader = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  const before = await reader.getRevision();
  const writer = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  await writer.upsert([{ source: "https://probe.example/a", content: SCAM_DOC, trust: "web" }]);
  const after = await reader.getRevision();
  check(after > before, "另一实例写入后 getRevision 探测到 revision 变化", { before, after });
  check((await reader.getRevision()) === after, "无写入时重复探测返回同一 revision");
}

async function testVectorCacheReuse(): Promise<void> {
  const embeddings = makeFakeEmbeddings();
  const cache = new PgVectorCache({ connectionString: url!, schema: SCHEMA, model: "fake-embedding" });
  const texts = ["退款诈骗 客服", "红烧肉冰糖"];
  const first = await cache.ensure(["客服退款被骗", ...texts], embeddings.embed);
  check(embeddings.calls.length === 1, "缺失向量一次批量补齐", embeddings.calls);
  check(first.get("客服退款被骗")!.length === TOPICS.length, "返回的向量可用");
  await cache.ensure(["客服退款被骗", ...texts], embeddings.embed);
  check(embeddings.calls.length === 1, "全部命中时零调用", embeddings.calls);

  const cache2 = new PgVectorCache({ connectionString: url!, schema: SCHEMA, model: "fake-embedding" });
  const embeddings2 = makeFakeEmbeddings();
  await cache2.ensure(["客服退款被骗", ...texts], embeddings2.embed);
  check(embeddings2.calls.length === 0, "另一实例复用盘上缓存", embeddings2.calls);
}

/** 内存层兜底：向量进内存后，即使 PG 里的行被删（手工修数/清理）同一实例仍命中，不再过网络 */
async function testVectorMemoryLayer(): Promise<void> {
  const embeddings = makeFakeEmbeddings();
  const cache = new PgVectorCache({ connectionString: url!, schema: SCHEMA, model: "fake-embedding" });
  const texts = ["退款诈骗 客服"];
  await cache.ensure(texts, embeddings.embed);
  const callsAfterFirst = embeddings.calls.length;

  const cleaner = new Pool({ connectionString: url!, max: 1 });
  await cleaner.query(`DELETE FROM ${SCHEMA}.vectors`);
  await cleaner.end().catch(() => undefined);

  const again = await cache.ensure(texts, embeddings.embed);
  check(
    embeddings.calls.length === callsAfterFirst,
    "PG 行被删后内存层仍然命中，零 embedding 调用",
    { callsAfterFirst, after: embeddings.calls.length }
  );
  check(again.get(texts[0]!)!.length === TOPICS.length, "内存层返回的向量可用");
}

/** JSON → PG 原样搬运：id / contentHash / chunk id 全保留，fingerprint 不漂移 */
async function testImportDocsFromJson(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  const jsonStore = new KnowledgeStore({ filePath: path.join(ROOT, "knowledge.json") });
  await jsonStore.upsert([{ source: "internal://docs/迁移.md#节", content: SCAM_DOC, trust: "internal", title: "迁移节" }]);
  const docs = await jsonStore.list();

  const pgStore = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  const imported = await pgStore.importDocs(docs);
  check(imported === 1, "importDocs 迁移计数", imported);
  const migrated = (await pgStore.list()).find((d) => d.source === docs[0]!.source);
  check(
    migrated !== undefined &&
      migrated.id === docs[0]!.id &&
      migrated.contentHash === docs[0]!.contentHash &&
      JSON.stringify(migrated.chunks) === JSON.stringify(docs[0]!.chunks),
    "文档/块原样搬运，id 与指纹不漂移",
    { json: docs[0], pg: migrated }
  );
  check(pgStore.fingerprint(SCAM_DOC) === docs[0]!.contentHash, "迁移后 fingerprint 公式与 JSON 后端一致");
  await pgStore.importDocs(docs);
  check((await pgStore.list()).length === 1, "重复执行迁移幂等");
}

/** rag_search 全链路：注入 PG store + PG 向量缓存，语义通道在 PG 上正常召回 */
async function testRagSearchEndToEnd(): Promise<void> {
  const store = new PgKnowledgeStore({ connectionString: url!, schema: SCHEMA });
  await store.upsert([{ source: "https://pg.example/en", content: EN_SCAM_DOC, trust: "web" }]);
  const embeddings = makeFakeEmbeddings();
  const vectorCache = new PgVectorCache({ connectionString: url!, schema: SCHEMA, model: "fake-embedding" });
  const tool = createRagSearchTool({ store, vectorCache, webSearch: fakeWeb([]), embeddings });
  const out = (await tool.execute({ query: QUERY, top_k: 1 })) as RagOutput;
  check(
    out.result_count === 1 && out.results[0]!.source === "https://pg.example/en" && out.results[0]!.similarity === 1,
    "PG 后端上词法零命中时语义通道召回",
    out.results
  );
}

/** 用例间清空共享 schema：各用例的断言都假设库里只有自己写入的文档，不隔离会互相污染 */
async function resetTables(): Promise<void> {
  const pool = new Pool({ connectionString: url!, max: 1 });
  try {
    const exists = await pool.query(`SELECT to_regclass('${SCHEMA}.docs') IS NOT NULL AS ok`);
    if (!exists.rows[0]!.ok) return; // 首个用例前表还不存在，由 ensureSchema 创建
    await pool.query(`TRUNCATE ${SCHEMA}.docs, ${SCHEMA}.chunks, ${SCHEMA}.vectors, ${SCHEMA}.meta CASCADE`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!url) {
    console.log("⏭️  未配置 RAG_PG_URL / RAG_PG_TEST_URL，跳过 PostgreSQL 集成测试（JSON 后端测试见其它 rag_* 文件）");
    return;
  }
  const probe = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 4_000 });
  try {
    await probe.query("SELECT 1");
  } catch (error) {
    console.log(`⏭️  连不上 PostgreSQL（${error instanceof Error ? error.message : String(error)}），跳过 PG 集成测试`);
    return;
  } finally {
    await probe.end().catch(() => undefined);
  }

  const tests = [
    testUpsertRoundtrip,
    testIdempotentUpsert,
    testTrustAndTitleMerge,
    testTtlAndMaxDocs,
    testPruneInternal,
    testCrossInstanceVisibility,
    testGetRevisionProbe,
    testVectorCacheReuse,
    testVectorMemoryLayer,
    testImportDocsFromJson,
    testRagSearchEndToEnd,
  ];
  try {
    for (const test of tests) {
      await resetTables();
      await test();
    }
  } finally {
    const cleanup = new Pool({ connectionString: url, max: 1 });
    await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await cleanup.end().catch(() => undefined);
    await closePgPools();
    await fs.rm(ROOT, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
    if (failures > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("TEST CRASHED:", error);
    process.exitCode = 1;
  });
