// RAG 语义（向量）通道：跨语言召回、RRF 融合排序、向量缓存复用、embedding 失败降级与冷却恢复、环境变量开关。
// 运行：bun run tests/rag_vector.test.ts
// .env 若配了 EMBEDDING_MODEL/RAG_PG_URL，bun 会自动加载；本文件各用例显式注入 embeddings/store 或 cacheDir，
// 但默认装配仍会读 env —— 测试必须密闭（PG 路径由 rag_pg.test.ts 用一次性 schema 专门测，不能让默认装配写真实库）
delete process.env.EMBEDDING_MODEL;
delete process.env.RAG_PG_URL;
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingClient } from "../src/rag/embeddings";
import { createEmbeddingClientFromEnv } from "../src/rag/embeddings";
import { KnowledgeStore } from "../src/rag/knowledge_store";
import { VectorCache, cosineTopK } from "../src/rag/vector_store";
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

const ROOT = path.resolve(".sand-box/.tmp-rag-vector");
const dirFor = (name: string) => path.join(ROOT, name);
const exists = (file: string) => fs.access(file).then(() => true, () => false);

// —— 假向量：每个主题占一维，中英文同义词落在同一维，主题相同的文本余弦自然高 ——
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

type CountingEmbeddings = EmbeddingClient & { calls: string[][] };

