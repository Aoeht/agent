// web/src/lib/transport.ts
import type {
  ApprovalDecisionBody,
  ServerEvent,
  SessionDetailDTO,
  SessionSummaryDTO,
} from "@protocol";

/** 会话级可调配置（模型/温度/迭代上限） */
export interface SessionConfigInput {
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

/** 工具开关面板的数据：清单 + 本会话的关闭集合 */
export interface ToolStateDTO {
  tools: Array<{ name: string; description: string }>;
  disabled: string[];
}

/**
 * 前端到后端的唯一通道抽象，方法与 protocol.ts 的端点清单一一对应。
 * 当前是 MockTransport（演示数据）；接真实后端时新增 HttpTransport 实现
 * 同一接口（SSE + fetch），UI 层零改动。
 */
export interface Transport {
  readonly kind: "mock" | "http";
  listSessions(): Promise<SessionSummaryDTO[]>;
  createSession(): Promise<SessionSummaryDTO>;
  openSession(sessionId: string): Promise<SessionDetailDTO>;
  /** 可选模型清单（服务商实时清单 + env 前置合并） */
  listModels(): Promise<string[]>;
  /** 应用会话级配置；成功后服务器广播 session_config 事件 */
  applySessionConfig(sessionId: string, config: SessionConfigInput): Promise<void>;
  getSettings(): Promise<{ sandboxRoot: string }>;
  /** 切换沙箱根目录（服务器整栈重建；有在飞回合时抛错） */
  setSandboxRoot(dir: string): Promise<void>;
  /** 工具开关：清单与本会话关闭集合 */
  listTools(sessionId: string): Promise<ToolStateDTO>;
  /** 设置本会话关闭的工具集合（立即生效：下一轮迭代的工具列表） */
  setToolState(sessionId: string, disabled: string[]): Promise<void>;
  /** 订阅事件流。返回退订函数；连接状态变化经 onStatus 上报 */
  subscribe(
    sessionId: string,
    onEvent: (event: ServerEvent) => void,
    onStatus?: (status: "connected" | "reconnecting") => void
  ): () => void;
  /** 会话忙时 reject（协议里的 409） */
  sendMessage(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  respondApproval(sessionId: string, approvalId: string, body: ApprovalDecisionBody): Promise<void>;
  respondInput(sessionId: string, requestId: string, text: string): Promise<void>;
}
