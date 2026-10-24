import { createRoot } from "react-dom/client";
import { StoreProvider } from "../../src/state/store";
import App from "../../src/App";
import { MockTransport } from "../../src/lib/mock";

// 完整 App 的夹具：一条历史会话（侧栏有内容），启动后停在欢迎界面（store 不再自动选中）
const summary = { sessionId: "old-session", messageCount: 2, lastUpdated: "2026-01-02", firstUserText: "上次的任务" };
class FixtureTransport extends MockTransport {
  override async listSessions() {
    return [summary];
  }
  // mock 对未知 id 会抛"会话不存在"；夹具的历史会话返回空详情即可（抽屉/布局测试不依赖消息）
  override async openSession(sessionId: string) {
    if (sessionId === summary.sessionId) {
      return { summary, messages: [] };
    }
    return super.openSession(sessionId);
  }
  override async listModels() {
    return ["alpha-model", "beta-model"];
  }
  override async getSettings() {
    return { sandboxRoot: "A:\\welcome-fixture" };
  }
}
createRoot(document.getElementById("root")!).render(
  <StoreProvider transport={new FixtureTransport()}>
    <App />
  </StoreProvider>
);
