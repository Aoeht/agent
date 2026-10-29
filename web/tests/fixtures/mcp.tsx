import { createRoot } from "react-dom/client";
import type { MessageSendResponse } from "@protocol";
import { StoreProvider } from "../../src/state/store";
import App from "../../src/App";
import { MockTransport } from "../../src/lib/mock";

// MCP 目录面板夹具：一条历史会话 + MockTransport 自带的资源/模板目录。
// 斜杠命令不真跑：记录到 window.__mcpCommands 并回 handled，面板只负责发对命令。
const summary = {
  sessionId: "mcp-session",
  name: "MCP 演示",
  messageCount: 2,
  lastUpdated: "2026-01-03",
  firstUserText: "看看资源",
};

class FixtureTransport extends MockTransport {
  override async listSessions() {
    return [summary];
  }

  override async openSession(sessionId: string) {
    if (sessionId !== summary.sessionId) return super.openSession(sessionId);
    return {
      summary,
      messages: [
        { role: "user" as const, content: "看看资源" },
        { role: "assistant" as const, content: "好的" },
      ],
    };
  }

  override async sendMessage(
    _sessionId: string,
    text: string
  ): Promise<Omit<MessageSendResponse, "ok">> {
    const calls = ((window as unknown as { __mcpCommands?: string[] }).__mcpCommands ??= []);
    calls.push(text);
    return { queued: false, queueId: "", handled: true, lines: [`已处理：${text}`] };
  }
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider transport={new FixtureTransport()}>
    <App />
  </StoreProvider>
);
