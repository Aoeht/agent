// RAG 重排与查询改写：改写只在命中不足时触发、失败降级；重排改序、trust 加权、失败降级；HTTP 请求/响应形状。
// 运行：bun run tests/rerank_rewrite.test.ts
// 测试必须密闭：不走真实 embedding / PG / 重排 / 改写服务，全部注入 fake 或 stub fetch
delete process.env.EMBEDDING_MODEL;
delete process.env.RAG_PG_URL;
delete process.env.RERANK_MODEL;
delete process.env.AGENT_RAG_REWRITE;
import fs from "node:fs/promises";
import path from "node:path";
import { KnowledgeStore, type TrustLevel } from "../src/rag/knowledge_store";
import { HttpReranker, RERANK_MAX_DOCUMENTS, resolveRerankEndpoint, type Reranker } from "../src/rag/rerank";
import { createQueryRewriterFromEnv, sanitizeRewrite, type QueryRewriter } from "../src/rag/rewrite";
import { createRagSearchTool } from "../src/tools/rag_search";
import type { TavilyResponse, TavilyResult, TavilySearchRequest } from "../src/tools/tavily_client";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

const ROOT = path.resolve(".sand-box/.tmp-rerank-rewrite");
const dirFor = (name: string) => path.join(ROOT, name);

const SCAM_DOC =
  "冒充客服退款诈骗是常见的电信诈骗手法。骗子自称电商平台客服，以商品质量问题为由主动提出退款，随后诱导受害人下载会议软件开启屏幕共享，并把钱转到所谓的安全账户。";
const RULES_DOC = "平台退款流程规范：退款必须原路返回，客服不会要求开启屏幕共享，也不存在安全账户。";
const BRUSH_DOC =
  "刷单返利诈骗的典型话术：先做小额任务返本金获取信任，再诱导大额充值，最后以任务超时为由拒绝提现。";
const COOKING_DOC = "红烧肉的做法：五花肉切块焯水，加入冰糖炒出糖色，再放生抽老抽和八角小火慢炖一小时。";

interface RagOutput {
  result_count: number;
  rewritten_query?: string;
  rewrite_error?: string;
  rerank_model?: string;
  rerank_error?: string;
  web_search_error?: string;
  sources: { title: string; url: string }[];
  results: {
    content: string;
    source: string;
    title?: string;
    trust: string;
    origin: string;
    chunk_id: string;
    rerank_score?: number;
    trust_weight?: number;
  }[];
}

type WebSearch = ((request: TavilySearchRequest) => Promise<TavilyResponse>) & { calls: TavilySearchRequest[] };

function fakeWeb(results: TavilyResult[]): WebSearch {
  const calls: TavilySearchRequest[] = [];
  const fn = Object.assign(
    async (request: TavilySearchRequest) => {
      calls.push(request);
      return { results };
    },
    { calls }
  );
  return fn;
}

async function seed(dir: string, docs: { source: string; title: string; content: string; trust: TrustLevel }[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const store = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  await store.upsert(docs);
}

function testSanitizeRewrite() {
  check(sanitizeRewrite("改写后的查询：刷单返利诈骗", "原查询") === "刷单返利诈骗", "去掉“改写后的查询：”前缀");
  check(sanitizeRewrite("“冒充客服退款诈骗”", "原查询") === "冒充客服退款诈骗", "去掉包裹引号");
  check(sanitizeRewrite("刷单返利诈骗\n解释：这是一种…", "原查询") === "刷单返利诈骗", "只取第一行");
  check(sanitizeRewrite("   ", "原查询") === "原查询", "空结果退回原查询");
  check(sanitizeRewrite("啊".repeat(200), "原查询") === "原查询", "过长结果退回原查询");
}

async function testNoRewriteWhenLocalSufficient() {
  const dir = dirFor("local-ok");
  await seed(dir, [{ source: "https://kb.example/scam", title: "退款诈骗", content: SCAM_DOC, trust: "internal" }]);
  const calls: string[] = [];
  const rewriter: QueryRewriter = {
    model: "fake-rewriter",
    rewrite: async (query) => {
      calls.push(query);
      return "改写后的查询";
    },
  };
  const web = fakeWeb([]);
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: web, rewriter, reranker: null });
  const out = (await tool.execute({ query: "冒充客服退款诈骗", top_k: 1 })) as RagOutput;
  check(calls.length === 0, "本地命中充足时不调用改写", calls);
  check(web.calls.length === 0, "本地命中充足时不联网", web.calls.length);
  check(out.result_count === 1 && out.rewritten_query === undefined, "无改写时不带 rewritten_query", out);
}

