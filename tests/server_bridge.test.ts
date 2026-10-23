// tests/server_bridge.test.ts
import { describe, test, expect } from "bun:test";
import { UiBridge } from "../src/server/bridge";
import { inRunSession } from "../src/server/run_context";
import type { ServerEvent } from "../src/server/protocol";

/** 收集事件的假 emit：sessionId → 事件列表 */
function fakeEmit() {
  const events: Array<{ sessionId: string; event: ServerEvent }> = [];
  return {
    events,
    emit: (sessionId: string, event: ServerEvent) => {
      events.push({ sessionId, event });
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("UiBridge", () => {
  test("审批应答：accept 带表单内容原样透传给 Confirmer", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);

    const pending = inRunSession("s1", () =>
      bridge.confirmer({
        serverId: "filesystem",
        message: "允许写入吗？",
        requestedSchema: {
          type: "object",
          properties: { path: { type: "string", title: "路径" } },
        },
      })
    );

    // 事件路由到 ALS 声明的会话，且 requestedSchema 被压平
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe("s1");
    const published = events[0]!.event;
    expect(published.type).toBe("approval_request");
    if (published.type === "approval_request") {
      expect(published.source).toBe("filesystem");
      expect(published.requestedSchema?.path?.title).toBe("路径");
      const id = published.id;
      expect(bridge.resolveApproval(id, { action: "accept", content: { path: "a.txt" } })).toBe(true);
    }

    expect(await pending).toEqual({ action: "accept", content: { path: "a.txt" } });
    expect(bridge.pendingEventsFor("s1")).toHaveLength(0);
  });

  test("审批超时：自动 decline，绝不默认放行", async () => {
    const { emit } = fakeEmit();
    const bridge = new UiBridge(emit, 30);

    const pending = inRunSession("s1", () => bridge.confirmer({ serverId: "x", message: "确认？" }));
    expect(await pending).toEqual({ action: "decline" });
    expect(bridge.pendingEventsFor("s1")).toHaveLength(0);
  });

  test("无运行上下文且无在飞归因：confirmer 直接 decline，requestHuman 返回 null", async () => {
    const { emit } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);

    expect(await bridge.confirmer({ serverId: "x", message: "确认？" })).toEqual({ action: "decline" });
    const controller = new AbortController();
    expect(await bridge.requestHuman("输入：", controller.signal)).toBeNull();
  });

  test("requestHuman（run_script 确认）：accept → 'y'，decline → null", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);

    // 允许 → "y"（run_script 的 approve() 接受）
    const first = inRunSession("s1", () => bridge.requestHuman("允许执行吗？[y/N]", new AbortController().signal));
    const firstEvent = events.at(-1)!.event;
    expect(firstEvent.type).toBe("approval_request");
    if (firstEvent.type === "approval_request") {
      expect(firstEvent.source).toBe("run_script");
      expect(bridge.resolveApproval(firstEvent.id, { action: "accept" })).toBe(true);
    }
    expect(await first).toBe("y");

    // 拒绝 → null（取消执行）
    const second = inRunSession("s1", () => bridge.requestHuman("允许执行吗？[y/N]", new AbortController().signal));
    const secondEvent = events.at(-1)!.event;
    if (secondEvent.type === "approval_request") {
      bridge.resolveApproval(secondEvent.id, { action: "decline" });
    }
    expect(await second).toBeNull();
  });

  test("requestHuman：run 中止（signal abort）与超时都按取消收口", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);

    // run 被取消 → 立即 null，未决审批同步清掉
    const abortController = new AbortController();
    const first = inRunSession("s1", () => bridge.requestHuman("允许执行吗？[y/N]", abortController.signal));
    abortController.abort();
    expect(await first).toBeNull();
    expect(bridge.pendingEventsFor("s1")).toHaveLength(0);

    // 超时 → null（审批绝不默认放行）
    const tightBridge = new UiBridge(emit, 30);
    const second = inRunSession("s1", () => tightBridge.requestHuman("允许执行吗？[y/N]", new AbortController().signal));
    expect(await second).toBeNull();
  });

  test("requestBudgetExtension：accept → 追加，decline/无会话 → 不追加", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);

    const approved = inRunSession("s1", () =>
      bridge.requestBudgetExtension("追加预算继续？", new AbortController().signal)
    );
    const acceptEvent = events.at(-1)!.event;
    expect(acceptEvent.type).toBe("approval_request");
    if (acceptEvent.type === "approval_request") {
      expect(acceptEvent.source).toBe("运行预算");
      bridge.resolveApproval(acceptEvent.id, { action: "accept" });
    }
    expect(await approved).toBe(true);

    const declined = inRunSession("s1", () =>
      bridge.requestBudgetExtension("追加预算继续？", new AbortController().signal)
    );
    const declineEvent = events.at(-1)!.event;
    if (declineEvent.type === "approval_request") {
      bridge.resolveApproval(declineEvent.id, { action: "decline" });
    }
    expect(await declined).toBe(false);

    expect(await bridge.requestBudgetExtension("追加预算继续？", new AbortController().signal)).toBe(false);
  });

  test("elicitation 归因：ALS 缺席时按 server 在飞调用路由；多会话并存宁可 decline", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);

    // s2 正在 filesystem 上有在飞调用：ALS 之外的 elicitation 路由给它
    bridge.noteServerUse("filesystem", "s2");
    const pending = bridge.confirmer({ serverId: "filesystem", message: "确认？" });
    expect(events.at(-1)!.sessionId).toBe("s2");
    const firstEvent = events.at(-1)!.event;
    if (firstEvent.type === "approval_request") {
      bridge.resolveApproval(firstEvent.id, { action: "accept" });
    }
    expect(await pending).toEqual({ action: "accept" });

    // 两个会话同时在同一 server 上有在飞调用：无法可靠归因 → decline
    bridge.noteServerUse("filesystem", "s2");
    bridge.noteServerUse("filesystem", "s3");
    expect(await bridge.confirmer({ serverId: "filesystem", message: "确认？" })).toEqual({ action: "decline" });

    // 归因恢复唯一后路由恢复
    bridge.releaseServerUse("filesystem", "s2");
    bridge.releaseServerUse("filesystem", "s3");
    bridge.noteServerUse("filesystem", "s3");
    const routed = bridge.confirmer({ serverId: "filesystem", message: "确认？" });
    expect(events.at(-1)!.sessionId).toBe("s3");
    const routedEvent = events.at(-1)!.event;
    if (routedEvent.type === "approval_request") {
      bridge.resolveApproval(routedEvent.id, { action: "decline" });
    }
    expect(await routed).toEqual({ action: "decline" });

    // ALS 优先于在飞映射：run 内的调用始终路由到自己的会话
    bridge.noteServerUse("filesystem", "s2");
    const alsPending = inRunSession("s9", () => bridge.confirmer({ serverId: "filesystem", message: "确认？" }));
    expect(events.at(-1)!.sessionId).toBe("s9");
    const alsEvent = events.at(-1)!.event;
    if (alsEvent.type === "approval_request") {
      bridge.resolveApproval(alsEvent.id, { action: "decline" });
    }
    expect(await alsPending).toEqual({ action: "decline" });
    void sleep; // 保留给未来需要真实等待的用例
  });

  test("会话取消：disposeSession 把未决审批按 decline 收口", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 60_000);

    const pending = inRunSession("s1", () => bridge.confirmer({ serverId: "x", message: "确认？" }));
    expect(bridge.pendingEventsFor("s1")).toHaveLength(1);

    bridge.disposeSession("s1");
    expect(await pending).toEqual({ action: "decline" });
    // 其他会话的请求不受影响（此处没有，仅验证不抛错）
    expect(bridge.pendingEventsFor("s2")).toHaveLength(0);
  });

  test("重复应答：第二次 resolve 返回 false（HTTP 404 的依据）", async () => {
    const { emit, events } = fakeEmit();
    const bridge = new UiBridge(emit, 5_000);

    const pending = inRunSession("s1", () => bridge.confirmer({ serverId: "x", message: "确认？" }));
    const lastEvent = events.at(-1)!.event;
    const id = lastEvent.type === "approval_request" ? lastEvent.id : "";
    expect(bridge.resolveApproval(id, { action: "decline" })).toBe(true);
    expect(bridge.resolveApproval(id, { action: "accept" })).toBe(false);
    expect(await pending).toEqual({ action: "decline" });
  });
});
