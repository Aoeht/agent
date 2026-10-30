import { createRoot } from "react-dom/client";
import { StoreProvider } from "../../src/state/store";
import App from "../../src/App";
import { MockTransport } from "../../src/lib/mock";
import type { ProviderInfo, ProviderInput } from "../../src/lib/transport";

// 供应商面板夹具：一个已保存的供应商（两个模型），开关只改内存里的清单，
// listModels 与真实后端一样只返回启用中的自定义模型。
const summary = { sessionId: "provider-session", messageCount: 1, lastUpdated: "2026-01-06", firstUserText: "供应商开关演示" };

class FixtureTransport extends MockTransport {
  private rows: ProviderInfo[] = [
    {
      id: "demo-1",
      name: "演示供应商",
      baseURL: "https://demo.example/v1",
      models: [
        { id: "alpha", enabled: true },
        { id: "beta", enabled: true },
      ],
      hasKey: true,
    },
  ];

  override async listSessions() {
    return [summary];
  }

  override async openSession(sessionId: string) {
    return sessionId === summary.sessionId ? { summary, messages: [] } : super.openSession(sessionId);
  }

  override async listModels() {
    const custom = this.rows.flatMap((p) => p.models.filter((m) => m.enabled).map((m) => `${p.id}::${m.id}`));
    return ["glm-5.2", ...custom];
  }

  override async listProviders(): Promise<ProviderInfo[]> {
    return this.rows.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }));
  }

  override async addProvider(_input: ProviderInput): Promise<void> {
    throw new Error("夹具不支持新增供应商");
  }

  override async removeProvider(id: string): Promise<void> {
    this.rows = this.rows.filter((p) => p.id !== id);
  }

  override async setProviderModels(id: string, enabledModels: string[]): Promise<void> {
    window.providerCalls.push({ id, enabled: [...enabledModels] });
    this.rows = this.rows.map((p) =>
      p.id === id ? { ...p, models: p.models.map((m) => ({ ...m, enabled: enabledModels.includes(m.id) })) } : p
    );
  }
}

declare global {
  interface Window {
    providerCalls: Array<{ id: string; enabled: string[] }>;
  }
}
window.providerCalls = [];

createRoot(document.getElementById("root")!).render(
  <StoreProvider transport={new FixtureTransport()}>
    <App />
  </StoreProvider>
);
