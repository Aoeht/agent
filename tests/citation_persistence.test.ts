// tests/citation_persistence.test.ts
// 引用持久化：终答消息落盘附带 citations → 续聊进 LLM 上下文前剥离 → history() 透出。
// 场景来源：Web 刷新 / 切回旧会话后引用卡片要能恢复。
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { SessionStore } from "../src/core/session_store";
import { SessionManager, EventHub } from "../src/server/sessions";
import type { ToolDefinition } from "../src/core/types";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function makeSearchTool(sources: Array<{ title: string; url?: string; snippet?: string }>): ToolDefinition {
  return {
    name: "search_web",
    description: "返回带来源的搜索结果",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    execute: async () => ({ answer: "ok", sources }),
  };
}

/** 按脚本返回 mock LLM 响应：tool_call 轮 → 最终回答轮 → （可选）续聊回答轮 */
function makeMockClient(script: Array<() => Record<string, unknown>>) {
  const requests: any[] = [];
  const client = {
    chat: { completions: { create: async (request: any) => {
      requests.push(request);
      const step = script[requests.length - 1]!();
      return { choices: [{ message: step }], usage: { total_tokens: 100 } };
    } } },
  } as any;
  return { client, requests };
}

test("终答消息落盘附带 citations：JSONL 里查得到，load() 后仍在", async () => {
  const dir = await tempDir("dsh-cite-persist-");
  const store = new SessionStore({ dir, sessionId: "c1" });
  const tools = new ToolRegistry();
  tools.register(makeSearchTool([{ title: "A 篇", url: "https://a.example/", snippet: "摘要 A" }]));
  const { client } = makeMockClient([
    () => ({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "search_web", arguments: "{}" } }],
    }),
    () => ({ content: "结论见 [1]。" }),
  ]);
  const agent = new Agent({ model: "t", systemPrompt: "规则", client, tools, sessionStore: store });
  const result = await agent.run("查一下");

  expect(result.citations).toHaveLength(1);
  // 落盘行带着引用（历史回放的数据源）
  const raw = await fs.readFile(store.filePath, "utf-8");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  const persistedFinal = lines.find((line) => line.role === "assistant" && line.content === "结论见 [1]。") as any;
  expect(persistedFinal.citations).toEqual(result.citations);
  // store.load() 原样读回：供 Web history() 透出
  const loaded = await store.load();
  const loadedFinal = loaded.messages.find((m) => m.role === "assistant") as any;
  expect(loadedFinal.citations).toEqual(result.citations);

  await fs.rm(dir, { recursive: true, force: true });
});

test("无引用的终答不写 citations 字段（保持老格式，不多占字节）", async () => {
  const dir = await tempDir("dsh-cite-plain-");
  const store = new SessionStore({ dir, sessionId: "c2" });
  const { client } = makeMockClient([() => ({ content: "直接回答" })]);
  const agent = new Agent({ model: "t", systemPrompt: "规则", client, tools: new ToolRegistry(), sessionStore: store });
  await agent.run("问");

  const raw = await fs.readFile(store.filePath, "utf-8");
  expect(raw).not.toContain("citations");

  await fs.rm(dir, { recursive: true, force: true });
});

test("续聊时落盘的 citations 不进 LLM 上下文（严格服务端会拒收非标准字段），磁盘上不丢", async () => {
  const dir = await tempDir("dsh-cite-resume-");
  const store = new SessionStore({ dir, sessionId: "c3" });
  const tools = new ToolRegistry();
  tools.register(makeSearchTool([{ title: "A 篇", url: "https://a.example/" }]));

  // 第一个进程：跑一轮带引用的回答
  const first = makeMockClient([
    () => ({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "search_web", arguments: "{}" } }],
    }),
    () => ({ content: "第一轮结论 [1]" }),
  ]);
  const agent1 = new Agent({ model: "t", systemPrompt: "规则", client: first.client, tools, sessionStore: store });
  await agent1.run("第一次");

  // 第二个进程（新 Agent）：续聊同一会话
  const second = makeMockClient([
    () => ({ content: "第一轮见上，[1] 是 A 篇。" }), // 历史里带着上一轮引用消息，直接回答
    () => ({ content: "第二轮回答" }),
  ]);
  const agent2 = new Agent({ model: "t", systemPrompt: "规则", client: second.client, tools, sessionStore: store });
  await agent2.run("第二次");

  // 发给 LLM 的请求里没有任何 citations 字段
  for (const request of [...first.requests, ...second.requests]) {
    expect(JSON.stringify(request.messages)).not.toContain('"citations"');
  }
  // 上一轮的终答正文仍在上下文里（只剥了引用，不丢内容）
  expect(JSON.stringify(second.requests[0].messages)).toContain("第一轮结论 [1]");
  // 磁盘上第一轮的引用还在（历史回放仍可用）
  const loaded = await store.load();
  const persisted = loaded.messages.find((m) => (m as any).content === "第一轮结论 [1]") as any;
  expect(persisted.citations).toEqual([
    { index: 1, title: "A 篇", url: "https://a.example/", tool: "search_web" },
  ]);

  await fs.rm(dir, { recursive: true, force: true });
});

test("history() 透出 citations；坏引用丢弃、老消息不带字段", async () => {
  const dir = await tempDir("dsh-cite-history-");
  const sessionDir = path.join(dir, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const store = new SessionStore({ dir: sessionDir, sessionId: "h1" });
  await store.append({ role: "user", content: "问题" });
  // 老格式：不带 citations
  await store.append({ role: "assistant", content: "老回答" });
  // 新格式：带合法引用
  await store.append({
    role: "user",
    content: "再问",
  } as any);
  await store.append({
    role: "assistant",
    content: "新回答 [1]",
    citations: [
      { index: 1, title: "A 篇", url: "https://a.example/", tool: "search_web" },
      // 混进来的坏引用：title 空 / index 非数字 → 整条丢弃
      { index: 2, title: "   ", tool: "search_web" },
      { index: NaN, title: "坏编号", tool: "search_web" },
    ],
  } as any);

  // history() 只依赖 sessionDir，hub/bridge/runtime 传最小桩
  const hub = new EventHub();
  const manager = new SessionManager({
    hub,
    bridge: { pendingEventsFor: () => [], disposeSession: () => {} } as any,
    runtime: {} as any,
    sessionDir,
    traceDir: path.join(dir, "trace"),
  });

  const detail = await manager.history("h1");
  expect(detail.messages).toHaveLength(4);
  expect(detail.messages[1]).toEqual({ role: "assistant", content: "老回答" }); // 无 citations 字段
  const withCitations = detail.messages[3]!;
  expect(withCitations.role).toBe("assistant");
  expect(withCitations.content).toBe("新回答 [1]");
  expect(withCitations.citations).toEqual([
    { index: 1, title: "A 篇", url: "https://a.example/", tool: "search_web" },
  ]);

  await fs.rm(dir, { recursive: true, force: true });
});
