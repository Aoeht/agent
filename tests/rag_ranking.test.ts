// RAG P2 回归：BM25 增量索引、trust 加权排序、Tavily score 利用、读写路径并发正确性。
// 运行：bun run tests/rag_ranking.test.ts
// .env 若配了 EMBEDDING_MODEL，bun 会自动加载并让默认装配走真实 embedding 接口；测试必须密闭，这里强制纯词法（语义通道由 rag_vector.test.ts 专门测）
delete process.env.EMBEDDING_MODEL;
delete process.env.RAG_PG_URL; // 同理：不让默认装配悄悄切到 PostgreSQL，PG 路径由 rag_pg.test.ts 专门测
import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "../src/core/agent";
import type { ToolDefinition } from "../src/core/types";
import { Bm25Index } from "../src/rag/bm25";
import { KnowledgeStore } from "../src/rag/knowledge_store";
import { tokenize } from "../src/rag/tokenizer";
import { createRagSearchTool } from "../src/tools/rag_search";
import { ToolRegistry } from "../src/core/registry";
import type { TavilyResponse, TavilySearchRequest } from "../src/tools/tavily_client";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

const ROOT = path.resolve(".sand-box/.tmp-rag-ranking");
const dirFor = (name: string) => path.join(ROOT, name);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SCAM_DOC =
  "冒充客服退款诈骗是常见的电信诈骗手法。骗子自称电商平台客服，以商品质量问题为由主动提出退款。随后诱导受害人下载会议软件开启屏幕共享，并把钱转到所谓的安全账户。";
const RULES_DOC = "平台退款流程规范：退款必须原路返回，客服不会要求开启屏幕共享，也不存在安全账户。";
const COOKING_DOC = "红烧肉的做法：五花肉切块焯水，加入冰糖炒出糖色，再放生抽老抽和八角小火慢炖一小时。";

function tokensOf(text: string) {
  return tokenize(text);
}

/** 增量与全量必须给出完全一致的排序结果，否则缓存复用会随写入历史漂移 */
function testIncrementalIndex() {
  const entries = [
    { id: "scam", text: SCAM_DOC },
    { id: "rules", text: RULES_DOC },
    { id: "cook", text: COOKING_DOC },
  ];
  const full = new Bm25Index(entries.map((e) => ({ id: e.id, tokens: tokensOf(e.text) })));

  const inc = new Bm25Index();
  for (const e of entries) inc.add({ id: e.id, tokens: tokensOf(e.text) });
  check(
    JSON.stringify(inc.search("客服退款诈骗", {})) === JSON.stringify(full.search("客服退款诈骗", {})),
    "逐条 add 与整体构造结果一致"
  );

  // 替换一个条目后，其余条目的相对排序与 df 贡献都要正确
  inc.add({ id: "scam", tokens: tokensOf(COOKING_DOC) });
  full.remove("scam");
  full.add({ id: "scam", tokens: tokensOf(COOKING_DOC) });
  check(JSON.stringify(inc.search("红烧肉 冰糖", {})) === JSON.stringify(full.search("红烧肉 冰糖", {})), "替换条目后与全量一致");
  check(inc.size === full.size && inc.size === 3, "size 随替换保持稳定", { inc: inc.size, full: full.size });

  // remove 必须回收 df：删掉唯一含“八角”的文档后，该词不该再影响其它文档的 IDF
  const withRemoved = new Bm25Index(entries.map((e) => ({ id: e.id, tokens: tokensOf(e.text) })));
  withRemoved.remove("cook");
  const rebuiltWithoutCook = new Bm25Index(entries.filter((e) => e.id !== "cook").map((e) => ({ id: e.id, tokens: tokensOf(e.text) })));
  check(
    JSON.stringify(withRemoved.search("退款 诈骗", {})) === JSON.stringify(rebuiltWithoutCook.search("退款 诈骗", {})),
    "remove 后 df/IDF 与直接重建完全一致"
  );
  check(withRemoved.search("八角 炖", {}).length === 0, "被删文档的词不再命中");
  check(withRemoved.remove("not-exists") === false, "remove 不存在的 id 返回 false");

  // 插入顺序变化也不能改变同分排序：交换 add 顺序应得到同样的结果序列
  const a = new Bm25Index();
  for (const e of entries) a.add({ id: e.id, tokens: tokensOf(e.text) });
  const b = new Bm25Index();
  for (const e of [...entries].reverse()) b.add({ id: e.id, tokens: tokensOf(e.text) });
  check(
    JSON.stringify(a.search("退款", {})) === JSON.stringify(b.search("退款", {})),
    "同分按 id 定序，结果不受插入顺序影响",
    { a: a.search("退款", {}), b: b.search("退款", {}) }
  );
}

