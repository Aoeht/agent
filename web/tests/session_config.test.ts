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