function makeFakeEmbeddings(): CountingEmbeddings {
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

function makeFailingEmbeddings(): CountingEmbeddings {
  const calls: string[][] = [];
  return {
    model: "fake-embedding",
    calls,
    embed: async (inputs) => {
      calls.push([...inputs]);
      throw new Error("embedding 服务不可用");
    },
  };
}

const SCAM_DOC =
  "冒充客服退款诈骗是常见的电信诈骗手法。骗子自称电商平台客服，以商品质量问题为由主动提出退款。随后诱导受害人下载会议软件开启屏幕共享，并把钱转到所谓的安全账户。";
const RULES_DOC = "平台退款流程规范：退款必须原路返回，客服不会要求开启屏幕共享，也不存在安全账户。";
const COOKING_DOC = "红烧肉的做法：五花肉切块焯水，加入冰糖炒出糖色，再放生抽老抽和八角小火慢炖一小时。";
const EN_SCAM_DOC = "Scammers posing as support agents promise quick refunds.";
const QUERY = "客服退款诈骗";

interface RagOutput {
  result_count: number;
  vector_search_error?: string;
  results: {
    source: string;
    trust: string;
    origin: string;
    chunk_id: string;
    relevance_score: number;
    coverage: number;
    similarity?: number;
  }[];
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

async function seedStore(dir: string, docs: { source: string; content: string }[]): Promise<void> {
  const store = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  await store.upsert(docs.map((doc) => ({ ...doc, trust: "web" as const })));
}

function testCosineTopK(): void {
  const items = new Map<string, number[]>([
    ["a", fakeVector("退款诈骗 客服")],
    ["b", fakeVector("红烧肉 冰糖")],
    ["c", fakeVector("Scammers support refunds")],
    ["zero", new Array(TOPICS.length).fill(0)],
  ]);
  const query = fakeVector("客服退款诈骗");
  const hits = cosineTopK(query, items, 2, 0.3);
  check(hits.length === 2, "topK 截断生效", hits);
  check(hits[0]!.id === "a" && hits[1]!.id === "c", "按相似度降序，同分按 id 定序", hits);
  check(Math.abs(hits[0]!.similarity - 1) < 1e-9, "同主题向量余弦为 1", hits[0]);
  const all = cosineTopK(query, items, 10, 0);
  check(!all.some((hit) => hit.id === "zero" || hit.id === "b"), "零向量与零相似度被过滤", all);
}

async function testVectorCache(): Promise<void> {
  const dir = dirFor("cache-unit");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "vectors.json");
  const seen: string[][] = [];
  const embed = async (batch: string[]) => {
    seen.push([...batch]);
    return batch.map(fakeVector);
  };
  const texts = ["退款诈骗 客服", "红烧肉冰糖", "平台规范"];

  const first = new VectorCache({ filePath: file, model: "m1" });
  await first.ensure(["客服退款被骗", ...texts], embed);
  check(seen.length === 1 && seen[0]!.length === 4, "缺失向量一次批量补齐", seen);
  await first.ensure(["客服退款被骗", ...texts], embed);
  check(seen.length === 1, "全部命中缓存时零调用", seen);

  const second = new VectorCache({ filePath: file, model: "m1" });
  const warmed = await second.ensure(["客服退款被骗", ...texts], embed);
  check(seen.length === 1, "新实例从盘上加载缓存，零调用", seen);
  check(warmed.get("红烧肉冰糖")!.length === TOPICS.length, "加载后的向量可用", warmed);

  const withNew = await second.ensure(["红烧肉怎么炖", ...texts], embed);
  check(seen.length === 2 && JSON.stringify(seen[1]) === JSON.stringify(["红烧肉怎么炖"]), "语料已缓存时新查询只补查询本身", seen);
  check(withNew.has("红烧肉怎么炖"), "补齐的查询拿到向量");

  const other = new VectorCache({ filePath: file, model: "m2" });
  await other.ensure(["平台规范解读", ...texts], embed);
  check(seen.length === 3 && seen[2]!.length === 4, "换模型后缓存全量失效重算", seen);

  const tinyFile = path.join(dir, "tiny-vectors.json");
  const tiny = new VectorCache({ filePath: tinyFile, model: "m1", maxEntries: 2 });
  await tiny.ensure(texts, embed);
  const tinyReloaded = new VectorCache({ filePath: tinyFile, model: "m1" });
  await tinyReloaded.ensure(["退款诈骗 客服", "红烧肉冰糖"], embed);
  check(
    seen[seen.length - 1]!.length === 1 && seen[seen.length - 1]![0] === "退款诈骗 客服",
    "超出 maxEntries 时最早写入的条目被淘汰，其余仍在盘上",
    seen[seen.length - 1]
  );
}

/** 词法零命中的英文文档被语义通道捞回来，且不再触发联网兜底 */
async function testSemanticRescue(): Promise<void> {
  const dir = dirFor("rescue");
  await seedStore(dir, [{ source: "https://en.example/scam", content: EN_SCAM_DOC }]);
  const web = fakeWeb([]);
  const out = (await createRagSearchTool({ cacheDir: dir, webSearch: web, embeddings: makeFakeEmbeddings() }).execute({
    query: QUERY,
    top_k: 1,
  })) as RagOutput;
  check(out.result_count === 1 && out.results[0]!.source === "https://en.example/scam", "词法零命中时语义通道召回英文文档", out.results);
  check(
    out.results[0]!.similarity === 1 && out.results[0]!.relevance_score === 0,
    "纯语义命中：similarity=1、BM25 分为 0",
    out.results[0]
  );
  check(web.calls.length === 0, "语义结果已满足 top_k，不再联网兜底", web.calls.length);
}

/** 双通道都命中的排前，纯语义候选拿到剩余名额，词法独占的弱相关被挤出 */
async function testHybridFusion(): Promise<void> {
  const docs = [
    { source: "https://fusion.example/scam", content: SCAM_DOC },
    { source: "https://fusion.example/rules", content: RULES_DOC },
    { source: "https://fusion.example/cook", content: COOKING_DOC },
    { source: "https://fusion.example/en", content: EN_SCAM_DOC },
  ];
  const hybridDir = dirFor("fusion");
  await seedStore(hybridDir, docs);
  const hybrid = (await createRagSearchTool({
    cacheDir: hybridDir,
    webSearch: fakeWeb([]),
    embeddings: makeFakeEmbeddings(),
  }).execute({ query: QUERY, top_k: 3 })) as RagOutput;
  const sources = hybrid.results.map((r) => r.source);
  check(
    JSON.stringify(sources) ===
      JSON.stringify(["https://fusion.example/scam", "https://fusion.example/rules", "https://fusion.example/en"]),
    "RRF 融合：双通道候选 > 纯语义候选，英文文档进 top3",
    sources
  );
  const en = hybrid.results.find((r) => r.source === "https://fusion.example/en")!;
  check(en.relevance_score === 0 && en.coverage === 0 && en.similarity === 1, "纯语义候选带 similarity，词法字段为 0", en);
  const scam = hybrid.results.find((r) => r.source === "https://fusion.example/scam")!;
  check(scam.relevance_score > 0 && scam.similarity !== undefined, "双通道候选同时带 BM25 分与 similarity", scam);
  check(!hybrid.results.some((r) => r.source === "https://fusion.example/cook"), "双通道都零命中的文档不占名额", sources);

  const lexicalDir = dirFor("fusion-lexical");
  await seedStore(lexicalDir, docs);
  const lexicalOnly = (await createRagSearchTool({
    cacheDir: lexicalDir,
    webSearch: fakeWeb([]),
    embeddings: null,
  }).execute({ query: QUERY, top_k: 3 })) as RagOutput;
  check(
    !lexicalOnly.results.some((r) => r.source === "https://fusion.example/en"),
    "embeddings=null 强制纯词法：语义-only 候选消失",
    lexicalOnly.results.map((r) => r.source)
  );
  check(lexicalOnly.results.every((r) => r.similarity === undefined), "纯词法结果不带 similarity 字段", lexicalOnly.results);
  check(!(await exists(path.join(lexicalDir, "vectors.json"))), "embeddings=null 不写向量缓存", lexicalDir);
}

/** embedding 失败：词法结果照常返回并透出原因；熔断后不再重复尝试 */
async function testEmbeddingFailureDegradation(): Promise<void> {
  const dir = dirFor("degrade");
  await seedStore(dir, [{ source: "https://degrade.example/scam", content: SCAM_DOC }]);
  const embeddings = makeFailingEmbeddings();
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), embeddings });
  const first = (await tool.execute({ query: QUERY, top_k: 1 })) as RagOutput;
  check(first.results[0]!.source === "https://degrade.example/scam", "embedding 失败时词法结果照常返回", first.results);
  check(first.vector_search_error === "embedding 服务不可用", "失败原因透出为 vector_search_error", first.vector_search_error);
  const attempts = embeddings.calls.length;
  await tool.execute({ query: QUERY, top_k: 1 });
  check(embeddings.calls.length === attempts, "熔断后本进程内不再重试 embedding", { attempts, after: embeddings.calls.length });
  const third = (await tool.execute({ query: QUERY, top_k: 1 })) as RagOutput;
  check(third.vector_search_error === undefined, "熔断期间的后续调用不再带错误字段", third.vector_search_error);
}

