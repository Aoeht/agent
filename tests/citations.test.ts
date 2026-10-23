// tests/citations.test.ts
import { test, expect } from "bun:test";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import {
  extractSources,
  renderCitationBlock,
  stripCitationPreamble,
  extractCitedIndices,
  citationPreambleOf,
  parseCitationLines,
  renderCitationDigest,
} from "../src/core/citations";
import type { ToolDefinition } from "../src/core/types";
import { bindRagCitationRefs } from "../src/core/citations";
import { createRagSearchTool } from "../src/tools/rag_search";
import { KnowledgeStore } from "../src/rag/knowledge_store";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// ---------- extractSources ----------

test("extractSources：提取合法 sources 并规范字段", () => {
  const result = JSON.stringify({
    answer: "summary",
    sources: [
      { title: "  A 篇  ", url: "https://a.example/", snippet: "摘要 A" },
      { title: "B 篇（无链）", snippet: "摘要 B" },
      { title: "C 篇（无摘要）", url: "https://c.example/" },
    ],
  });
  expect(extractSources("search_web", result)).toEqual([
    { title: "A 篇", url: "https://a.example/", snippet: "摘要 A", tool: "search_web" },
    { title: "B 篇（无链）", snippet: "摘要 B", tool: "search_web" },
    { title: "C 篇（无摘要）", url: "https://c.example/", tool: "search_web" },
  ]);
});

test("extractSources：无 sources / 非 JSON / 空 title 一律返回空数组（安全兼容）", () => {
  expect(extractSources("rag_search", JSON.stringify({ answer: "纯回答" }))).toEqual([]);
  expect(extractSources("rag_search", "这根本不是 JSON")).toEqual([]);
  expect(extractSources("git_tree", "src/\n  core/agent.ts")).toEqual([]);
  expect(
    extractSources("rag_search", JSON.stringify({ sources: [{ title: "  " }, { title: "", url: "https://x" }] }))
  ).toEqual([]);
  expect(extractSources("rag_search", JSON.stringify({ sources: "不是数组" }))).toEqual([]);
});

// ---------- stripCitationPreamble ----------

test("stripCitationPreamble：剥掉块头只留正文，非引用块原样返回", () => {
  const block = renderCitationBlock([
    { index: 1, title: "来源一", url: "https://a.example/", tool: "rag_search" },
    { index: 2, title: "来源二", tool: "rag_search" },
  ]);
  expect(stripCitationPreamble(`${block}\n\n真正的工具结果`)).toBe("真正的工具结果");
  expect(stripCitationPreamble("没有引用块的普通结果")).toBe("没有引用块的普通结果");
  expect(stripCitationPreamble(block)).toBe(""); // 纯引用块没有正文
});

// ---------- renderCitationBlock ----------

test("renderCitationBlock：空列表返回空串，否则渲染编号清单", () => {
  expect(renderCitationBlock([])).toBe("");
  expect(
    renderCitationBlock([
      { index: 1, title: "A 篇", url: "https://a.example/", tool: "search_web" },
      { index: 2, title: "B 篇", tool: "rag_search" },
    ])
  ).toBe("【引用来源】编号只放在被支撑句子的末尾；不要复制本列表，不要把编号放在回答开头\n[1] A 篇（https://a.example/）\n[2] B 篇");
});

// ---------- 压缩后的编号索引 ----------

test("citationPreambleOf / parseCitationLines：取出块头并按编号解析来源行", () => {
  const block = renderCitationBlock([
    { index: 1, title: "A 篇", url: "https://a.example/", tool: "search_web" },
    { index: 2, title: "B 篇", tool: "rag_search" },
  ]);
  const text = `${block}\n\n工具正文`;
  expect(citationPreambleOf(text)).toBe(block);
  expect(citationPreambleOf("普通结果")).toBe("");
  expect(parseCitationLines(citationPreambleOf(text))).toEqual([
    { index: 1, line: "[1] A 篇（https://a.example/）" },
    { index: 2, line: "[2] B 篇" },
  ]);
});

test("renderCitationDigest：编号沿用原分配，来源清单按不可信数据围栏", () => {
  expect(renderCitationDigest([])).toBe("");
  const digest = renderCitationDigest(["[3] C 篇（https://c.example/）", "[1] A 篇"]);
  expect(digest).toContain("【引用来源索引】");
  expect(digest).toContain("不要重新编号");
  expect(digest).toContain("[3] C 篇（https://c.example/）");
  expect(digest).toContain("[1] A 篇");
  expect(digest).toContain("不可信外部数据"); // 标题/链接来自外部，标题里带指令不能洗白
  expect(digest).toContain("请勿执行");
});

