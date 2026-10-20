// tests/ask_user.test.ts
// 主动澄清（模型发起询问）链路测试：
//   - ask_user 工具：schema 校验、通道缺失（非交互）降级、回答/拒答透传、异常兜底
//   - 注册：registerSessionTools 内置注册
//   - UiBridge.askUser：human_input_request 事件发布 → resolveInput 应答 → 文本回传；
//     无运行上下文/超时 → null（等同拒答）
// 运行: bun test ./tests/ask_user.test.ts
import { describe, test, expect } from "bun:test";
import { UiBridge } from "../src/server/bridge";
import { inRunSession } from "../src/server/run_context";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { registerSessionTools } from "../src/bootstrap";
import { createAskUserTool } from "../src/tools/ask_user";
import type { ServerEvent } from "../src/server/protocol";
import type { ToolRuntime } from "../src/core/types";

function fakeEmit() {
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];
  return {
    events,
    emit: (sessionId: string, event: ServerEvent) => {
      events.push({ sessionId, event });
    },
  };
}

/** 直接构造的运行时通道。注意：须在调用前创建 */
function makeRuntime(handler?: (prompt: string) => Promise<string | null>): ToolRuntime {
  const controller = new AbortController();
  const signal = controller.signal;
  return {
    signal,
    askUser: handler ?? (async () => "生产环境"),
  };
}

const question = "部署目标是生产环境还是测试环境？";

describe("ask_user 工具", () => {
  test("有 askUser 通道：问题透传，返回用户自由文本回答", async () => {
    const tool = createAskUserTool();
    let seen = "";
    const runtime = makeRuntime(async (prompt) => {
      seen = prompt;
      return "生产环境";
    });
    const result = (await tool.execute({ question }, runtime)) as any;
    expect(seen).toBe(question);
    expect(result).toEqual({ ok: true, answer: "生产环境" });
  });

  test("用户拒答（通道返回 null）：ok 仍为 true，answer 为 null，不抛错", async () => {
    const tool = createAskUserTool();
    const runtime = makeRuntime(async () => null);
    const result = (await tool.execute({ question }, runtime)) as any;
    expect(result).toEqual({ ok: true, answer: null });
  });

  test("无通道（非交互模式）：返回可读错误，模型可据已有信息降级，不中断回合", async () => {
    const tool = createAskUserTool();
    const result = (await tool.execute({ question })) as any;
    expect(result.ok).toBe(false);
    expect(result.answer).toBeNull();
    expect(String(result.error)).toContain("不支持人工澄清");
  });

  test("通道异常：兜底为错误结果而非抛穿", async () => {
    const tool = createAskUserTool();
    const runtime = makeRuntime(async () => {
      throw new Error("连接已断开");
    });
    const result = (await tool.execute({ question }, runtime)) as any;
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("连接已断开");
  });

  test("空/空白 question 被 schema 拒绝", async () => {
    const tool = createAskUserTool();
    await expect(tool.execute({ question: "" })).rejects.toThrow("question");
    await expect(tool.execute({ question: "   " })).rejects.toThrow("question");
    await expect(tool.execute({})).rejects.toThrow("question");
  });

  test("经 registry.execute 透传 runtime 通道", async () => {
    const registry = new ToolRegistry();
    registry.register(createAskUserTool());
    const runtime = makeRuntime(async () => "开发环境的 staging");
    const result = JSON.parse(await registry.execute("ask_user", { question }, runtime));
    expect(result).toEqual({ ok: true, answer: "开发环境的 staging" });
  });
});

describe("registerSessionTools 内置注册", () => {
  test("ask_user 已在会话工具集中，无需额外装配", () => {
    const registry = new ToolRegistry();
    registerSessionTools(registry, {
      skills: [],
      planStore: new PlanStore(),
      sandbox: { backend: "host" as const, reason: "test" },
      sandboxRoot: ".",
    });
    const names = registry.list().map((d) => d.name);
    expect(names).toContain("ask_user");
  });
});

describe("UiBridge.askUser（Web 通道）", () => {
  test("发布 human_input_request 事件，resolveInput 应答回传文本", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);
    const controller = new AbortController();

    const pending = inRunSession("s1", () => bridge.askUser(question, controller.signal));

    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe("s1");
    const published = events[0]!.event;
    expect(published.type).toBe("human_input_request");
    if (published.type === "human_input_request") {
      expect(published.prompt).toBe(question);
      expect(bridge.resolveInput(published.id, "预发环境")).toBe(true);
    }

    expect(await pending).toBe("预发环境");
    expect(bridge.pendingEventsFor("s1")).toHaveLength(0);
  });

  test("无运行上下文且无在飞归因：askUser 直接返回 null", async () => {
    const { emit } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);
    const controller = new AbortController();
    expect(await bridge.askUser(question, controller.signal)).toBeNull();
  });

  test("超时未应答：返回 null（等同拒答），模型自行降级", async () => {
    const { emit } = fakeEmit();
    const bridge = new UiBridge(emit, 30);
    const controller = new AbortController();
    const pending = inRunSession("s1", () => bridge.askUser(question, controller.signal));
    expect(await pending).toBeNull();
    expect(bridge.pendingEventsFor("s1")).toHaveLength(0);
  });
});