/** 熔断有冷却期：失败后退回纯词法，冷却期内不重试，期满自动重试并恢复语义通道 */
async function testCircuitBreakerCooldownRecovery(): Promise<void> {
  const dir = dirFor("cooldown");
  await seedStore(dir, [{ source: "https://cooldown.example/en", content: EN_SCAM_DOC }]);
  let fail = true;
  let clock = 1_000_000_000_000;
  const calls: string[][] = [];
  const embeddings: EmbeddingClient = {
    model: "fake-embedding",
    embed: async (inputs) => {
      calls.push([...inputs]);
      if (fail) throw new Error("embedding 服务不可用");
      return inputs.map(fakeVector);
    },
  };
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), embeddings, now: () => clock });

  const first = (await tool.execute({ query: QUERY, top_k: 1 })) as RagOutput;
  check(first.vector_search_error === "embedding 服务不可用", "失败时透出 vector_search_error", first.vector_search_error);

  fail = false;
  const callsAfterFailure = calls.length;
  const second = (await tool.execute({ query: QUERY, top_k: 1 })) as RagOutput;
  check(calls.length === callsAfterFailure, "冷却期内不重试 embedding", { callsAfterFailure, after: calls.length });
  check(second.vector_search_error === undefined && second.result_count === 0, "冷却期内退回纯词法（英文文档捞不回来）", second);

  clock += 61_000;
  const third = (await tool.execute({ query: QUERY, top_k: 1 })) as RagOutput;
  check(
    third.result_count === 1 && third.results[0]!.source === "https://cooldown.example/en" && third.results[0]!.similarity === 1,
    "冷却期满自动重试，语义通道恢复召回",
    third.results
  );
  check(third.vector_search_error === undefined, "恢复后不再带错误字段", third.vector_search_error);
}

