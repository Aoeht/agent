import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { SessionStore } from "../src/core/session_store";
import { SessionManager } from "../src/server/sessions";
import { ServerEventSchema } from "../src/server/protocol";
import type { RunEndEvent } from "../src/core/events";

const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const call = { id: "c1", type: "function", function: { name: "inspect", arguments: "{}" } };
function reply(content: string | null, finish_reason = "stop", extra = {}) {
  return { choices: [{ finish_reason, message: { content, ...extra } }], usage };
}
function chunks(parts: unknown[], failure?: Error) {
  return (async function* () {
    for (const part of parts) yield part;
    if (failure) throw failure;
  })();
}
function delta(value: object, finish_reason: string | null = null) {
  return { choices: [{ index: 0, delta: value, finish_reason }] };
}
type Config = ConstructorParameters<typeof Agent>[0];
function setup(script: Array<unknown | (() => unknown)>, config: Partial<Config> = {}) {
  let requests = 0;
  const payloads: any[] = [];
  const client = { chat: { completions: { create: async (request: unknown) => {
    payloads.push(request);
    const item = script[requests++];
    if (item === undefined) throw new Error("Unexpected model request");
    return typeof item === "function" ? item() : item;
  } } } };
  const agent = new Agent({ model: "test", systemPrompt: "test", maxRetries: 0, ...config, client: client as any });
  const events: RunEndEvent[] = [];
  agent.events.on("run_end", (event) => events.push(event));
  return { agent, events, payloads, requestCount: () => requests };
}
function inspectionTool(onCall: () => void = () => {}) {
  const tools = new ToolRegistry();
  tools.register({ name: "inspect", description: "test", parameters: { type: "object" },
    execute: async () => {
      onCall();
      return { sources: [{ title: "网页证据", url: "https://example.test/" }], content: "已采集" };
    } });
  return tools;
}
const dirs: string[] = [];
async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-outcome-"));
  dirs.push(dir);
  return new SessionStore({ dir, sessionId: "test" });
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("任务状态与运行终态", () => {
  test("正常文本只标已回答，不声称独立验收；兼容省略结束原因的服务商", async () => {
    const { agent, events } = setup([{ choices: [{ message: { content: "答案" } }], usage }]);
    const result = await agent.run("问");
    expect(result).toMatchObject({ success: true, runStatus: "completed", taskStatus: "answered", stopReason: "answer" });
    expect(events).toHaveLength(1);
    expect(ServerEventSchema.parse({ type: "run_end", ...events[0] }).type).toBe("run_end");
  });
  for (const content of [null, "", "  \n"]) {
    test(`空回答 ${JSON.stringify(content)} 不成功`, async () => {
      const { agent } = setup([reply(content)]);
      expect(await agent.run("问")).toMatchObject({ success: false, stopReason: "empty_response" });
    });
  }
  for (const status of ["pending", "in_progress", "completed"] as const) {
    test(`计划 ${status} 决定是否仍有待办`, async () => {
      const planStore = new PlanStore();
      const tools = inspectionTool(() => planStore.replace([{ content: "核查", status }]));
      const { agent } = setup([reply(null, "tool_calls", { tool_calls: [call] }), reply("已完成")], { tools, planStore });
      const result = await agent.run("核查");
      expect(result.success).toBe(status === "completed");
      expect(result.stopReason).toBe(status === "completed" ? "answer" : "plan_incomplete");
      expect(result.runStatus).toBe("completed");
    });
  }
  test("达到迭代上限的收尾文本是部分结果", async () => {
    const { agent } = setup([reply(null, "tool_calls", { tool_calls: [call] }), reply("目前发现")],
      { tools: inspectionTool(), maxIterations: 1 });
    expect(await agent.run("核查")).toMatchObject({
      success: false, stopReason: "iteration_limit", finalAnswer: "目前发现", totalTokens: 20, toolCallsCount: 1,
    });
  });
  test("迭代上限为 0 时不设上限，多轮工具调用后仍能完成", async () => {
    const { agent, requestCount } = setup([
      reply(null, "tool_calls", { tool_calls: [call] }),
      reply(null, "tool_calls", { tool_calls: [call] }),
      reply(null, "tool_calls", { tool_calls: [call] }),
      reply("完成"),
    ], { tools: inspectionTool(), maxIterations: 0 });
    expect(await agent.run("核查")).toMatchObject({
      success: true, stopReason: "answer", finalAnswer: "完成", toolCallsCount: 3,
    });
    expect(requestCount()).toBe(4);
  });
  test("迭代上限 setter 接受 0（不限），负数归一为不限", () => {
    const { agent } = setup([]);
    agent.setMaxIterations(0);
    expect(agent.maxIterations).toBe(0);
    agent.setMaxIterations(-3);
    expect(agent.maxIterations).toBe(0);
  });
  test("预算耗尽后收尾仍未完成，保留预算原因", async () => {
    const { agent } = setup([reply(null, "tool_calls", { tool_calls: [call] }), reply("部分结论")],
      { tools: inspectionTool(), budget: { maxToolCalls: 1 } });
    expect(await agent.run("核查")).toMatchObject({
      success: false, stopReason: "budget_exceeded", budgetStopped: "max_tool_calls", finalAnswer: "部分结论",
    });
  });
  test("运行前取消也发一个 run_end，不调用模型", async () => {
    const { agent, events, requestCount } = setup([]);
    const result = await agent.run("问", { signal: AbortSignal.abort() });
    expect(result.stopReason).toBe("cancelled");
    expect(events).toHaveLength(1);
    expect(requestCount()).toBe(0);
  });
  test("请求中取消保留先前工具证据与次数", async () => {
    const controller = new AbortController();
    const { agent, events } = setup([reply(null, "tool_calls", { tool_calls: [call] }), () => {
      controller.abort(); throw new Error("Aborted");
    }], { tools: inspectionTool() });
    const result = await agent.run("问", { signal: controller.signal });
    expect(result).toMatchObject({ success: false, stopReason: "cancelled", toolCallsCount: 1, totalTokens: 10 });
    expect(result.citations).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
  test("普通接口错误不会被猜成拒绝，仍发 run_end", async () => {
    const { agent, events } = setup([() => { throw new Error("抱歉，服务暂时不能连接"); }]);
    expect(await agent.run("问")).toMatchObject({ runStatus: "failed", stopReason: "error", errorMessage: "抱歉，服务暂时不能连接" });
    expect(events).toHaveLength(1);
  });
  test("开轮初始化失败仍有明确终态", async () => {
    const { agent, events, requestCount } = setup([], { onTurnStart: async () => { throw new Error("检查点失败"); } });
    expect(await agent.run("问")).toMatchObject({ success: false, stopReason: "error", errorMessage: "检查点失败" });
    expect(events).toHaveLength(1);
    expect(requestCount()).toBe(0);
  });
});

describe("显式拒绝、过滤和截断", () => {
  for (const [finish, extra, expected] of [
    ["stop", { refusal: "无法分析这张图片" }, "model_refusal"],
    ["content_filter", {}, "content_filter"],
    ["length", {}, "output_truncated"],
  ] as const) {
    test(`${expected} 不执行同响应的工具，也不自动重试`, async () => {
      let executions = 0;
      const { agent, requestCount } = setup([reply("部分内容", finish, { ...extra, tool_calls: [call] })],
        { tools: inspectionTool(() => executions++) });
      const result = await agent.run("核查");
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe(expected);
      expect(result.finishReason).toBe(finish);
      expect(result.finalAnswer).toBe("部分内容");
      expect(executions).toBe(0);
      expect(requestCount()).toBe(1);
    });
  }
  test("正文为空、refusal 有文本时显示拒绝内容并保留证据，刷新仍可读", async () => {
    const sessionStore = await store();
    const { agent, requestCount } = setup([
      reply(null, "tool_calls", { tool_calls: [call] }),
      reply(null, "stop", { refusal: "无法分析这张图片" }),
    ], { tools: inspectionTool(), sessionStore });
    const result = await agent.run("核查");
    expect(result).toMatchObject({ taskStatus: "blocked", stopReason: "model_refusal", finalAnswer: "无法分析这张图片" });
    expect(result.citations).toHaveLength(1);
    expect(requestCount()).toBe(2); // 拒绝后也不启动后台模型摘要
    const manager = new SessionManager({ sessionDir: sessionStore.dir } as any);
    const history = await manager.history("test");
    expect(history.messages.at(-1)?.outcome?.stopReason).toBe("model_refusal");
    expect(history.messages.at(-1)?.citations).toHaveLength(1);
    const resumed = setup([reply("继续")], { sessionStore });
    await resumed.agent.run("继续");
    expect(resumed.payloads[0].messages.every((m: any) => !("outcome" in m) && !("citations" in m))).toBe(true);
  });
  test("空过滤结果落盘后仍能恢复状态", async () => {
    const sessionStore = await store();
    const { agent } = setup([reply(null, "content_filter")], { sessionStore });
    await agent.run("问");
    const manager = new SessionManager({ sessionDir: sessionStore.dir } as any);
    expect((await manager.history("test")).messages.at(-1)?.outcome?.stopReason).toBe("content_filter");
  });
  test("包含拒绝措辞的普通回答不误判", async () => {
    const { agent } = setup([reply("不能仅凭色情内容认定诈骗；抱歉，目前证据不足。")]);
    expect((await agent.run("问")).success).toBe(true);
  });
  for (const error of [
    { code: "content_policy_violation", status: 400 },
    { error: { code: "content_filter" }, status: 400 },
    { error: { innererror: { code: "ResponsibleAIPolicyViolation" } }, status: 400 },
  ]) {
    test(`策略错误码 ${JSON.stringify(error)} 被识别且不重试`, async () => {
      const { agent, requestCount } = setup([() => { throw error; }], { maxRetries: 2 });
      expect(await agent.run("问")).toMatchObject({ success: false, stopReason: "content_filter", taskStatus: "blocked" });
      expect(requestCount()).toBe(1);
    });
  }
  test("强制收尾遭拒绝时不再发摘工具重试请求", async () => {
    const { agent, requestCount } = setup([
      reply(null, "tool_calls", { tool_calls: [call] }), reply(null, "stop", { refusal: "无法回答" }),
    ], { tools: inspectionTool(), maxIterations: 1 });
    expect((await agent.run("问")).stopReason).toBe("model_refusal");
    expect(requestCount()).toBe(2);
  });
});

describe("流式返回", () => {
  test("累积 delta.refusal，识别仅有结束原因的 chunk 和独立 usage", async () => {
    const { agent } = setup([chunks([
      delta({ refusal: "无法" }), delta({ refusal: "回答" }),
      { choices: [{ finish_reason: "stop" }] }, { choices: [], usage },
    ])], { stream: true });
    expect(await agent.run("问")).toMatchObject({
      success: false, stopReason: "model_refusal", refusal: "无法回答", finalAnswer: "无法回答", totalTokens: 10,
    });
  });
  for (const reason of ["length", "content_filter"]) {
    test(`${reason} 的残缺工具参数不会进入 JSON 解析或执行`, async () => {
      let executions = 0;
      const { agent } = setup([chunks([
        delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "inspect", arguments: '{"x":' } }] }),
        delta({}, reason), { choices: [], usage },
      ])], { stream: true, tools: inspectionTool(() => executions++) });
      const result = await agent.run("问");
      expect(result.stopReason).toBe(reason === "length" ? "output_truncated" : "content_filter");
      expect(executions).toBe(0);
    });
  }
  test("正常流式文本仍成功并保留 usage", async () => {
    const { agent } = setup([chunks([delta({ content: "答案" }), delta({}, "stop"), { choices: [], usage }])], { stream: true });
    expect(await agent.run("问")).toMatchObject({ success: true, finalAnswer: "答案", finishReason: "stop", totalTokens: 10 });
  });
  test("流式输出中途收到策略异常，保留文字和真实用量", async () => {
    const failure = Object.assign(new Error("filtered"), { code: "content_filter" });
    const { agent, requestCount } = setup([chunks([delta({ content: "部分内容" }), { choices: [], usage }], failure)],
      { stream: true, maxRetries: 2 });
    expect(await agent.run("问")).toMatchObject({ stopReason: "content_filter", finalAnswer: "部分内容", totalTokens: 10 });
    expect(requestCount()).toBe(1);
  });
  test("正常流式工具执行一次，再给完整文本", async () => {
    let executions = 0;
    const { agent } = setup([
      chunks([delta({ tool_calls: [{ ...call, index: 0 }] }), delta({}, "tool_calls")]),
      chunks([delta({ content: "结果" }), delta({}, "stop")]),
    ], { stream: true, tools: inspectionTool(() => executions++) });
    expect((await agent.run("问")).success).toBe(true);
    expect(executions).toBe(1);
  });
  for (const failure of [undefined, new Error("断线")]) {
    test(`流未收到结束标记 ${failure ? "抛错" : "静默结束"} 保留文字且不重试`, async () => {
      const { agent, events, requestCount } = setup([chunks([delta({ content: "部分答案" })], failure)],
        { stream: true, maxRetries: 2 });
      expect(await agent.run("问")).toMatchObject({ success: false, stopReason: "incomplete_stream", finalAnswer: "部分答案" });
      expect(events).toHaveLength(1);
      expect(requestCount()).toBe(1);
    });
  }
});
