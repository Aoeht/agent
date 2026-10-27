// 工具级事件：执行期间发 tool_start / tool_progress / tool_end，并落进 trace。
// 用假 LLM 客户端跑真实 Agent 循环，不依赖外部 API。
// 运行：bun test tests/tool_events.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { defineTool } from "../src/core/types";
import { TraceRecorder } from "../src/core/trace";

/** 假客户端：第一轮返回 tool_call，第二轮返回最终答案 */
function mockClient(toolName: string) {
  const requests: any[] = [];
  const client: any = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          const first = requests.length === 1;
          return {
            choices: [
              {
                message: first
                  ? {
                      content: null,
                      tool_calls: [
                        { id: "call-1", type: "function", function: { name: toolName, arguments: "{}" } },
                      ],
                    }
                  : { content: "完成" },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
  return { client, requests };
}

async function runWith(
  execute: () => Promise<unknown>
): Promise<{ events: Array<{ type: string; payload: any }>; traceLines: any[] }> {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: "probe_tool",
      description: "测试用工具",
      schema: z.object({}),
      execute,
    })
  );
  const { client } = mockClient("probe_tool");
  const agent = new Agent({
    model: "t",
    systemPrompt: "规则",
    client,
    tools: registry,
    // 心跳缩短到 40ms，测试不必等 5 秒
    toolProgressIntervalMs: 40,
  });
  const events: Array<{ type: string; payload: any }> = [];
  agent.events.on("tool_start", (payload) => events.push({ type: "tool_start", payload }));
  agent.events.on("tool_progress", (payload) => events.push({ type: "tool_progress", payload }));
  agent.events.on("tool_end", (payload) => events.push({ type: "tool_end", payload }));

  const traceDir = await fs.mkdtemp(path.join(tmpdir(), "tool-events-trace-"));
  const trace = new TraceRecorder(traceDir, "events");
  trace.attach(agent.events);

  await agent.run("跑一下");
  const traceLines = (await fs.readFile(trace.filePath, "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  await fs.rm(traceDir, { recursive: true, force: true });
  return { events, traceLines };
}

test("执行期间发 start → progress → end，callId 与 tool_call id 一致", async () => {
  const { events, traceLines } = await runWith(async () => {
    await Bun.sleep(300);
    return { ok: true };
  });

  const types = events.map((event) => event.type);
  expect(types[0]).toBe("tool_start");
  expect(types.at(-1)).toBe("tool_end");

  const progress = events.filter((event) => event.type === "tool_progress");
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.at(-1)!.payload.elapsedMs).toBeGreaterThan(0);
  // 心跳的耗时单调递增（按顺序发出的）
  const elapsed = progress.map((event) => event.payload.elapsedMs as number);
  expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));

  const start = events[0]!.payload;
  expect(start.callId).toBe("call-1");
  expect(start.name).toBe("probe_tool");

  const end = events.at(-1)!.payload;
  expect(end.callId).toBe("call-1");
  expect(end.ok).toBe(true);
  expect(end.durationMs).toBeGreaterThanOrEqual(250);

  const traced = traceLines.map((line) => line.type);
  expect(traced).toContain("tool_start");
  expect(traced).toContain("tool_progress");
  expect(traced).toContain("tool_end");
});

test("工具抛错时 tool_end.ok 为 false（错误观测被识别）", async () => {
  const { events } = await runWith(async () => {
    throw new Error("boom");
  });

  const end = events.at(-1)!;
  expect(end.type).toBe("tool_end");
  expect(end.payload.ok).toBe(false);
  expect(events.some((event) => event.type === "tool_start")).toBe(true);
});