/** 向量缓存跨实例/跨查询复用：冷启动批量向量化一次，之后只补增量 */
async function testVectorCacheReuse(): Promise<void> {
  const dir = dirFor("reuse");
  await seedStore(dir, [
    { source: "https://reuse.example/scam", content: SCAM_DOC },
    { source: "https://reuse.example/cook", content: COOKING_DOC },
  ]);
  const embeddingsA = makeFakeEmbeddings();
  const toolA = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), embeddings: embeddingsA });
  await toolA.execute({ query: QUERY, top_k: 1 });
  check(embeddingsA.calls.length === 1, "冷启动一次批量向量化查询+全部块", embeddingsA.calls);
  await toolA.execute({ query: QUERY, top_k: 1 });
  check(embeddingsA.calls.length === 1, "同查询重复检索零新增调用", embeddingsA.calls);

  const embeddingsB = makeFakeEmbeddings();
  const toolB = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), embeddings: embeddingsB });
  await toolB.execute({ query: QUERY, top_k: 1 });
  check(embeddingsB.calls.length === 0, "新实例复用盘上向量缓存，零调用", embeddingsB.calls);
  await toolB.execute({ query: "红烧肉怎么做", top_k: 1 });
  check(
    embeddingsB.calls.length === 1 && JSON.stringify(embeddingsB.calls[0]) === JSON.stringify(["红烧肉怎么做"]),
    "语料已缓存时新查询只补查询本身",
    embeddingsB.calls
  );
  check(await exists(path.join(dir, "vectors.json")), "向量缓存落盘到 cacheDir", dir);
}

async function testUseCacheFalseSkipsSemantic(): Promise<void> {
  const dir = dirFor("no-cache");
  await seedStore(dir, [{ source: "https://nc.example/scam", content: SCAM_DOC }]);
  const embeddings = makeFakeEmbeddings();
  const web = fakeWeb([{ title: "web", url: "https://nc.example/web", content: EN_SCAM_DOC, score: 0.5 }]);
  const out = (await createRagSearchTool({ cacheDir: dir, webSearch: web, embeddings }).execute({
    query: QUERY,
    top_k: 1,
    use_cache: false,
  })) as RagOutput;
  check(embeddings.calls.length === 0, "use_cache=false 跳过语义通道，零 embedding 调用", embeddings.calls);
  check(out.results[0]!.origin === "web", "结果来自联网补充", out.results);
}

const ENV_KEYS = [
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_DIMENSIONS",
  "RAG_PG_URL",
  "RAG_PG_SCHEMA",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
] as const;

function pickEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function deleteEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** 环境变量是默认装配路径：没配 = 纯 BM25；配了 = 默认启用，向量服务指向本地 stub 全链路验证 */
async function testEnvWiring(): Promise<void> {
  const saved = pickEnv();
  try {
    deleteEnv();
    const offDir = dirFor("env-off");
    await seedStore(offDir, [{ source: "https://env.example/scam", content: SCAM_DOC }]);
    await createRagSearchTool({ cacheDir: offDir, webSearch: fakeWeb([]) }).execute({ query: QUERY, top_k: 1 });
    check(!(await exists(path.join(offDir, "vectors.json"))), "未配 EMBEDDING_MODEL 时不启用语义通道、不写向量文件", offDir);

    const onDir = dirFor("env-on");
    await seedStore(onDir, [{ source: "https://env2.example/en", content: EN_SCAM_DOC }]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { input: string | string[]; model: string };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
          object: "list",
          model: body.model,
          data: inputs.map((text, index) => ({ object: "embedding", index, embedding: fakeVector(text) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });
    process.env.EMBEDDING_MODEL = "stub-embedding";
    process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    process.env.EMBEDDING_API_KEY = "stub-key";
    try {
      const out = (await createRagSearchTool({ cacheDir: onDir, webSearch: fakeWeb([]) }).execute({
        query: QUERY,
        top_k: 1,
      })) as RagOutput;
      check(
        out.results[0]?.source === "https://env2.example/en" && out.results[0]?.similarity === 1,
        "配了 EMBEDDING_MODEL 后默认走环境构造的客户端（本地 stub 全链路）",
        out.results
      );
      check(await exists(path.join(onDir, "vectors.json")), "向量缓存写到 cacheDir", onDir);
    } finally {
      server.stop(true);
    }

    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_API_KEY;
    let threw: unknown;
    try {
      createEmbeddingClientFromEnv();
    } catch (error) {
      threw = error;
    }
    check(threw instanceof Error && threw.message.includes("EMBEDDING_BASE_URL"), "缺向量服务配置时创建即报错并指明缺什么", threw);
  } finally {
    restoreEnv(saved);
  }
}

async function main(): Promise<void> {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  try {
    testCosineTopK();
    await testVectorCache();
    await testSemanticRescue();
    await testHybridFusion();
    await testEmbeddingFailureDegradation();
    await testCircuitBreakerCooldownRecovery();
    await testVectorCacheReuse();
    await testUseCacheFalseSkipsSemantic();
    await testEnvWiring();
  } finally {
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
