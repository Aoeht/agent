import { expect, test } from "bun:test";
import { applyEvent, historyToItems, type SessionUIState } from "../src/state/store";
import { runOutcome } from "../../src/core/run_outcome";
import type { ServerEvent } from "../../src/server/protocol";

const citation = { index: 1, title: "已采集页面", url: "https://example.test/", tool: "inspect_link" };
function state(): SessionUIState {
  return { items: [{ kind: "assistant", id: "old", text: "上一轮答案", streaming: false }],
    plan: [], status: "idle" };
}
function end(reason: Parameters<typeof runOutcome>[0], finalAnswer: string | null): ServerEvent {
  return { type: "run_end", ...runOutcome(reason), finalAnswer,
    totalTokens: 10, toolCallsCount: 1, iterations: 2, citations: [citation] };
}

test("前一轮已有回答时，本轮拒绝仍显示且带原因和证据", () => {
  let s = applyEvent(state(), { type: "run_start", userMessage: "核查" });
  s = applyEvent(s, { type: "token", delta: "开始检查" });
  s = applyEvent(s, { type: "tool_call_start", callId: "c1", name: "inspect_link", arguments: "{}" });
  s = applyEvent(s, end("model_refusal", "无法分析图片"));
  expect(s.status).toBe("idle");
  expect(s.stats?.taskStatus).toBe("blocked");
  expect(s.items.some((it) => it.kind === "assistant" && it.text === "无法分析图片" && it.citations?.length === 1)).toBe(true);
  expect(s.items.some((it) => it.kind === "notice" && it.text.includes("模型拒绝回答"))).toBe(true);
  expect(s.items.filter((it) => it.kind === "assistant" && it.streaming)).toHaveLength(0);
});

test("流式截断保留部分答案并附证据，不重复追加", () => {
  let s = applyEvent(state(), { type: "run_start", userMessage: "核查" });
  s = applyEvent(s, { type: "token", delta: "部分答案" });
  s = applyEvent(s, end("output_truncated", "部分答案"));
  expect(s.items.filter((it) => it.kind === "assistant" && it.text === "部分答案")).toHaveLength(1);
  expect(s.stats?.stopReason).toBe("output_truncated");
  expect(s.items.some((it) => it.kind === "assistant" && it.text === "部分答案" && it.citations?.length === 1)).toBe(true);
});

test("非流式 step 已有终答时不重复，同时补上引用", () => {
  let s = applyEvent(state(), { type: "run_start", userMessage: "核查" });
  s = applyEvent(s, { type: "step", iteration: 1, llmContent: "答案" });
  s = applyEvent(s, end("answer", "答案"));
  expect(s.items.filter((it) => it.kind === "assistant" && it.text === "答案")).toHaveLength(1);
  expect(s.items.some((it) => it.kind === "assistant" && it.text === "答案" && it.citations?.length === 1)).toBe(true);
});

test("空过滤响应仍显示已采集证据", () => {
  let s = applyEvent(state(), { type: "run_start", userMessage: "核查" });
  s = applyEvent(s, end("content_filter", null));
  expect(s.items.some((it) => it.kind === "assistant" && it.citations?.length === 1)).toBe(true);
  expect(s.items.some((it) => it.kind === "notice" && it.text.includes("内容被过滤"))).toBe(true);
});

test("历史恢复空过滤结果时保留原因和引用，兼容旧记录", () => {
  const items = historyToItems({
    summary: { sessionId: "s", messageCount: 3, lastUpdated: "", firstUserText: "核查" },
    messages: [
      { role: "user", content: "核查" },
      { role: "assistant", content: "旧版回答" },
      { role: "assistant", content: "", citations: [citation], outcome: runOutcome("content_filter") },
    ],
  });
  expect(items.some((it) => it.kind === "assistant" && it.text === "旧版回答")).toBe(true);
  expect(items.some((it) => it.kind === "assistant" && it.citations?.length === 1)).toBe(true);
  expect(items.some((it) => it.kind === "notice" && it.text.includes("内容被过滤"))).toBe(true);
});
