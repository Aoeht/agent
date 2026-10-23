// src/rag/bench_index.ts
/**
 * 向量索引吞吐基准：冷启动补嵌 → 热缓存 → 批量大小敏感性 → BM25 重建 → 端到端检索。
 *
 *   bun run rag:bench
 *
 * 会真实调用嵌入服务（把语料里还没向量的分片补齐，这部分检索迟早要付，不是白烧）；
 * 批量敏感性用合成文本并当场删掉产生的向量。端到端那步显式禁网，不碰 Tavily 额度。
 *
 * 结论口径：瓶颈在服务商嵌入接口的往返次数（实测占 96%），PG 写入与应用层是个位数百分比。
 * 所以提吞吐只有两条路——把 EMBEDDING_BATCH 顶到服务商上限，以及让补嵌的 64 片一批并发发出。
 */
import OpenAI from "openai";
import { performance } from "node:perf_hooks";
import { createKnowledgeStore, pgSchemaFromEnv } from "./store_factory";
import { PgVectorCache, closePgPools, getPool } from "./pg_store";
import { vectorKey } from "./vector_store";
import { Bm25Index } from "./bm25";
import { createEmbeddingClientFromEnv } from "./embeddings";
import { createRagSearchTool } from "../tools/rag_search";

const connectionString = process.env.RAG_PG_URL?.trim();
if (!connectionString) throw new Error("RAG_PG_URL 未配置：基准只针对 PostgreSQL 后端");
const schema = pgSchemaFromEnv();
const embeddings = createEmbeddingClientFromEnv();
if (!embeddings) throw new Error("EMBEDDING_MODEL 未配置，语义通道是关的");
const model = embeddings.model;
const dimensions = process.env.EMBEDDING_DIMENSIONS?.trim() ? Number(process.env.EMBEDDING_DIMENSIONS) : undefined;
const DEFAULT_BATCH = Number(process.env.EMBEDDING_BATCH?.trim() ?? 20);
const pool = getPool(connectionString);

// 基准要记录每一次请求的延迟与 token 用量，所以直接持有底层客户端，按批自行切分
const raw = new OpenAI({
  baseURL: process.env.EMBEDDING_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim(),
  apiKey: process.env.EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim(),
  maxRetries: 1,
  timeout: 90_000,
});

interface Sample {
  texts: number;
  chars: number;
  ms: number;
  tokens: number;
}
let samples: Sample[] = [];

async function embed(texts: string[], batchSize: number): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize).map((text) => text.slice(0, 6_000));
    const start = performance.now();
    const response = await raw.embeddings.create({
      model,
      input: slice,
      ...(dimensions !== undefined ? { dimensions } : {}),
    });
    samples.push({
      texts: slice.length,
      chars: slice.reduce((n, text) => n + text.length, 0),
      ms: performance.now() - start,
      tokens: (response.usage?.total_tokens ?? 0) as number,
    });
    for (const item of response.data) out.push(item.embedding as number[]);
  }
  return out;
}

function stats(list: Sample[]): string {
  if (list.length === 0) return "无请求";
  const ms = list.map((s) => s.ms).sort((a, b) => a - b);
  const at = (q: number): number => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] ?? 0;
  const tokens = list.reduce((n, s) => n + s.tokens, 0);
  const chars = list.reduce((n, s) => n + s.chars, 0);
  return `${list.length} 请求｜单请求 p50 ${at(0.5).toFixed(0)}ms p95 ${at(0.95).toFixed(0)}ms 最慢 ${ms[ms.length - 1]?.toFixed(0)}ms`
    + `｜平均批 ${Math.round(chars / list.length)} 字｜usage tokens ${tokens.toLocaleString()}`
    + (tokens > 0 ? `｜字/token ≈ ${(chars / tokens).toFixed(2)}` : "");
}

const store = createKnowledgeStore();
const docs = await store.list();
const chunks = docs.flatMap((doc) => doc.chunks);
const texts = chunks.map((chunk) => chunk.text);
const countRows = async (): Promise<number> =>
  Number((await pool.query<{ n: string }>(`SELECT count(*)::text n FROM ${schema}.vectors`)).rows[0]?.n ?? 0);
const rowsBefore = await countRows();

console.log(`模型 ${model}｜维度 ${dimensions ?? "服务商默认"}｜默认批 ${DEFAULT_BATCH}`);
console.log(`语料 ${docs.length} 文档 / ${chunks.length} 分片 / ${texts.reduce((n, t) => n + t.length, 0).toLocaleString()} 字｜向量表已有 ${rowsBefore} 行\n`);