async function testRewriteFeedsSecondLocalPass() {
  const dir = dirFor("rewrite");
  await seed(dir, [{ source: "https://kb.example/brush", title: "刷单返利", content: BRUSH_DOC, trust: "internal" }]);
  const rewritten = "刷单返利 做任务返本金 诈骗";
  const calls: string[] = [];
  const rewriter: QueryRewriter = {
    model: "fake-rewriter",
    rewrite: async (query) => {
      calls.push(query);
      return rewritten;
    },
  };
  const web = fakeWeb([]);
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: web, rewriter, reranker: null });
  const out = (await tool.execute({ query: "我昨天被坑了怎么办", top_k: 1 })) as RagOutput;
  check(calls.length === 1, "本地命中不足时改写一次", calls);
  check(out.rewritten_query === rewritten, "结果上报改写后的查询", out.rewritten_query);
  check(out.results[0]?.content.includes("刷单返利") === true, "改写后的查询二次检索命中", out.results.map((r) => r.title));
  check(web.calls.length === 0, "二次检索命中后不再联网", web.calls.length);
}

async function testRewriteFailureFallsBack() {
  const dir = dirFor("rewrite-fail");
  const rewriter: QueryRewriter = {
    model: "fake-rewriter",
    rewrite: async () => {
      throw new Error("改写模型超时");
    },
  };
  const web = fakeWeb([{ title: "客服退款", url: "https://news.example/scam", content: SCAM_DOC }]);
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: web, rewriter, reranker: null });
  const out = (await tool.execute({ query: "冒充客服退款诈骗", top_k: 1 })) as RagOutput;
  check(out.rewrite_error === "改写模型超时", "改写失败被上报", out.rewrite_error);
  check(web.calls[0]?.query === "冒充客服退款诈骗", "改写失败时联网仍用原查询", web.calls[0]?.query);
  check(out.results.length === 1, "改写失败仍能靠联网兜底", out.result_count);
}

/** 同一份语料用两个工具查：一个不重排做对照，一个注入重排器 */
async function testRerankReorders() {
  const dir = dirFor("rerank");
  await seed(dir, [
    { source: "https://kb.example/scam", title: "退款诈骗", content: SCAM_DOC, trust: "internal" },
    { source: "https://kb.example/rules", title: "平台规则", content: RULES_DOC, trust: "internal" },
  ]);
  const query = "客服退款 屏幕共享 安全账户 会议软件";
  const baseline = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), reranker: null });
  const before = (await baseline.execute({ query, top_k: 2 })) as RagOutput;
  check(before.results[0]?.title === "退款诈骗", "对照：不重排时按 BM25 排", before.results.map((r) => r.title));

  const reranker: Reranker = {
    model: "fake-rerank",
    rerank: async (_query, documents) => documents.map((text) => (text.includes("原路返回") ? 0.95 : 0.2)),
  };
  const reranked = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), reranker });
  const after = (await reranked.execute({ query, top_k: 2 })) as RagOutput;
  check(after.results[0]?.title === "平台规则", "重排后语义更贴的块排第一", after.results.map((r) => r.title));
  check(after.rerank_model === "fake-rerank", "结果上报重排模型", after.rerank_model);
  check(typeof after.results[0]?.rerank_score === "number", "每条结果带 rerank_score", after.results[0]);
}

async function testRerankFailureKeepsOrder() {
  const dir = dirFor("rerank-fail");
  await seed(dir, [
    { source: "https://kb.example/scam", title: "退款诈骗", content: SCAM_DOC, trust: "internal" },
    { source: "https://kb.example/rules", title: "平台规则", content: RULES_DOC, trust: "internal" },
  ]);
  const reranker: Reranker = {
    model: "fake-rerank",
    rerank: async () => {
      throw new Error("重排接口 502");
    },
  };
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), reranker });
  const out = (await tool.execute({ query: "客服退款 屏幕共享 安全账户 会议软件", top_k: 2 })) as RagOutput;
  check(out.rerank_error === "重排接口 502", "重排失败被上报", out.rerank_error);
  check(out.result_count === 2, "重排失败仍返回原有结果", out.result_count);
  check(out.results[0]?.title === "退款诈骗", "重排失败保留原排序", out.results.map((r) => r.title));
  check(out.results.every((r) => r.rerank_score === undefined), "重排失败不写 rerank_score");
}