interface RagOutput {
  result_count: number;
  results: {
    source: string;
    trust: string;
    origin: string;
    chunk_id: string;
    relevance_score: number;
    trust_weight?: number;
    web_score?: number;
  }[];
}

function makeTool(cacheDir: string, webSearch: (r: TavilySearchRequest) => Promise<TavilyResponse>, extra = {}) {
  return createRagSearchTool({ cacheDir, webSearch, ...extra });
}

function fakeWeb(results: TavilyResponse["results"], latencyMs = 0) {
  const calls: TavilySearchRequest[] = [];
  const fn = Object.assign(
    async (request: TavilySearchRequest): Promise<TavilyResponse> => {
      calls.push(request);
      if (latencyMs > 0) await sleep(latencyMs);
      return { results };
    },
    { calls }
  );
  return fn;
}

/** 同一内容分别以 internal 与 web 入库：词法分完全相同，顺序只能由 trust 权重决定 */
const SHARED_DOC = "冒充客服要求开启屏幕共享的，一律视为诈骗；所谓安全账户并不存在。";
const TRUST_QUERY = "客服 退款 诈骗 屏幕共享 安全账户";

async function testTrustWeighting() {
  const dir = dirFor("trust");
  const store = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  await store.upsert([
    { source: "https://web.example/scam", content: SHARED_DOC, trust: "web", title: "网页案例" },
    { source: "internal://docs/规则.md#客服退款诈骗", content: SHARED_DOC, trust: "internal", title: "平台规则" },
  ]);

  const docs = await store.list();
  const raw = new Bm25Index(docs.flatMap((d) => d.chunks.map((c) => ({ id: c.id, tokens: tokensOf(c.text) })))).search(TRUST_QUERY, {});
  check(raw.length === 2 && Math.abs(raw[0]!.score - raw[1]!.score) < 1e-12, "构造前提：两篇词法分完全相同", raw);

  const noWeb = fakeWeb([]);
  const weighted = (await makeTool(dir, noWeb).execute({ query: TRUST_QUERY, top_k: 2 })) as RagOutput;
  check(weighted.results[0]?.trust === "internal", "默认 1.2x 让 internal 在词法同分时排到 web 前面", weighted.results.map((r) => r.trust));
  check(weighted.results[0]?.trust_weight === 1.2 && weighted.results[1]?.trust_weight === undefined, "只有非 1 权重才输出 trust_weight", weighted.results);
  check(
    weighted.results[0]?.relevance_score === weighted.results[1]?.relevance_score,
    "relevance_score 仍是原始 BM25 分，未被权重污染",
    weighted.results.map((r) => r.relevance_score)
  );

  const neutral = (await makeTool(dir, noWeb, { trustWeights: { internal: 1, web: 1 } }).execute({ query: TRUST_QUERY, top_k: 2 })) as RagOutput;
  check(neutral.results.every((r) => r.trust_weight === undefined), "权重全为 1 时不再输出 trust_weight", neutral.results);
  check(
    JSON.stringify([...neutral.results.map((r) => r.source)].sort()) === JSON.stringify([...weighted.results.map((r) => r.source)].sort()),
    "改权重只换顺序，不动命中集合"
  );

  const downweighted = (await makeTool(dir, noWeb, { trustWeights: { internal: 0.5 } }).execute({ query: TRUST_QUERY, top_k: 2 })) as RagOutput;
  check(downweighted.results[0]?.trust === "web" && downweighted.results[0]?.trust_weight === undefined, "internal 权重压到 0.5 时 web 反超（不是硬性置顶）", downweighted.results.map((r) => [r.trust, r.trust_weight]));
  check(noWeb.calls.length === 0, "本地已满足 top_k 时不联网", noWeb.calls.length);
}