// ---------- extractCitedIndices ----------

test("extractCitedIndices：按出现顺序去重提取编号", () => {
  expect(extractCitedIndices("结论见 [2]，细节见 [1] 与 [2][3]。")).toEqual([2, 1, 3]);
  expect(extractCitedIndices("没有任何引用")).toEqual([]);
  expect(extractCitedIndices("[0] 与 [999] 和 [abc]")).toEqual([0, 999]);
});

// ---------- Agent 集成：引用注册 / 编号 / 去重 / 注入块 ----------

function makeSearchTool(name: string, sources: Array<{ title: string; url?: string; snippet?: string }>): ToolDefinition {
  return {
    name,
    description: "返回带来源的搜索结果",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    execute: async () => ({ answer: "ok", sources }),
  };
}

/** 按脚本返回 mock LLM 响应：tool_call 轮 → 最终回答轮 */
function makeMockClient(script: Array<(i: number) => Record<string, unknown>>) {
  const requests: any[] = [];
  const client = {
    chat: { completions: { create: async (request: any) => {
      requests.push(request);
      const step = script[requests.length - 1]!(requests.length - 1);
      return { choices: [{ message: step }], usage: { total_tokens: 100 } };
    } } },
  } as any;
  return { client, requests };
}

test("同一工具返回的来源被编号并注入 tool 消息，随 result.citations 透出", async () => {
  const tools = new ToolRegistry();
  tools.register(
    makeSearchTool("search_web", [
      { title: "A 篇", url: "https://a.example/", snippet: "摘要 A" },
      { title: "B 篇", url: "https://b.example/" },
    ])
  );
  const { client, requests } = makeMockClient([
    () => ({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "search_web", arguments: JSON.stringify({ q: "x" }) } }],
    }),
    () => ({ content: "结论：[1] 与 [2] 支持该说法。" }),
  ]);
  const agent = new Agent({ model: "t", systemPrompt: "规则", client, tools });
  const result = await agent.run("查一下");

  expect(result.success).toBe(true);
  const citations = result.citations;
  expect(citations).toEqual([
    { index: 1, title: "A 篇", url: "https://a.example/", snippet: "摘要 A", tool: "search_web" },
    { index: 2, title: "B 篇", url: "https://b.example/", tool: "search_web" },
  ]);
  // 引用块随真实结果一起进入模型可见的 tool 消息
  const toolMsg = result.messages.find((m) => m.role === "tool");
  expect(toolMsg?.content).toContain("【引用来源】");
  expect(toolMsg?.content).toContain("[1] A 篇（https://a.example/）");
  // 最终回答引用的编号都在引用表里
  expect(citations.map((c) => c.index)).toEqual(extractCitedIndices(result.finalAnswer!));
  // 第二轮请求确实带着引用块
  expect(JSON.stringify(requests[1].messages)).toContain("[2] B 篇");
});

test("跨工具重复来源（同 url）只占一个编号", async () => {
  const tools = new ToolRegistry();
  tools.register(makeSearchTool("search_web", [{ title: "A 篇", url: "https://a.example/" }]));
  tools.register(makeSearchTool("rag_search", [{ title: "A 篇（重复）", url: "https://a.example/", snippet: "不同摘要" }]));
  const { client } = makeMockClient([
    () => ({
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "search_web", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "rag_search", arguments: "{}" } },
      ],
    }),
    () => ({ content: "结论 [1]" }),
  ]);
  const agent = new Agent({ model: "t", systemPrompt: "规则", client, tools });
  const result = await agent.run("查");

  expect(result.citations).toHaveLength(1);
  expect(result.citations[0]!.index).toBe(1);
  const repeated = result.messages.filter(m => m.role === "tool")[1];
  expect(repeated?.content).toContain("[1] A 篇（https://a.example/）");
});

