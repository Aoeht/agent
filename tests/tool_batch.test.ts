import { describe, expect, test } from "bun:test";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import {
  mapWithConcurrency,
  partitionToolCalls,
  raceWithToolTimeout,
  ToolTimeoutError,
} from "../src/core/tool_batch";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** 可被 AbortSignal 打断的睡眠：signal 触发时 reject（reason 随信号），模拟尊重取消的工具 */
const interruptible = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

describe("partitionToolCalls", () => {
  test("混合批次保序分区：parallelSafe 进并发道，其余进串行道", () => {
    const calls = [
      { id: "u1", function: { name: "run_script", arguments: "{}" } },
      { id: "s1", function: { name: "search_web", arguments: "{}" } },
      { id: "u2", function: { name: "run_script", arguments: "{}" } },
      { id: "s2", function: { name: "read_image", arguments: "{}" } },
    ];
    const safe = new Set(["search_web", "read_image"]);
    const { parallel, serial } = partitionToolCalls(calls, (name) => safe.has(name));
    expect(parallel.map((call) => call.id)).toEqual(["s1", "s2"]);
    expect(serial.map((call) => call.id)).toEqual(["u1", "u2"]);
  });

  test("全安全 → 全并发道；全不安全 → 全串行道", () => {
    const all = (ids: string[]) => ids.map((id) => ({ id, function: { name: "x", arguments: "{}" } }));
    expect(partitionToolCalls(all(["a", "b"]), () => true).serial).toHaveLength(0);
    expect(partitionToolCalls(all(["a", "b"]), () => false).parallel).toHaveLength(0);
  });
});

describe("mapWithConcurrency", () => {
  test("并发上限被严格遵守，结果按输入下标对齐", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const settled = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await delay(25);
      inflight--;
      return value * 10;
    });
    expect(maxInflight).toBe(2);
    expect(settled.map((entry) => entry.status === "fulfilled" ? entry.value : null)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  test("单条失败不拖垮其余（allSettled 语义），空输入直接返回", async () => {
    const settled = await mapWithConcurrency([1, 2, 3], 3, async (value) => {
      if (value === 2) throw new Error("boom");
      return value;
    });
    expect(settled[0]).toMatchObject({ status: "fulfilled", value: 1 });
    expect(settled[1]?.status).toBe("rejected");
    expect(settled[2]).toMatchObject({ status: "fulfilled", value: 3 });
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("raceWithToolTimeout", () => {
  test("死线前完成 → 原值返回", async () => {
    const value = await raceWithToolTimeout((signal) => interruptible(10, signal).then(() => "ok"), {
      toolName: "fast",
      timeoutMs: 5_000,
    });
    expect(value).toBe("ok");
  });

  test("无视信号的挂死工具 → 死线抛 ToolTimeoutError，附工具名与时长", async () => {
    expect.assertions(3);
    try {
      await raceWithToolTimeout(() => delay(5_000).then(() => "never"), {
        toolName: "hung",
        timeoutMs: 40,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ToolTimeoutError);
      expect((error as ToolTimeoutError).toolName).toBe("hung");
      expect((error as ToolTimeoutError).timeoutMs).toBe(40);
    }
  });

  test("尊重信号的工具 → 超时触发派生信号，工具自身中止", async () => {
    expect.assertions(1);
    try {
      await raceWithToolTimeout((signal) => interruptible(5_000, signal).then(() => "never"), {
        toolName: "polite",
        timeoutMs: 40,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ToolTimeoutError);
    }
  });

  test("外层取消收敛为该原因 rejection（不是超时），挂死工具也不能把取消挂住", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("用户取消")), 20);
    expect.assertions(1);
    try {
      await raceWithToolTimeout(() => delay(5_000).then(() => "never"), {
        toolName: "hung",
        timeoutMs: 5_000,
        outer: controller.signal,
      });
    } catch (error) {
      expect((error as Error).message).toBe("用户取消");
    }
  });

  test("入口时外层已取消 → 立即 rejection，不启动执行体", async () => {
    let started = 0;
    await raceWithToolTimeout(() => { started++; return delay(1_000); }, {
      toolName: "x",
      timeoutMs: 5_000,
      outer: AbortSignal.abort(new Error("已取消")),
    }).catch(() => {});
    expect(started).toBe(0);
  });
});

// ─── Agent 集成：双车道调度与死线落在真实 runLoop 里 ───

const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
function reply(content: string | null, finish_reason = "stop", extra = {}) {
  return { choices: [{ finish_reason, message: { content, ...extra } }], usage };
}
const toolCall = (id: string, name: string) => ({ id, type: "function", function: { name, arguments: "{}" } });
type Config = ConstructorParameters<typeof Agent>[0];
function setup(script: unknown[], config: Partial<Config> = {}) {
  let requests = 0;
  const payloads: any[] = [];
  const client = { chat: { completions: { create: async (request: unknown) => {
    payloads.push(request);
    const item = script[requests++];
    if (item === undefined) throw new Error("Unexpected model request");
    return item;
  } } } };
  const agent = new Agent({ model: "test", systemPrompt: "test", maxRetries: 0, ...config, client: client as any });
  return { agent, payloads };
}

function makeTools(log: string[], timings: Record<string, number>, opts: { respectSignal?: boolean } = {}) {
  const tools = new ToolRegistry();
  const track = (name: string) => async (_args: unknown, runtime?: { signal?: AbortSignal }) => {
    log.push(`${name}:start`);
    if (opts.respectSignal) await interruptible(timings[name]!, runtime?.signal);
    else await delay(timings[name]!);
    log.push(`${name}:end`);
    return `${name}-done`;
  };
  tools.register({ name: "safe_a", description: "", parameters: { type: "object" }, parallelSafe: true, execute: track("safe_a") });
  tools.register({ name: "safe_b", description: "", parameters: { type: "object" }, parallelSafe: true, execute: track("safe_b") });
  tools.register({ name: "slow_safe", description: "", parameters: { type: "object" }, parallelSafe: true, execute: track("slow_safe") });
  tools.register({ name: "writer", description: "", parameters: { type: "object" }, parallelSafe: false, execute: track("writer") });
  return tools;
}

describe("Agent 双车道调度", () => {
  test("混合批次：只读工具并发且与副作用工具重叠，副作用工具保持声明顺序", async () => {
    const log: string[] = [];
    const timings: Record<string, number> = { safe_a: 80, safe_b: 80, writer: 30 };
    const { agent } = setup([
      reply(null, "tool_calls", { tool_calls: [toolCall("1", "safe_a"), toolCall("2", "writer"), toolCall("3", "safe_b")] }),
      reply("完成"),
    ], { tools: makeTools(log, timings) });
    const result = await agent.run("查证并落盘");
    expect(result.success).toBe(true);

    // 重叠：writer 与 safe_a 互相都在对方的起止之间（旧实现整批串行时两个 start 不会交叠）。
    // 串行道先于并发道创建，writer:start 可能同步先落，所以用双向交叠断言，不比谁先 start
    expect(log.indexOf("writer:start")).toBeLessThan(log.indexOf("safe_a:end"));
    expect(log.indexOf("safe_a:start")).toBeLessThan(log.indexOf("writer:end"));
    // 并发：两个只读工具同时起飞
    expect(log.indexOf("safe_b:start")).toBeLessThan(log.indexOf("safe_a:end"));
  });

  test("同批两个副作用工具互不重叠、按声明顺序执行", async () => {
    const log: string[] = [];
    const timings: Record<string, number> = { writer: 40 };
    const { agent } = setup([
      reply(null, "tool_calls", { tool_calls: [toolCall("1", "writer"), toolCall("2", "writer")] }),
      reply("完成"),
    ], { tools: makeTools(log, timings) });
    const result = await agent.run("顺序执行");
    expect(result.success).toBe(true);
    expect(log.indexOf("writer:start")).toBeLessThan(log.indexOf("writer:end"));
    expect(log.indexOf("writer:end")).toBeLessThan(log.lastIndexOf("writer:start"));
  });

  test("并发上限：一批 6 个只读调用，宽度 2 时同时在飞 ≤ 2", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "fanout", description: "", parameters: { type: "object" }, parallelSafe: true,
      execute: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await delay(25);
        inflight--;
        return "ok";
      },
    });
    const { agent } = setup([
      reply(null, "tool_calls", { tool_calls: Array.from({ length: 6 }, (_, i) => toolCall(`${i}`, "fanout")) }),
      reply("完成"),
    ], { tools, toolConcurrencyLimit: 2 });
    const result = await agent.run("扇出");
    expect(result.success).toBe(true);
    expect(maxInflight).toBe(2);
  });
});

