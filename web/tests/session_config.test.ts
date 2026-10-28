import { expect, test } from "bun:test";
import { applyEvent, type SessionUIState } from "../src/state/store";

test("HTTP 确认后迟到的 hello 不回滚模型、温度与迭代数", () => {
  let state: SessionUIState = { items: [], plan: [], status: "idle" };
  state = applyEvent(state, { type: "session_config", model: "new", configRevision: 20, temperature: 0.5, maxIterations: 12 });
  state = applyEvent(state, { type: "hello", model: "old", configRevision: 10, temperature: 0.1, maxIterations: 8, sandbox: "test" });
  expect(state.model).toBe("new");
  expect(state.temperature).toBe(0.5);
  expect(state.maxIterations).toBe(12);
  expect(state.meta?.sandbox).toBe("test");
  state = applyEvent(state, { type: "session_config", model: "older", configRevision: 15 });
  expect(state.model).toBe("new");
  state = applyEvent(state, { type: "hello", model: "latest", configRevision: 30, sandbox: "test" });
  expect(state.model).toBe("latest");
});

test("上下文窗口覆盖：设置后生效，清空后回到查表值，迟到事件不回滚", () => {
  let state: SessionUIState = { items: [], plan: [], status: "idle" };
  state = applyEvent(state, {
    type: "session_config", model: "m", configRevision: 5,
    contextWindow: 32_000, contextWindowOverride: 32_000,
  });
  expect(state.contextWindow).toBe(32_000);
  expect(state.contextWindowOverride).toBe(32_000);

  // 清空覆盖：事件不带 override，有效窗口回到查表值，旧覆盖不能残留
  state = applyEvent(state, { type: "session_config", model: "m", configRevision: 6, contextWindow: 128_000 });
  expect(state.contextWindow).toBe(128_000);
  expect(state.contextWindowOverride).toBeUndefined();

  // 迟到的 hello（旧 revision）不回滚窗口与覆盖
  state = applyEvent(state, {
    type: "hello", model: "m", configRevision: 4, sandbox: "test",
    contextWindow: 32_000, contextWindowOverride: 32_000,
  });
  expect(state.contextWindow).toBe(128_000);
  expect(state.contextWindowOverride).toBeUndefined();

  // 重连后的 hello 是权威快照：没带 override 就说明覆盖已清空
  state = applyEvent(state, {
    type: "session_config", model: "m", configRevision: 7,
    contextWindow: 32_000, contextWindowOverride: 32_000,
  });
  state = applyEvent(state, { type: "hello", model: "m", configRevision: 8, sandbox: "test", contextWindow: 128_000 });
  expect(state.contextWindow).toBe(128_000);
  expect(state.contextWindowOverride).toBeUndefined();
});