async function testTavilyScoreUsage() {
  const dir = dirFor("web-score");
  // 两篇英文文档：本地词法都对不上中文查询，只能靠 Tavily score 决定先后
  const web = fakeWeb([
    { title: "Low relevance", url: "https://low.example/a", content: "A generic consumer protection notice.", score: 0.21 },
    { title: "Refund scam", url: "https://high.example/b", content: "Scammers pose as support agents and push fake refunds.", score: 0.93 },
  ]);
  const out = (await makeTool(dir, web).execute({ query: "退款诈骗", top_k: 2 })) as RagOutput;
  check(out.result_count === 2, "跨语言场景仍返回两条", out.result_count);
  check(out.results[0]?.source === "https://high.example/b", "Tavily 高分文档排在前面", out.results.map((r) => [r.source, r.web_score]));
  check(out.results[0]?.web_score === 0.93 && out.results[1]?.web_score === 0.21, "web_score 透传原始相关性分", out.results.map((r) => r.web_score));

  // 有词法命中时 BM25 优先，web_score 只是附带信息
  const mixedWeb = fakeWeb([
    { title: "命中词法", url: "https://lexical.example/c", content: SCAM_DOC, score: 0.3 },
    { title: "无词法命中", url: "https://nolocal.example/d", content: "Totally unrelated English text about gardening.", score: 0.95 },
  ]);
  const mixed = (await makeTool(dir, mixedWeb).execute({ query: "客服退款诈骗 屏幕共享", top_k: 2 })) as RagOutput;
  check(mixed.results[0]?.source === "https://lexical.example/c", "本地能对上词的文档不被 Tavily 高分挤掉", mixed.results.map((r) => [r.source, r.web_score]));
  check(mixed.results.every((r) => r.origin === "web"), "补充结果标记 origin=web", mixed.results.map((r) => r.origin));
}

/** 索引复用：新文档入库后，旧块既不能被误删，也要继续参与排序 */
async function testIndexReuseAcrossRevisions() {
  const dir = dirFor("index-reuse");
  const webA = fakeWeb([{ title: "A", url: "https://reuse.example/a", content: SCAM_DOC, score: 0.5 }]);
  await makeTool(dir, webA).execute({ query: "客服退款诈骗", top_k: 1 });
  const webB = fakeWeb([{ title: "B", url: "https://reuse.example/b", content: RULES_DOC, score: 0.5 }]);
  await makeTool(dir, webB).execute({ query: "平台退款流程", top_k: 1 });

  const store = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  check((await store.list()).length === 2, "两次联网各自沉淀一条", (await store.list()).map((d) => d.source));

  const noWeb = fakeWeb([]);
  const oldest = (await makeTool(dir, noWeb).execute({ query: "客服退款诈骗 屏幕共享 安全账户", top_k: 1 })) as RagOutput;
  check(
    noWeb.calls.length === 0 && oldest.results[0]?.source === "https://reuse.example/a",
    "第二篇入库后，第一篇的块仍被命中（增量更新没丢旧条目）",
    { calls: noWeb.calls.length, source: oldest.results[0]?.source }
  );

  const both = (await makeTool(dir, noWeb).execute({ query: "退款 安全账户 客服", top_k: 2 })) as RagOutput;
  check(
    noWeb.calls.length === 0 && new Set(both.results.map((r) => r.source)).size === 2,
    "两篇文档都进入同一次排序",
    both.results.map((r) => r.source)
  );

  // 同一实例连续两次检索不该重建索引：用相同查询两次拿到一致结果且零联网
  const repeat = (await makeTool(dir, noWeb).execute({ query: "退款 安全账户 客服", top_k: 2 })) as RagOutput;
  check(JSON.stringify(repeat.results.map((r) => [r.chunk_id, r.relevance_score])) === JSON.stringify(both.results.map((r) => [r.chunk_id, r.relevance_score])), "revision 未变时结果完全稳定", repeat.results);
}

/** 读写路径解耦后的核心保证：并发检索（各自带联网写入）不丢任何一方的文档 */
async function testConcurrentSearchesKeepAllWrites() {
  const dir = dirFor("concurrent");
  const stale = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  await stale.upsert([{ source: "https://base.example/seed", content: COOKING_DOC, trust: "web" }]);

  const toolA = makeTool(
    dir,
    fakeWeb([{ title: "A", url: "https://a.example/doc", content: SCAM_DOC, score: 0.8 }], 40)
  );
  const toolB = makeTool(
    dir,
    fakeWeb([{ title: "B", url: "https://b.example/doc", content: RULES_DOC, score: 0.7 }], 40)
  );
  const [ra, rb] = await Promise.all([
    toolA.execute({ query: "客服退款诈骗", top_k: 1, use_cache: false }),
    toolB.execute({ query: "平台退款流程", top_k: 1, use_cache: false }),
  ]);
  check((ra as RagOutput).result_count === 1 && (rb as RagOutput).result_count === 1, "并发两路检索都拿到结果", [ra, rb]);

  const after = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  const sources = (await after.list()).map((d) => d.source).sort();
  check(
    sources.join(",") === "https://a.example/doc,https://b.example/doc,https://base.example/seed",
    "并发写入没有互相吞掉（丢失更新回归）",
    sources
  );
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
  check(leftovers.length === 0, "并发结束后不留临时文件或锁文件", leftovers);

  // 同进程多工具实例共享 revision 时的读一致性：新文档立刻对另一实例可见
  const reader = makeTool(dir, fakeWeb([]));
  const read = (await reader.execute({ query: "退款 安全账户 屏幕共享", top_k: 3 })) as RagOutput;
  check(read.results.some((r) => r.source === "https://a.example/doc" || r.source === "https://b.example/doc"), "并发写入的结果可被后续检索命中", read.results.map((r) => r.source));
}