describe("Agent per-tool 死线", () => {
  test("Agent 级死线：挂死工具转 error observation，run 继续走到终答", async () => {
    const log: string[] = [];
    const { agent, payloads } = setup([
      reply(null, "tool_calls", { tool_calls: [toolCall("1", "safe_a")] }),
      reply("已绕过卡死的工具"),
    ], { tools: makeTools(log, { safe_a: 5_000 }), toolTimeoutMs: 50 });
    const result = await agent.run("查证");
    expect(result).toMatchObject({ success: true, stopReason: "answer", finalAnswer: "已绕过卡死的工具" });
    // 死线信息进了下一轮请求的 tool 消息，模型据此换路子
    const toolMessages = payloads[1].messages.filter((message: any) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toContain("超时");
    expect(toolMessages[0].content).toContain("safe_a");
  });

  test("工具声明 timeoutMs: 0 → 显式豁免全局死线，慢工具正常完成", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "self_managed", description: "", parameters: { type: "object" },
      parallelSafe: true, timeoutMs: 0,
      execute: async () => { await delay(120); return "终于完成"; },
    });
    const { agent } = setup([
      reply(null, "tool_calls", { tool_calls: [toolCall("1", "self_managed")] }),
      reply("完成"),
    ], { tools, toolTimeoutMs: 30 });
    expect(await agent.run("慢任务")).toMatchObject({ success: true, finalAnswer: "完成" });
  });

  test("工具声明自有死线 → 优先于 Agent 级，且 Agent 级关闭时也生效", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "own_deadline", description: "", parameters: { type: "object" },
      parallelSafe: true, timeoutMs: 40,
      execute: async () => { await delay(5_000); return "never"; },
    });
    const { agent } = setup([
      reply(null, "tool_calls", { tool_calls: [toolCall("1", "own_deadline")] }),
      reply("换个方式"),
    ], { tools });
    expect(await agent.run("查证")).toMatchObject({ success: true, finalAnswer: "换个方式" });
  });
});
