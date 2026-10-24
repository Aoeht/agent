// web/src/lib/http.ts
import type {
  ApprovalDecisionBody,
  ModelProbeStatus,
  ServerEvent,
  SessionConfigEvent,
  SessionDetailDTO,
  SessionSummaryDTO,
} from "@protocol";
import type { SessionConfigInput, ToolStateDTO, Transport } from "./transport";

/** API 基地址：开发时 Vite 代理同源转发，生产同源托管；跨域部署时用 VITE_API_BASE 指向后端 */
const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** 真实后端传输：REST + SSE，路径与 protocol.ts 的端点清单一一对应 */
export class HttpTransport implements Transport {
  readonly kind = "http" as const;

  private async request(pathname: string, init?: RequestInit): Promise<Response> {
    const resp = await fetch(`${base}${pathname}`, init);
    // 口令换过或 cookie 过期后 SPA 会一路 401：同源部署时直接回登录页，别让人对着报错文案猜
    if (resp.status === 401) {
      if (base === "") window.location.assign("/login");
      throw new Error("需要登录");
    }
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // 错误体不是 JSON 时用状态码
      }
      throw new Error(detail);
    }
    return resp;
  }

  async listSessions(): Promise<SessionSummaryDTO[]> {
    return (await this.request("/sessions")).json();
  }

  async createSession(): Promise<SessionSummaryDTO> {
    return (await this.request("/sessions", { method: "POST" })).json();
  }

  async openSession(sessionId: string): Promise<SessionDetailDTO> {
    return (await this.request(`/sessions/${encodeURIComponent(sessionId)}/history`)).json();
  }

  async listModels(): Promise<string[]> {
    return (await this.request("/models")).json();
  }

  async listModelStatus(): Promise<ModelProbeStatus[]> {
    return (await this.request("/models/status")).json();
  }

  async applySessionConfig(sessionId: string, config: SessionConfigInput): Promise<SessionConfigEvent> {
    return (await this.request(`/sessions/${encodeURIComponent(sessionId)}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    })).json();
  }

  async getSettings(): Promise<{ sandboxRoot: string }> {
    return (await this.request("/settings")).json();
  }

  async setSandboxRoot(dir: string): Promise<void> {
    await this.request("/settings/sandbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    });
  }

  async listTools(sessionId: string): Promise<ToolStateDTO> {
    return (await this.request(`/sessions/${encodeURIComponent(sessionId)}/tools`)).json();
  }

  async setToolState(sessionId: string, disabled: string[]): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
  }

  subscribe(
    sessionId: string,
    onEvent: (event: ServerEvent) => void,
    onStatus?: (status: "connected" | "reconnecting") => void
  ): () => void {
    // EventSource 断线自动重连；重连后服务器会重发 hello 与未决审批
    const source = new EventSource(`${base}/sessions/${encodeURIComponent(sessionId)}/events`);
    source.onopen = () => onStatus?.("connected");
    source.onerror = () => onStatus?.("reconnecting");
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as ServerEvent);
      } catch {
        // 坏帧跳过
      }
    };
    return () => source.close();
  }

  async sendMessage(sessionId: string, text: string): Promise<{ queued: boolean; queueId: string }> {
    const resp = await this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const parsed = (await resp.json()) as { queued?: boolean; queueId?: string };
    return { queued: parsed.queued === true, queueId: parsed.queueId ?? "" };
  }

  async removeQueuedMessage(sessionId: string, queueId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`, {
      method: "DELETE",
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
  }

  async respondApproval(
    _sessionId: string,
    approvalId: string,
    body: ApprovalDecisionBody
  ): Promise<void> {
    await this.request(`/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async respondInput(_sessionId: string, requestId: string, text: string): Promise<void> {
    await this.request(`/inputs/${encodeURIComponent(requestId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }
}
