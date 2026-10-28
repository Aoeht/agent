// 检索 trace：JSONL 落盘形状、开关解析、成功/抛错两路记录、写失败不拖垮检索。
// 运行：bun run tests/rag_trace.test.ts
// 测试必须密闭：不走真实 embedding / PG / 重排 / 改写 / 联网服务
delete process.env.EMBEDDING_MODEL;
delete process.env.RAG_PG_URL;
delete process.env.RERANK_MODEL;
delete process.env.AGENT_RAG_REWRITE;
import fs from "node:fs/promises";
import path from "node:path";
import { KnowledgeStore } from "../src/rag/knowledge_store";
import { FileRagTraceSink, resolveRagTraceSinkFromEnv, type RagTraceEvent } from "../src/rag/trace";
import { createRagSearchTool } from "../src/tools/rag_search";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

const ROOT = path.resolve(".sand-box/.tmp-rag-trace");
const dirFor = (name: string) => path.join(ROOT, name);

const DOCS = [
  {
    source: "trace://冒充客服退款诈骗",
    title: "冒充客服退款诈骗",
    content:
      "骗子自称电商平台客服，谎称商品有问题可以退款理赔，诱导开启屏幕共享，偷看验证码，把钱转到安全账户。退款应原路返回，官方客服不会索要验证码。",
  },
  {
    source: "trace://刷单返利诈骗",
    title: "刷单返利诈骗",
    content: "刷单返利诈骗先给小额返利骗取信任，再要求垫资做大额连单，以任务超时为由拒绝返款。所有垫资刷单都是诈骗。",
  },
];

async function seedStore(dir: string): Promise<KnowledgeStore> {
  const store = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  await store.upsert(DOCS.map((d) => ({ ...d, trust: "internal" as const })));
  return store;
}

const failingWeb = async () => {
  throw new Error("tavily 不可用");
};

async function readEvents(file: string): Promise<RagTraceEvent[]> {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RagTraceEvent);
  } catch {
    return [];
  }
}

async function testSinkShape() {
  const dir = dirFor("sink");
  let clock = 1_700_000_000_000;
  const sink = new FileRagTraceSink(dir, () => clock);
  sink.record({
    query: "退款",
    top_k: 3,
    use_cache: true,
    latency_ms: 12.3,
    stages_ms: { index: 1, lexical: 2 },
    counts: { lexical: 2, semantic: 0, pool: 2, web_fetched: 0, results: 2 },
    results: [{ chunk_id: "abc#0", source: "trace://冒充客服退款诈骗", trust: "internal", origin: "cache", relevance_score: 1.2 }],
  });
  const events = await readEvents(path.join(dir, "rag-search.jsonl"));
  check(events.length === 1, "每次 record 追加一行 JSONL");
  check(events[0]?.ts === new Date(1_700_000_000_000).toISOString(), "ts 由注入时钟生成");
  check(events[0]?.results[0]?.chunk_id === "abc#0", "结果元信息原样落盘");
  clock += 5;
  sink.record({
    query: "刷单",
    top_k: 3,
    use_cache: true,
    latency_ms: 1,
    stages_ms: {},
    counts: { lexical: 0, semantic: 0, pool: 0, web_fetched: 0, results: 0 },
    results: [],
  });
  const events2 = await readEvents(path.join(dir, "rag-search.jsonl"));
  check(events2.length === 2, "同一文件继续追加");
}

async function testEnvFactory() {
  const savedTrace = process.env.RAG_TRACE;
  const savedDir = process.env.RAG_TRACE_DIR;
  try {
    delete process.env.RAG_TRACE;
    delete process.env.RAG_TRACE_DIR;
    const sink = resolveRagTraceSinkFromEnv(process.env);
    check(sink instanceof FileRagTraceSink, "缺省构造 FileRagTraceSink");
    process.env.RAG_TRACE = "0";
    check(resolveRagTraceSinkFromEnv(process.env) === undefined, "RAG_TRACE=0 时不构造");
    process.env.RAG_TRACE = "1";
    process.env.RAG_TRACE_DIR = path.join(ROOT, "custom-dir");
    const custom = resolveRagTraceSinkFromEnv(process.env);
    check(custom instanceof FileRagTraceSink && (custom as FileRagTraceSink).filePath.includes("custom-dir"), "RAG_TRACE_DIR 覆盖目录");
  } finally {
    if (savedTrace === undefined) delete process.env.RAG_TRACE;
    else process.env.RAG_TRACE = savedTrace;
    if (savedDir === undefined) delete process.env.RAG_TRACE_DIR;
    else process.env.RAG_TRACE_DIR = savedDir;
  }
}

