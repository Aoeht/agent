// tests/citations.test.ts
import { test, expect } from "bun:test";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import {
  extractSources,
  renderCitationBlock,
  extractCitedIndices,
} from "../src/core/citations";
import type { ToolDefinition } from "../src/core/types";

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

// ---------- renderCitationBlock ----------

test("renderCitationBlock：空列表返回空串，否则渲染编号清单", () => {
  expect(renderCitationBlock([])).toBe("");
  expect(
    renderCitationBlock([
      { index: 1, title: "A 篇", url: "https://a.example/", tool: "search_web" },
      { index: 2, title: "B 篇", tool: "rag_search" },
    ])
  ).toBe("【引用来源】\n[1] A 篇（https://a.example/）\n[2] B 篇");
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