interface CallEvent {
  query: string;
  phase: "start" | "end";
  at: number;
}

/** 用 stub LLM 服务让 Agent 一轮内发起两个 rag_search，记录各自执行窗口 */
async function agentBatchRun(dir: string, parallelFlag: boolean): Promise<{ events: CallEvent[]; sources: string[]; answer: string | null }> {
  const webWithDelay = async (request: TavilySearchRequest): Promise<TavilyResponse> => {
    await sleep(40);
    return {
      results: [
        {
          title: `资料 ${request.query}`,
          url: `https://par.example/${encodeURIComponent(request.query)}`,
          content: request.query.includes("退款") ? SCAM_DOC : RULES_DOC,
          score: 0.6,
        },
      ],
    };
  };
  const real = makeTool(dir, webWithDelay);
  const events: CallEvent[] = [];
  const instrumented: ToolDefinition = {
    ...real,
    parallelSafe: parallelFlag,
    execute: async (args, runtime) => {
      const query = String((args as { query?: string }).query ?? "");
      events.push({ query, phase: "start", at: Date.now() });
      const result = await real.execute(args, runtime);
      events.push({ query, phase: "end", at: Date.now() });
      return result;
    },
  };

  const scripted = (message: Record<string, unknown>, finishReason: string) =>
    Response.json({
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      await req.json();
      requests++;
      if (requests === 1) {
        return scripted(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "rag_search", arguments: JSON.stringify({ query: "客服退款诈骗", top_k: 1, use_cache: false }) } },
              { id: "c2", type: "function", function: { name: "rag_search", arguments: JSON.stringify({ query: "平台退款流程", top_k: 1, use_cache: false }) } },
            ],
          },
          "tool_calls"
        );
      }
      return scripted({ role: "assistant", content: "收工" }, "stop");
    },
  });

  const savedBase = process.env.OPENAI_BASE_URL;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.OPENAI_API_KEY = "smoke-test-key";
  const registry = new ToolRegistry();
  registry.register(instrumented);
  try {
    const agent = new Agent({ model: "mock-model", systemPrompt: "t", maxIterations: 3, tools: registry });
    const run = await agent.run("并发检索测试");
    const store = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
    return { events, sources: (await store.list()).map((d) => d.source).sort(), answer: run.finalAnswer };
  } finally {
    server.stop(true);
    if (savedBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBase;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
}

/** agent 级实测：parallelSafe 决定同批两个 rag_search 是真并发还是串行，且两种模式写入都不丢 */
async function testAgentRunsRagSearchInParallel() {
  const real = makeTool(dirFor("flag-only"), fakeWeb([]));
  check(real.parallelSafe === true, "rag_search 自身声明 parallelSafe", real.parallelSafe);

  const concurrent = await agentBatchRun(dirFor("agent-parallel"), true);
  const cStarts = concurrent.events.filter((e) => e.phase === "start").map((e) => e.at);
  const cEnds = concurrent.events.filter((e) => e.phase === "end").map((e) => e.at);
  check(cStarts.length === 2 && cEnds.length === 2 && concurrent.answer === "收工", "两个调用都执行且跑到最终答案", { events: concurrent.events, answer: concurrent.answer });
  check(Math.max(...cStarts) < Math.min(...cEnds), "parallelSafe=true：两个调用执行窗口重叠（确为并发）", concurrent.events);
  check(concurrent.sources.length === 2, "并发模式下两份联网结果都落盘", concurrent.sources);

  const serial = await agentBatchRun(dirFor("agent-serial"), false);
  const sStarts = serial.events.filter((e) => e.phase === "start").map((e) => e.at);
  const sEnds = serial.events.filter((e) => e.phase === "end").map((e) => e.at);
  check(Math.min(...sEnds) <= Math.max(...sStarts), "对照：parallelSafe=false 时按序串行执行", serial.events);
  check(serial.sources.length === 2, "串行模式下同样保住两份写入", serial.sources);
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  try {
    testIncrementalIndex();
    await testTrustWeighting();
    await testTavilyScoreUsage();
    await testIndexReuseAcrossRevisions();
    await testConcurrentSearchesKeepAllWrites();
    await testAgentRunsRagSearchInParallel();
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