async function testSuccessPathTrace() {
  const dir = dirFor("success");
  const store = await seedStore(dir);
  const traceFile = path.join(dir, "traces", "rag-search.jsonl");
  const tool = createRagSearchTool({
    store,
    traceSink: new FileRagTraceSink(path.join(dir, "traces")),
    webSearch: failingWeb,
  });
  // top_k 压到 2 且查询同时命中两篇语料：本地填满 top_k，不触发联网，验证纯净成功路径
  const output = (await tool.execute({ query: "客服退款 刷单返利", top_k: 2, use_cache: true })) as {
    result_count: number;
    results: Array<{ chunk_id: string }>;
  };
  const events = await readEvents(traceFile);
  check(events.length === 1, "一次检索只记一行", events.length);
  const event = events[0]!;
  check(event.query === "客服退款 刷单返利" && event.top_k === 2 && event.use_cache === true, "入参如实记录");
  check(event.counts.results === output.result_count && event.results.length === output.result_count, "结果数与输出一致");
  check(
    event.results.every((r, i) => r.chunk_id === output.results[i]?.chunk_id),
    "结果顺序与输出一致"
  );
  check((event.stages_ms.index ?? 0) >= 0 && (event.stages_ms.lexical ?? 0) >= 0, "词法与索引阶段有耗时");
  check(event.error === undefined && event.errors === undefined, "成功路径没有错误字段");
  check(typeof event.latency_ms === "number" && event.latency_ms >= 0, "端到端延迟有值");
}

async function testErrorPathTrace() {
  const dir = dirFor("error");
  const store = await seedStore(dir);
  const traceFile = path.join(dir, "traces", "rag-search.jsonl");
  const tool = createRagSearchTool({
    store,
    traceSink: new FileRagTraceSink(path.join(dir, "traces")),
    webSearch: failingWeb,
  });
  let threw = false;
  try {
    await tool.execute({ query: "完全不相关的查询词组xyzq", top_k: 3, use_cache: true });
  } catch {
    threw = true;
  }
  check(threw, "本地无命中且联网失败时照常抛错");
  const events = await readEvents(traceFile);
  check(events.length === 1 && typeof events[0]?.error === "string", "抛错路径同样落一行 trace 并带 error", events[0]);
}

async function testBrokenSinkDoesNotBreakRetrieval() {
  const dir = dirFor("broken");
  const store = await seedStore(dir);
  // 用一个"文件"当目录：mkdirSync 必失败，sink 应静默关闭而不是把检索炸掉
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "not a dir");
  const tool = createRagSearchTool({
    store,
    traceSink: new FileRagTraceSink(path.join(blocker, "traces")),
    webSearch: failingWeb,
  });
  const output = (await tool.execute({ query: "客服退款", top_k: 3, use_cache: true })) as { result_count: number };
  check(output.result_count > 0, "trace 写失败时检索照常返回");
}

async function testRewriteRerankFields() {
  const dir = dirFor("augment");
  const store = await seedStore(dir);
  const traceFile = path.join(dir, "traces", "rag-search.jsonl");
  const tool = createRagSearchTool({
    store,
    traceSink: new FileRagTraceSink(path.join(dir, "traces")),
    reranker: { model: "fake-rerank", rerank: async () => [0.9, 0.1] },
    rewriter: { model: "fake-rewrite", rewrite: async (q) => `改写:${q}` },
    webSearch: failingWeb,
  });
  await tool.execute({ query: "客服退款 刷单返利", top_k: 3, use_cache: true });
  const events = await readEvents(traceFile);
  const event = events.at(-1)!;
  check(event.rerank_model === "fake-rerank", "重排模型名进 trace");
  check(event.rewritten_query === "改写:客服退款 刷单返利", "改写后的查询进 trace");
  check((event.stages_ms.rerank ?? -1) >= 0 && (event.stages_ms.rewrite ?? -1) >= 0, "重排与改写阶段有耗时");
  check(event.results.some((r) => typeof r.rerank_score === "number"), "重排分进结果摘要");
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  try {
    await testSinkShape();
    await testEnvFactory();
    await testSuccessPathTrace();
    await testErrorPathTrace();
    await testBrokenSinkDoesNotBreakRetrieval();
    await testRewriteRerankFields();
  } finally {
    await fs.rm(ROOT, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("TEST CRASHED:", error);
  process.exitCode = 1;
});