// A 冷启动：补齐语料里所有还没有向量的分片（真实索引路径，含 PG 写入）
samples = [];
const cache = new PgVectorCache({ connectionString, schema, model });
const coldStart = performance.now();
await cache.ensure(texts, (batch) => embed(batch, DEFAULT_BATCH));
const coldMs = performance.now() - coldStart;
const coldEmbedMs = samples.reduce((n, s) => n + s.ms, 0);
const coldChunks = (await countRows()) - rowsBefore;
console.log("【A 冷启动全量补嵌】");
console.log(`  新增向量 ${coldChunks} 片，用时 ${(coldMs / 1000).toFixed(1)}s → ${(coldChunks / (coldMs / 1000)).toFixed(1)} 片/秒`);
console.log(`  其中 API ${((coldEmbedMs / coldMs) * 100).toFixed(0)}%，应用层+PG 写入 ${((coldMs - coldEmbedMs) / 1000).toFixed(1)}s`);
console.log(`  ${stats(samples)}`);
const perChunk = coldMs / Math.max(1, coldChunks);
console.log(`  外推：1 万片 ≈ ${(perChunk * 10_000 / 60_000).toFixed(1)} 分钟，10 万片 ≈ ${(perChunk * 100_000 / 3_600_000).toFixed(1)} 小时\n`);

// B 同进程热缓存：内存层命中，应当零请求
samples = [];
const warmStart = performance.now();
await cache.ensure(texts, (batch) => embed(batch, DEFAULT_BATCH));
console.log(`【B 同进程热缓存】${(performance.now() - warmStart).toFixed(1)}ms 处理 ${chunks.length} 片，请求 ${samples.length} 次`);

// B2 冷进程等价：新建空内存层，只靠 PG 命中（0 请求 = 库里全有）
samples = [];
const pgStart = performance.now();
await new PgVectorCache({ connectionString, schema, model }).ensure(texts, (batch) => embed(batch, DEFAULT_BATCH));
console.log(`【B2 冷进程/纯 PG 命中】${(performance.now() - pgStart).toFixed(0)}ms，请求 ${samples.length} 次\n`);

// C 批量大小敏感性：合成文本，测完把这些 key 删掉，不污染缓存
console.log("【C 批量大小敏感性】每档 100 段合成文本（约 240 字/段）");
const synth = Array.from({ length: 100 }, (_, i) => `反诈基准样本 ${i}-${Math.random().toString(36).slice(2, 12)} 冒充客服退款刷单投资诈骗 判决案例`);
const keys = synth.map((text) => vectorKey(model, text.slice(0, 6_000)));
for (const size of [5, 10, 20, 25, 40]) {
  samples = [];
  const start = performance.now();
  try {
    await embed(synth, size);
  } catch (error) {
    console.log(`  批 ${String(size).padStart(2)}：被服务商拒绝 —— ${error instanceof Error ? error.message.slice(0, 72) : String(error)}`);
    continue;
  }
  const ms = performance.now() - start;
  console.log(`  批 ${String(size).padStart(2)}：${samples.length} 请求 ${(ms / 1000).toFixed(1)}s → ${(100 / (ms / 1000)).toFixed(1)} 片/秒｜${stats(samples)}`);
}
await pool.query(`DELETE FROM ${schema}.vectors WHERE key = ANY($1::text[])`, [keys]);
console.log();

// D 词法索引重建（应用层，零调用）
const bmStart = performance.now();
const index = new Bm25Index(chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })));
const bmMs = performance.now() - bmStart;
const queryStart = performance.now();
index.search("刷单 返利 押金 验证码", { limit: 10 });
console.log(`【D BM25 重建】${chunks.length} 片 ${bmMs.toFixed(0)}ms；单次词法查询 ${(performance.now() - queryStart).toFixed(2)}ms\n`);

// E 端到端一次真实检索（禁网：基准不碰 Tavily 额度）
const tool = createRagSearchTool({
  store,
  embeddings,
  vectorCache: new PgVectorCache({ connectionString, schema, model }),
  webSearch: async () => {
    throw new Error("bench 不允许联网");
  },
});
const searchStart = performance.now();
const result = (await tool.execute({ query: "冒充电商客服退款 验证码 诈骗 案例", top_k: 5 })) as {
  results?: { source?: string; title?: string }[];
};
console.log(`【E 端到端检索】${(performance.now() - searchStart).toFixed(0)}ms（含一次查询向量嵌入）`);
for (const item of result.results ?? []) console.log(`   ${String(item.source).slice(0, 88)} | ${String(item.title ?? "").slice(0, 24)}`);
const bytes = (await pool.query<{ b: string }>(`SELECT pg_total_relation_size('${schema}.vectors')::text b`)).rows[0]?.b ?? "0";
console.log(`\n向量表：${await countRows()} 行，${(Number(bytes) / 1048576).toFixed(1)} MB`);
await closePgPools();
process.exit(0);
