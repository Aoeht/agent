// tests/process_persistence.test.ts
// ReAct 过程持久化：工具调用随终答记录落盘 → 重启后可回放 → 但不进模型上下文。
// 场景来源：内容过滤/中断导致终答为空时，重启后仍要能看到这一轮调用了哪些工具。
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { SessionStore } from "../src/core/session_store";
import { formatHistoryReplay } from "../src/core/session_replay";
import type { ToolDefinition } from "../src/core/types";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function makeEchoTool(): ToolDefinition {
  return {
    name: "inspect",
    description: "返回固定结果",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async () => ({ ok: true }),
  };
}

function makeMockClient(script: Array<() => Record<string, unknown>>) {
  const requests: any[] = [];
  const client = {
    chat: { completions: { create: async (request: any) => {
      const step = script[requests.length];
      requests.push(request);
      if (!step) throw new Error("mock 脚本已用完");
      return { choices: [{ message: step() }], usage: { total_tokens: 100 } };
    } } },
  } as any;
  return { client, requests };
}

test("工具过程随终答落盘，load() 可回放，续聊时从模型上下文剥离", async () => {
  const dir = await tempDir("dsh-process-");
  const store = new SessionStore({ dir, sessionId: "p1" });
  const tools = new ToolRegistry();
  tools.register(makeEchoTool());

  const first = makeMockClient([
    () => ({
      content: "我先看一下",
      tool_calls: [{ id: "c1", type: "function", function: { name: "inspect", arguments: '{"path":"12.jpg"}' } }],
    }),
    () => ({ content: "看完了" }),
  ]);
  const agent1 = new Agent({ model: "t", systemPrompt: "规则", client: first.client, tools, sessionStore: store });
  await agent1.run("看一下 12.jpg");

  const raw = await fs.readFile(store.filePath, "utf-8");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  const final = lines.find((line) => line.role === "assistant" && line.content === "看完了") as any;
  expect(final.process).toEqual([
    { llmContent: "我先看一下", toolCalls: [{ name: "inspect", arguments: '{"path":"12.jpg"}' }] },
  ]);

  const loaded = await store.load();
  expect(formatHistoryReplay(loaded.messages)).toEqual([
    "你> 看一下 12.jpg",
    "助手> 我先看一下",
    '助手> [工具调用] inspect({"path":"12.jpg"})',
    "助手> 看完了",
  ]);

  // 第二个进程续聊：过程字段与中间工具消息都不能进请求（严格服务端会拒收/上下文膨胀）
  const second = makeMockClient([() => ({ content: "接着聊" })]);
  const agent2 = new Agent({ model: "t", systemPrompt: "规则", client: second.client, tools, sessionStore: store });
  await agent2.run("继续");
  const sent = JSON.stringify(second.requests[0]!.messages);
  expect(sent).not.toContain('"process"');
  expect(sent).not.toContain('"tool_calls"');
  expect(sent).toContain("看完了");

  await fs.rm(dir, { recursive: true, force: true });
});

test("内容过滤导致终答为空时，过程仍落盘并可回放", async () => {
  const dir = await tempDir("dsh-process-filter-");
  const store = new SessionStore({ dir, sessionId: "p2" });
  const tools = new ToolRegistry();
  tools.register(makeEchoTool());

  const { client } = makeMockClient([
    () => ({
      content: "我先看一下",
      tool_calls: [{ id: "c1", type: "function", function: { name: "inspect", arguments: '{"path":"12.jpg"}' } }],
    }),
    () => { throw new Error("<400> InternalError.Algo.DataInspectionFailed: Output data may contain inappropriate content."); },
  ]);
  const agent = new Agent({ model: "t", systemPrompt: "规则", client, tools, sessionStore: store });
  const result = await agent.run("看一下 12.jpg");
  expect(result.stopReason).toBe("content_filter");

  const loaded = await store.load();
  expect(formatHistoryReplay(loaded.messages)).toEqual([
    "你> 看一下 12.jpg",
    "助手> 我先看一下",
    '助手> [工具调用] inspect({"path":"12.jpg"})',
    "助手> （没有生成内容 · 内容被过滤，尚未完成判断）",
  ]);

  await fs.rm(dir, { recursive: true, force: true });
});
