import { describe, expect, test } from "bun:test";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import {
  parseThinkingEffort,
  thinkingVendorFor,
  requiresReasoningThread,
  thinkingEffortPatch,
} from "../src/utils/thinking_effort";
import type { ThinkingEffort } from "../src/utils/thinking_effort";

describe("parseThinkingEffort", () => {
  test("只认列出的字面量，其余落回 default", () => {
    expect(parseThinkingEffort(undefined)).toBe("default");
    expect(parseThinkingEffort("")).toBe("default");
    expect(parseThinkingEffort("  HIGH ")).toBe("high");
    expect(parseThinkingEffort("Off")).toBe("off");
    expect(parseThinkingEffort("max")).toBe("default");
    expect(parseThinkingEffort("65536")).toBe("default");
  });
});

describe("thinkingVendorFor / requiresReasoningThread", () => {
  test("按模型名识别厂商", () => {
    expect(thinkingVendorFor("qwen3.8-flash")).toBe("qwen");
    expect(thinkingVendorFor("qwen-plus-latest")).toBe("qwen");
    expect(thinkingVendorFor("glm-5.2")).toBe("glm");
    expect(thinkingVendorFor("deepseek-chat")).toBe("deepseek");
    expect(thinkingVendorFor("gpt-4o")).toBe("none");
  });

  test("只有 deepseek 要求回传 reasoning_content", () => {
    expect(requiresReasoningThread("deepseek-reasoner")).toBe(true);
    expect(requiresReasoningThread("glm-5.2")).toBe(false);
    expect(requiresReasoningThread("qwen3.6-plus")).toBe(false);
  });
});

describe("thinkingEffortPatch", () => {
  test("default/缺省不下发任何字段", () => {
    expect(thinkingEffortPatch("qwen3.8-flash", "default")).toEqual({});
    expect(thinkingEffortPatch("qwen3.8-flash", undefined)).toEqual({});
    expect(thinkingEffortPatch("gpt-4o", "default")).toEqual({});
  });

  test("qwen：off 关思考；流式下按档位给 thinking_budget；非流式跳过并给 note", () => {
    expect(thinkingEffortPatch("qwen3.8-flash", "off")).toEqual({ params: { enable_thinking: false } });
    expect(thinkingEffortPatch("qwen3.8-flash", "high", { stream: true }))
      .toEqual({ params: { enable_thinking: true, thinking_budget: 32768 } });
    expect(thinkingEffortPatch("qwen3.8-flash", "low", { stream: true }))
      .toEqual({ params: { enable_thinking: true, thinking_budget: 4096 } });
    const skipped = thinkingEffortPatch("qwen3.8-flash", "medium", { stream: false });
    expect(skipped.params).toBeUndefined();
    expect(skipped.note).toContain("流式");
  });

  test("glm：开关粒度；GLM-5.3 起不支持关闭", () => {
    expect(thinkingEffortPatch("glm-5.2", "off")).toEqual({ params: { thinking: { type: "disabled" } } });
    expect(thinkingEffortPatch("glm-5.2", "high", { stream: false }))
      .toEqual({ params: { thinking: { type: "enabled" } }, note: expect.stringContaining("等价") });
    const five3 = thinkingEffortPatch("glm-5.3-flash", "off");
    expect(five3.params).toBeUndefined();
    expect(five3.note).toContain("不支持关闭");
  });

  test("deepseek：off 关思考；low/high 带 effort；medium 只开思考落默认档", () => {
    expect(thinkingEffortPatch("deepseek-chat", "off"))
      .toEqual({ params: { thinking: { type: "disabled" } } });
    expect(thinkingEffortPatch("deepseek-chat", "high", { stream: true }))
      .toEqual({ params: { thinking: { type: "enabled" }, reasoning_effort: "high" } });
    expect(thinkingEffortPatch("deepseek-reasoner", "low", { stream: false }))
      .toEqual({ params: { thinking: { type: "enabled" }, reasoning_effort: "low" } });
    const medium = thinkingEffortPatch("deepseek-chat", "medium");
    expect(medium.params).toEqual({ thinking: { type: "enabled" } });
    expect(medium.note).toContain("默认档");
  });

  test("无参数厂商只给 note 不注入，防严格服务端拒收未知字段", () => {
    const patch = thinkingEffortPatch("gpt-4o", "high", { stream: true });
    expect(patch.params).toBeUndefined();
    expect(patch.note).toContain("没有思考程度参数");
  });
});