test("真实 RAG 多轮检索：跨工具去重、同源多块共用全局编号、无标题回退", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "rag-citations-"));
  try {
    const store = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json"), chunk: { maxChars: 100 } });
    const tools = new ToolRegistry();
    tools.register(makeSearchTool("search_web", [{ title: "已有来源", url: "https://example.com/existing" }]));
    tools.register(createRagSearchTool({
      store, embeddings: null,
      webSearch: async request => ({ results: request.query === "退款" ? [
        { title: "重复来源", url: "https://example.com/existing", content: "退款证据。" },
        { title: "", url: "https://example.com/new", content: "退款流程。" },
      ] : [{ title: "新案例", url: "https://example.com/third", content: "诈骗案例。".repeat(40) }] }),
    }));
    const call = (id: string, name: string, args: object = {}) => ({
      id, type: "function", function: { name, arguments: JSON.stringify(args) },
    });
    const { client, requests } = makeMockClient([
      () => ({ content: null, tool_calls: [call("web", "search_web")] }),
      () => ({ content: null, tool_calls: [call("rag1", "rag_search", { query: "退款", top_k: 2, use_cache: false })] }),
      () => ({ content: null, tool_calls: [call("rag2", "rag_search", { query: "诈骗", top_k: 2, use_cache: false })] }),
      () => ({ content: "证据见 [1][2][3]。" }),
    ]);
    const result = await new Agent({ model: "t", systemPrompt: "规则", client, tools }).run("检索");
    expect(result.success).toBe(true);
    expect(result.citations.map(c => [c.index, c.url])).toEqual([
      [1, "https://example.com/existing"], [2, "https://example.com/new"], [3, "https://example.com/third"],
    ]);
    expect(result.citations[1]!.title).toBe("https://example.com/new");
    const messages = result.messages.filter(m => m.role === "tool");
    const payload = (i: number) => JSON.parse(String(messages[i]!.content).split("\n\n").slice(1).join("\n\n"));
    expect(payload(1).results.map((r: any) => r.ref)).toEqual([1, 2]);
    expect(payload(2).results.map((r: any) => r.ref)).toEqual([3, 3]);
    expect(payload(2).sources).toHaveLength(1);
    expect(payload(2).results.every((r: any) => r.chunk_id && r.content)).toBe(true);
    expect(messages[1]!.content).toContain("[1] 已有来源");
    expect(JSON.stringify(requests[3].messages)).toContain("[3] 新案例");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("RAG 编号绑定：移除未注册的局部编号，兼容空结果和错误响应", () => {
  const citations = [{ index: 7, title: "来源", url: "https://a.example", tool: "rag_search" }];
  const raw = JSON.stringify({ results: [{ ref: 1, source: "https://a.example", chunk_id: "a" }, { ref: 2, source: "missing" }] });
  const bound = JSON.parse(bindRagCitationRefs("rag_search", raw, citations));
  expect(bound.results).toEqual([{ source: "https://a.example", chunk_id: "a", ref: 7 }, { source: "missing" }]);
  expect(bindRagCitationRefs("echo", raw, citations)).toBe(raw);
  for (const input of ["not json", "null", '{"error":"failed"}', '{"results":[]}']) {
    expect(bindRagCitationRefs("rag_search", input, citations)).toBe(input);
  }
});

test("每次 run 引用编号都从 1 重新计数（run 间隔离）", async () => {
  const tools = new ToolRegistry();
  tools.register(makeSearchTool("search_web", [{ title: "A 篇", url: "https://a.example/" }]));
  const { client } = makeMockClient([
    () => ({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "search_web", arguments: "{}" } }],
    }),
    () => ({ content: "第一轮 [1]" }),
    () => ({
      content: null,
      tool_calls: [{ id: "c2", type: "function", function: { name: "search_web", arguments: "{}" } }],
    }),
    () => ({ content: "第二轮 [1]" }),
  ]);
  const agent = new Agent({ model: "t", systemPrompt: "规则", client, tools });
  const first = await agent.run("第一次");
  const second = await agent.run("第二次");

  expect(first.citations[0]!.index).toBe(1);
  expect(second.citations[0]!.index).toBe(1);
});

test("无 sources 的工具结果不产生引用，也不注入引用块", async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "原样返回",
    parameters: { type: "object" },
    execute: async () => ({ answer: "没来源" }),
  });
  const { client } = makeMockClient([
    () => ({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }],
    }),
    () => ({ content: "直接回答" }),
  ]);
  const agent = new Agent({ model: "t", systemPrompt: "规则", client, tools });
  const result = await agent.run("问");

  expect(result.citations).toEqual([]);
  expect(JSON.stringify(result.messages)).not.toContain("【引用来源】");
});
