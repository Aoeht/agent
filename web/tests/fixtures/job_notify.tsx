import { createRoot } from "react-dom/client";
import type { JobSummaryDTO, ServerEvent, SessionSummaryDTO } from "@protocol";
import { StoreProvider } from "../../src/state/store";
import App from "../../src/App";
import { MockTransport } from "../../src/lib/mock";

// 跨会话完成通知夹具：两个空会话 + 一个把 job_finished 直接推进当前 SSE 回调的钩子。
// 真实环境里这条事件由服务器广播到所有已连接会话；夹具只需验证前端收到后的表现。
const summaries: SessionSummaryDTO[] = [
  { sessionId: "notify-a", name: "通知演示 A", messageCount: 0, lastUpdated: "2026-01-05", firstUserText: "" },
  { sessionId: "notify-b", name: "通知演示 B", messageCount: 0, lastUpdated: "2026-01-05", firstUserText: "" },
];

class FixtureTransport extends MockTransport {
  private sink?: (event: ServerEvent) => void;

  override async listSessions() {
    return summaries;
  }

  override async openSession(sessionId: string) {
    const summary = summaries.find((item) => item.sessionId === sessionId);
    if (!summary) return super.openSession(sessionId);
    return { summary, messages: [] };
  }

  override subscribe(
    sessionId: string,
    onEvent: (event: ServerEvent) => void,
    onStatus?: (status: "connected" | "reconnecting") => void
  ): () => void {
    this.sink = onEvent;
    return super.subscribe(sessionId, onEvent, onStatus);
  }

  pushJobFinished(job: JobSummaryDTO): void {
    this.sink?.({ type: "job_finished", job });
  }
}

const transport = new FixtureTransport();
declare global {
  interface Window {
    pushJobFinished: (job: JobSummaryDTO) => void;
  }
}
window.pushJobFinished = (job) => transport.pushJobFinished(job);

createRoot(document.getElementById("root")!).render(
  <StoreProvider transport={transport}>
    <App />
  </StoreProvider>
);