// ---------- Agent 级接线：请求体确实带上映射字段 / DeepSeek 回传 reasoning_content ----------

const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const call = { id: "c1", type: "function", function: { name: "inspect", arguments: "{}" } };

function reply(content: string | null, finish_reason = "stop", extra = {}) {
  return { choices: [{ finish_reason, message: { content, ...extra } }], usage };
}

function chunks(parts: unknown[]) {
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

function delta(value: object, finish_reason: string | null = null) {
  return { choices: [{ index: 0, delta: value, finish_reason }] };
}

function setup(script: unknown[], config: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  let requests = 0;
  const payloads: any[] = [];
  const client = { chat: { completions: { create: async (request: unknown) => {
    payloads.push(request);
    const item = script[requests++];
    if (item === undefined) throw new Error("Unexpected model request");
    return item;
  } } } };
  const tools = new ToolRegistry();
  tools.register({ name: "inspect", description: "test", parameters: { type: "object" },
    execute: async () => ({ content: "已采集" }) });
  const agent = new Agent({
    model: "test", systemPrompt: "test", maxRetries: 0, tools, ...config, client: client as any,
  });
  return { agent, payloads };
}

describe("Agent 思考程度注入", () => {
  test("qwen 流式 + high：请求体带 enable_thinking 与 thinking_budget", async () => {
    const { agent, payloads } = setup(
      [chunks([delta({ content: "你好" }), delta({}, "stop")])],
      { model: "qwen3.8-flash", thinkingEffort: "high", stream: true }
    );
    await agent.run("hi");
    expect(payloads[0].enable_thinking).toBe(true);
    expect(payloads[0].thinking_budget).toBe(32768);
  });

  test("qwen 非流式 + high：跳过注入（DashScope 思考模式仅流式可用）", async () => {
    const { agent, payloads } = setup(
      [reply("你好")],
      { model: "qwen3.8-flash", thinkingEffort: "high", stream: false }
    );
    await agent.run("hi");
    expect(payloads[0].enable_thinking).toBeUndefined();
    expect(payloads[0].thinking_budget).toBeUndefined();
  });

  test("qwen + off：显式关思考", async () => {
    const { agent, payloads } = setup(
      [reply("你好")],
      { model: "qwen3.8-flash", thinkingEffort: "off", stream: false }
    );
    await agent.run("hi");
    expect(payloads[0].enable_thinking).toBe(false);
  });

  test("default 不改请求体；无参数厂商不注入未知字段", async () => {
    for (const [model, effort] of [["glm-5.2", "default"], ["gpt-4o", "high"]] as const) {
      const { agent, payloads } = setup([reply("你好")], { model, thinkingEffort: effort as ThinkingEffort });
      await agent.run("hi");
      expect(payloads[0].enable_thinking).toBeUndefined();
      expect(payloads[0].thinking).toBeUndefined();
      expect(payloads[0].reasoning_effort).toBeUndefined();
    }
  });

  test("glm / deepseek 档位落到对应字段", async () => {
    const glm = setup([reply("你好")], { model: "glm-5.2", thinkingEffort: "low" });
    await glm.agent.run("hi");
    expect(glm.payloads[0].thinking).toEqual({ type: "enabled" });

    const ds = setup([reply("你好")], { model: "deepseek-chat", thinkingEffort: "high" });
    await ds.agent.run("hi");
    expect(ds.payloads[0].thinking).toEqual({ type: "enabled" });
    expect(ds.payloads[0].reasoning_effort).toBe("high");
  });
});

describe("Agent reasoning_content 回传（DeepSeek 思考模式 + tools 的硬约束）", () => {
  const script = [
    reply(null, "tool_calls", { reasoning_content: "先查一下再答", tool_calls: [call] }),
    reply("完成", "stop"),
  ];

  test("deepseek：带 tool_calls 的 assistant 消息原样回传 reasoning_content", async () => {
    const { agent, payloads } = setup(script, { model: "deepseek-chat", stream: false });
    await agent.run("hi");
    const assistant = payloads[1].messages.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === "assistant" && Array.isArray(m.tool_calls)
    );
    expect(assistant?.reasoning_content).toBe("先查一下再答");
  });

  test("qwen：不回传（DashScope 不要求，避免污染历史）", async () => {
    const { agent, payloads } = setup(script, { model: "qwen3.8-flash", stream: false });
    await agent.run("hi");
    const assistant = payloads[1].messages.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === "assistant" && Array.isArray(m.tool_calls)
    );
    expect(assistant?.reasoning_content).toBeUndefined();
  });
});
