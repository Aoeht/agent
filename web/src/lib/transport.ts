// web/src/lib/transport.ts
import type {
  ApprovalDecisionBody,
  JobLogChunkDTO,
  JobSummaryDTO,
  MessageSendResponse,
  ModelProbeStatusResponse,
  ServerEvent,
  SessionConfigEvent,
  SessionDetailDTO,
  SessionSummaryDTO,
  ThinkingEffort,
  UserImageUploadBody,
} from "@protocol";

/** 会话级可调配置（模型/摘要模型/上下文窗口/温度/迭代上限/思考程度） */
export interface SessionConfigInput {
  model?: string;
  summaryModel?: string;
  /** 上下文窗口覆盖（token）；null = 清空覆盖、恢复按模型名查表 */
  contextWindow?: number | null;
  temperature?: number;
  maxIterations?: number;
  thinkingEffort?: ThinkingEffort;
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
  /** 模型可用性探测（对话开始时拉取；清单里有 ≠ 能用，配额按模型计） */
  listModelStatus(): Promise<ModelProbeStatusResponse>;
  /** 应用会话级配置；成功后服务器广播 session_config 事件 */
  applySessionConfig(sessionId: string, config: SessionConfigInput): Promise<SessionConfigEvent>;
  getSettings(): Promise<{ sandboxRoot: string }>;
  /** 切换沙箱根目录（服务器整栈重建；有在飞回合时抛错） */
  setSandboxRoot(dir: string): Promise<void>;
  /** 工具开关：清单与本会话关闭集合 */
  listTools(sessionId: string): Promise<ToolStateDTO>;
  /** 设置本会话关闭的工具集合（立即生效：下一轮迭代的工具列表） */
  setToolState(sessionId: string, disabled: string[]): Promise<void>;
  /** 后台脚本任务列表（最近 50 条，按开始时间倒序；服务端读取时校正状态） */
  listJobs(): Promise<JobSummaryDTO[]>;
  /** 日志增量：不带 after 取尾部快照（reset=true），带 after 按字节偏移续拉 */
  readJobLog(jobId: string, stream: "stdout" | "stderr", after?: number): Promise<JobLogChunkDTO>;
  /** 终止仍在跑的后台任务（已结束的任务原样返回） */
  killJob(jobId: string): Promise<void>;
  /** 订阅事件流。返回退订函数；连接状态变化经 onStatus 上报 */
  subscribe(
    sessionId: string,
    onEvent: (event: ServerEvent) => void,
    onStatus?: (status: "connected" | "reconnecting") => void
  ): () => void;
  /** 发送消息：会话忙时不报错而是排队（服务端 FIFO，回合结束后自动接续）；
   *  queued=true 表示这条消息在等待，queueId 用于撤单与 run_start 转正；
   *  handled=true 表示命中斜杠命令通道：就地执行，lines 为命令输出（不入队、无 run 事件） */
  sendMessage(
    sessionId: string,
    text: string,
    images?: UserImageUploadBody[]
  ): Promise<Omit<MessageSendResponse, "ok">>;
  /** 撤销一条排队中的消息（不影响正在运行的回合） */
  removeQueuedMessage(sessionId: string, queueId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  respondApproval(sessionId: string, approvalId: string, body: ApprovalDecisionBody): Promise<void>;
  respondInput(sessionId: string, requestId: string, text: string): Promise<void>;
}
