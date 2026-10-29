import { createRoot } from "react-dom/client";
import type { CheckpointListDTO, RewindResponse, RewindScope } from "@protocol";
import { StoreProvider } from "../../src/state/store";
import App from "../../src/App";
import { MockTransport } from "../../src/lib/mock";

// 检查点面板夹具：一条 4 条消息的历史会话 + 两个检查点（#1 边界 0 条、#2 边界 2 条）。
// ?disabled=1 时模拟 AGENT_CHECKPOINTS=0，面板应显示"已关闭"。
const disabled = new URLSearchParams(location.search).get("disabled") === "1";
const summary = { sessionId: "cp-session", name: "检查点演示", messageCount: 4, lastUpdated: "2026-01-02", firstUserText: "第一轮" };
let messages: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user", content: "第一轮" },
  { role: "assistant", content: "答 1" },
  { role: "user", content: "第二轮" },
  { role: "assistant", content: "答 2" },
];
const checkpoints = [
  { seq: 1, time: "2026-01-02T10:00:00.000Z", input: "第一轮", records: 0 },
  { seq: 2, time: "2026-01-02T10:05:00.000Z", input: "第二轮：改 a.txt 并建 b.txt", records: 2 },
];

class FixtureTransport extends MockTransport {
  override async listSessions() {
    return [summary];
  }

  override async openSession(sessionId: string) {
    if (sessionId !== summary.sessionId) return super.openSession(sessionId);
    return { summary: { ...summary, messageCount: messages.length }, messages: [...messages] };
  }

  override async listCheckpoints(_sessionId: string): Promise<CheckpointListDTO> {
    // 与真实服务端一致：最新在前
    return disabled ? { enabled: false, checkpoints: [] } : { enabled: true, checkpoints: [...checkpoints].reverse() };
  }

  override async rewindCheckpoint(_sessionId: string, seq: number, scope: RewindScope): Promise<RewindResponse> {
    const calls = ((window as unknown as { __rewinds?: unknown[] }).__rewinds ??= []);
    calls.push({ seq, scope });
    const picked = checkpoints.find((info) => info.seq === seq)!;
    const lines: string[] = [];
    const result: RewindResponse = { ok: true, seq, scope, lines };
    if (scope !== "chat") {
      result.restored = 2;
      result.deleted = 1;
      lines.push("⏪ 已恢复工作区：写回 2 个文件，删除 1 个该时点之后新增的文件。");
    }
    if (scope !== "code") {
      messages = messages.slice(0, picked.records);
      result.records = picked.records;
      result.refresh = "history";
      lines.push(`⏪ 已恢复对话：会话历史截断到第 ${seq} 号检查点的边界（${picked.records} 条记录），下轮生效。`);
    }
    return result;
  }
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider transport={new FixtureTransport()}>
    <App />
  </StoreProvider>
);
