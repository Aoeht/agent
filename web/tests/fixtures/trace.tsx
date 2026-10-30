import { createRoot } from "react-dom/client";
import type { TraceChunkDTO, TraceListDTO } from "@protocol";
import { StoreProvider } from "../../src/state/store";
import App from "../../src/App";
import { MockTransport } from "../../src/lib/mock";

// 轨迹面板夹具：一条历史会话 + 一份固定内容的轨迹文件。
// 不用 MockTransport 自带的演示轨迹——那份按会话消息动态生成标题，
// 这里要的是可断言的固定事件序列。
const summary = {
  sessionId: "trace-session",
  name: "轨迹演示",
  messageCount: 2,
  lastUpdated: "2026-01-03",
  firstUserText: "分析一下反诈数据",
};

const file = "trace-session-2026-01-03T09-00-00-000Z.jsonl";
const base = Date.parse("2026-01-03T09:00:00.000Z");
const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString();
const events: TraceChunkDTO["events"] = [
  { ts: at(0), type: "run_start", data: { userMessage: "分析一下反诈数据", promptHash: "80705821b6f3" } },
  { ts: at(1_200), type: "tool_start", data: { callId: "call-1", name: "rag_search", arguments: '{"query":"混合检索权重"}' } },
  { ts: at(2_200), type: "tool_progress", data: { callId: "call-1", name: "rag_search", elapsedMs: 1_000 } },
  { ts: at(3_400), type: "tool_progress", data: { callId: "call-1", name: "rag_search", elapsedMs: 2_200 } },
  { ts: at(4_100), type: "tool_end", data: { callId: "call-1", name: "rag_search", durationMs: 2_900, ok: true } },
  {
    ts: at(4_300),
    type: "step",
    data: {
      step: {
        iteration: 1,
        tokens: { promptTokens: 2_140, completionTokens: 186, totalTokens: 2_326 },
        llmContent: null,
        toolCalls: [{ id: "call-1", name: "rag_search", arguments: '{"query":"混合检索权重"}', resultPreview: "命中 5 条" }],
      },
    },
  },
  { ts: at(6_000), type: "compact", data: { action: "stub_tool_outputs", messages: 2, tokens: 1_240, detail: "旧工具输出替换为占位符" } },
  { ts: at(6_800), type: "retry", data: { attempt: 1, delayMs: 800, reason: "503 上游繁忙" } },
  {
    ts: at(9_400),
    type: "run_end",
    data: {
      success: true,
      totalTokens: 9_820,
      cachedPromptTokens: 1_024,
      toolCallsCount: 1,
      iterations: 2,
      stopReason: "answer",
      finalAnswer: "演示终答（真实轨迹里是模型给出的回答）",
    },
  },
];
const size = events.reduce((total, event) => total + JSON.stringify(event).length, 0);

class FixtureTransport extends MockTransport {
  override async listSessions() {
    return [summary];
  }

  override async openSession(sessionId: string) {
    if (sessionId !== summary.sessionId) return super.openSession(sessionId);
    return {
      summary,
      messages: [
        { role: "user" as const, content: "分析一下反诈数据" },
        { role: "assistant" as const, content: "好的" },
      ],
    };
  }

  override async listTraces(sessionId: string): Promise<TraceListDTO> {
    if (sessionId !== summary.sessionId) return { traces: [] };
    return {
      traces: [
        {
          file,
          sizeBytes: size,
          modified: new Date(base + 9_400).toISOString(),
          label: "分析一下反诈数据",
        },
      ],
    };
  }

  override async readTrace(sessionId: string, name: string, after?: number): Promise<TraceChunkDTO> {
    if (sessionId !== summary.sessionId || name !== file) throw new Error("轨迹文件不存在");
    if (after !== undefined && after > 0) return { events: [], offset: after, size: after, reset: false };
    return { events, offset: size, size, reset: false };
  }
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider transport={new FixtureTransport()}>
    <App />
  </StoreProvider>
);