async function testTrustWeightSurvivesRerank() {
  const dir = dirFor("rerank-trust");
  await seed(dir, [
    { source: "https://kb.example/rules", title: "平台规则", content: RULES_DOC, trust: "internal" },
    { source: "https://web.example/post", title: "网帖", content: `${RULES_DOC}补充：网上也有人声称能代办退款。`, trust: "web" },
  ]);
  const reranker: Reranker = { model: "fake-rerank", rerank: async (_query, documents) => documents.map(() => 0.5) };
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: fakeWeb([]), reranker });
  const out = (await tool.execute({ query: "退款 原路返回 安全账户", top_k: 2 })) as RagOutput;
  check(out.results[0]?.trust === "internal", "重排分相同时内部规则靠 trust 权重胜出", out.results.map((r) => `${r.title}:${r.trust}`));
  check(out.results[0]?.trust_weight === 1.2, "内部结果的 trust_weight 如实输出", out.results[0]?.trust_weight);
}

/** 不起服务：替换 fetch 验证 DashScope 原生与通用两种请求体、响应解析和文档上限 */
async function testRerankHttpShapes() {
  const originalFetch = globalThis.fetch;
  const captured: { url: string; body: Record<string, unknown> }[] = [];
  const stub = (payload: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  try {
    globalThis.fetch = stub({ output: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] } });
    const dashscope = new HttpReranker(
      "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
      "test-key",
      "qwen3.7-text-rerank",
      "dashscope"
    );
    const scores = await dashscope.rerank("退款诈骗", ["块A", "块B"]);
    check(scores[0] === 0.1 && scores[1] === 0.9, "DashScope 响应按 index 还原顺序", scores);
    const body = captured[0]!.body as { input?: { query?: string; documents?: string[] }; parameters?: { top_n?: number } };
    check(body.input?.query === "退款诈骗" && body.input?.documents?.length === 2, "DashScope 原生请求体用 input 包裹", body);
    check(body.parameters?.top_n === 2, "DashScope 请求 top_n 覆盖全部候选", body.parameters);

    globalThis.fetch = stub({ results: [{ index: 0, relevance_score: 0.42 }] });
    const generic = new HttpReranker("https://api.example.com/v1/rerank", "test-key", "any-rerank", "generic");
    const genericScores = await generic.rerank("退款", ["块A", "块B"]);
    check(genericScores[0] === 0.42 && genericScores[1] === 0, "通用响应缺省下标记 0 分", genericScores);
    const genericBody = captured[1]!.body as { query?: string; documents?: string[] };
    check(genericBody.query === "退款" && genericBody.documents?.length === 2, "通用请求体用扁平 query/documents", genericBody);

    const many = Array.from({ length: RERANK_MAX_DOCUMENTS + 5 }, (_, i) => `块${i}`);
    await generic.rerank("退款", many);
    const capped = captured[2]!.body as { documents?: string[] };
    check(capped.documents?.length === RERANK_MAX_DOCUMENTS, `送重排的文档数上限 ${RERANK_MAX_DOCUMENTS}`, capped.documents?.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testEndpointResolution() {
  const dash = resolveRerankEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1");
  check(
    dash.url === "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank" && dash.style === "dashscope",
    "DashScope 域名推断为原生重排路径",
    dash
  );
  const intl = resolveRerankEndpoint("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
  check(intl.style === "dashscope", "dashscope-intl 同样走原生路径", intl);
  const generic = resolveRerankEndpoint("https://api.example.com/v1/");
  check(generic.url === "https://api.example.com/v1/rerank" && generic.style === "generic", "其它域名按 {base}/rerank", generic);
}

function testFactoriesDisabledByDefault() {
  check(createQueryRewriterFromEnv({ model: undefined }) === undefined, "无模型名时不构造改写器");
  process.env.AGENT_RAG_REWRITE = "0";
  try {
    check(createQueryRewriterFromEnv({ model: "qwen3-max" }) === undefined, "AGENT_RAG_REWRITE=0 时不构造改写器");
  } finally {
    delete process.env.AGENT_RAG_REWRITE;
  }
  check(createQueryRewriterFromEnv({ model: "qwen3-max" }) !== undefined, "给出模型名且未关闭时构造改写器");
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  try {
    testSanitizeRewrite();
    await testNoRewriteWhenLocalSufficient();
    await testRewriteFeedsSecondLocalPass();
    await testRewriteFailureFallsBack();
    await testRerankReorders();
    await testRerankFailureKeepsOrder();
    await testTrustWeightSurvivesRerank();
    await testRerankHttpShapes();
    testEndpointResolution();
    testFactoriesDisabledByDefault();
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
