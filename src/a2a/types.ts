// src/a2a/types.ts
/**
 * A2A v1.0.1 规范的公共数据模型（第 1 层，对齐 a2a.proto 的 JSON 序列化）。
 *
 * 与传输无关：JSON-RPC（jsonrpc.ts）、抽象操作（operations.ts）都只引用这里的类型。
 * 规范细节的依据见 docs/A2A进阶篇.md（固定基线 v1.0.1），几条最容易踩的：
 * - 全部字段名 camelCase（proto 里是 snake_case，线上传 JSON 必须转），规范 5.5 节硬要求；
 * - Part 没有 v0.3 的 `kind` 判别，靠"哪个内容成员存在"判别（text/raw/url/data，恰好一个）；
 * - 枚举值带 `TASK_STATE_` / `ROLE_` 前缀（ProtoJSON 风格），`CANCELED` 是单 L 美式拼写；
 * - 时间戳 ISO 8601 UTC，毫秒精度，只允许 `Z` 结尾。
 */

// ---------- 枚举 ----------

export const TERMINAL_STATES = ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"] as const;

/** 中断态：任务挂起等外部输入（补话/授权），不是终态，也不算进行中 */
export const INTERRUPTED_STATES = ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"] as const;

export type TaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | (typeof TERMINAL_STATES)[number]
  | (typeof INTERRUPTED_STATES)[number];

/**
 * 终态判断只写一次、全项目引用：能否续话、能否取消、流该不该关，都由它决定。
 * 散落的字符串比较是 bug 温床（尤其 CANCELED 单 L 拼写漂移时）。
 */
export function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isInterrupted(state: TaskState): boolean {
  return (INTERRUPTED_STATES as readonly string[]).includes(state);
}

export type Role = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";

// ---------- 内容件 ----------

/**
 * Part：v1.0 的成员名判别联合（不再是 v0.3 的 `{kind: "text"}` 三子类型）。
 * oneof 语义上只允许恰好一个内容成员；TypeScript 的类型系统挡不住同时塞两个，
 * 所以入站/出站都要过 parsePart / assertSingleContentField 的运行时校验。
 */
export type Part =
  | { text: string; mediaType?: string; filename?: string; metadata?: Record<string, unknown> }
  | { raw: string; mediaType?: string; filename?: string; metadata?: Record<string, unknown> }
  | { url: string; mediaType?: string; filename?: string; metadata?: Record<string, unknown> }
  | { data: unknown; mediaType?: string; filename?: string; metadata?: Record<string, unknown> };

/** 判别辅助：看哪个成员存在，不看 kind。多个成员同时存在返回 null（不合规范） */
export function partKind(part: Part): "text" | "raw" | "url" | "data" | null {
  const present = (["text", "raw", "url", "data"] as const).filter((key) => key in part);
  if (present.length !== 1) return null;
  return present[0]!;
}

/** 内容成员是否恰好一个且类型正确；只返回结构化的判定结果，错误文案由调用方拼 */
export function isValidPart(value: unknown): value is Part {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const members = (["text", "raw", "url", "data"] as const).filter((key) => key in record);
  if (members.length !== 1) return false;
  const key = members[0]!;
  if (key === "text" || key === "raw" || key === "url") return typeof record[key] === "string";
  // data 是结构化 JSON，任意合法 JSON 值都行（对象/数组/标量），唯独不能缺失
  return record.data !== undefined;
}

// ---------- 任务与消息 ----------

export interface Message {
  role: Role;
  messageId: string;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: string[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

/** SendStreamingMessage 的流事件：状态更新 */
export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
}

/** SendStreamingMessage 的流事件：产物更新 */
export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * 流式响应的 oneof（规范 6.x）：每个 SSE data 是一条完整 JSON-RPC 响应，
 * result 恰好是 task / message / statusUpdate / artifactUpdate 之一；
 * 流结束信号是**关闭连接**（v1.0 删除了 v0.3 的 `final: true` 字段）。
 */
export type StreamingResponse =
  | { task: Task }
  | { message: Message }
  | { statusUpdate: TaskStatusUpdateEvent }
  | { artifactUpdate: TaskArtifactUpdateEvent };

// ---------- Agent Card（v1.0，见进阶篇 5.2 字段表） ----------

export type ProtocolBinding = "JSONRPC" | "GRPC" | "HTTP+JSON" | (string & {});

export interface AgentInterface {
  url: string;
  protocolBinding: ProtocolBinding;
  /** 只写 Major.Minor（如 "1.0"），patch 版本不得出现在名片里 */
  protocolVersion: string;
  tenant?: string;
}

export interface AgentProvider {
  organization: string;
  url: string;
}

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  provider?: AgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
}

// ---------- JSON-RPC 2.0 信封 ----------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

// ---------- 结构化错误（规范 3.3.2：data 里每个对象必须带 @type） ----------

const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";

/**
 * A2A 语义错误基类：第 2 层（operations）抛这个类型，第 3 层（jsonrpc）负责翻成
 * JSON-RPC code——将来加 REST 绑定时同一个错误翻成 HTTP status，业务逻辑零改动。
 */
export class A2aError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "A2aError";
  }

  /** 错误详情：google.rpc.ErrorInfo 的 ProtoJSON Any 表示，@type 键必须有 */
  toRpcData(): Array<{ "@type": string; reason: string; domain?: string }> {
    return [{ "@type": ERROR_INFO_TYPE, reason: this.reason, domain: "a2a" }];
  }

  toJsonObject(): JsonRpcErrorObject {
    return { code: this.code, message: this.message, data: this.toRpcData() };
  }
}

export class TaskNotFoundError extends A2aError {
  constructor(message = "Task not found") {
    super(-32001, "TASK_NOT_FOUND", message);
  }
}

export class TaskNotCancelableError extends A2aError {
  constructor(message = "Task is already in a terminal state and cannot be canceled") {
    super(-32002, "TASK_NOT_CANCELABLE", message);
  }
}

export class UnsupportedOperationError extends A2aError {
  constructor(message = "This operation is not supported by this agent") {
    super(-32004, "UNSUPPORTED_OPERATION", message);
  }
}

export class InvalidAgentResponseError extends A2aError {
  constructor(message = "The agent produced an invalid response") {
    super(-32006, "INVALID_AGENT_RESPONSE", message);
  }
}

export class VersionNotSupportedError extends A2aError {
  constructor(message = "The requested A2A protocol version is not supported") {
    super(-32009, "VERSION_NOT_SUPPORTED", message);
  }
}

export class InvalidParamsError extends A2aError {
  constructor(message = "Invalid method parameters") {
    super(-32602, "INVALID_PARAMS", message);
  }
}

// ---------- 入站载荷的松散校验（wire → 类型） ----------

export function isValidRole(value: unknown): value is Role {
  return value === "ROLE_UNSPECIFIED" || value === "ROLE_USER" || value === "ROLE_AGENT";
}

/**
 * 入站 Message 的最小校验：role 合法、messageId 是非空串、parts 非空且每个 Part
 * 恰好一个内容成员。不认识的字段按规范忽略（宽容解析），但 oneof 冲突必须拒绝——
 * "只返回第一个存在的字段"会掩盖不合规报文（进阶篇 3.3）。
 */
export function parseInboundMessage(value: unknown): Message {
  if (typeof value !== "object" || value === null) {
    throw new InvalidParamsError("params.message 必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (!isValidRole(record.role)) {
    throw new InvalidParamsError("message.role 必须是 ROLE_USER / ROLE_AGENT");
  }
  if (typeof record.messageId !== "string" || record.messageId === "") {
    throw new InvalidParamsError("message.messageId 必须是非空字符串");
  }
  if (!Array.isArray(record.parts) || record.parts.length === 0) {
    throw new InvalidParamsError("message.parts 必须是非空数组");
  }
  for (const part of record.parts) {
    if (!isValidPart(part)) {
      throw new InvalidParamsError("每个 Part 必须恰好有一个内容成员（text/raw/url/data）");
    }
  }
  const contextId = typeof record.contextId === "string" && record.contextId !== "" ? record.contextId : undefined;
  const taskId = typeof record.taskId === "string" && record.taskId !== "" ? record.taskId : undefined;
  const referenceTaskIds = Array.isArray(record.referenceTaskIds) && record.referenceTaskIds.every((id) => typeof id === "string")
    ? (record.referenceTaskIds as string[])
    : undefined;
  return {
    role: record.role,
    messageId: record.messageId,
    parts: record.parts as Part[],
    ...(contextId !== undefined ? { contextId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(referenceTaskIds !== undefined ? { referenceTaskIds } : {}),
    ...(typeof record.metadata === "object" && record.metadata !== null
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
  };
}

/** 把 Part 拼成纯文本（只认 text 成员；data 序列化成 JSON；raw/url 标注占位）。
 *  入站文本拼接后一律按不可信数据对待——这里只做提取，围栏在 fence.ts。 */
export function partsToText(parts: Part[]): string {
  return parts
    .map((part) => {
      if ("text" in part) return part.text;
      if ("data" in part) return JSON.stringify(part.data);
      if ("url" in part) return `[外部附件: ${part.url}]`;
      return `[二进制附件: ${part.filename ?? part.mediaType ?? "unknown"}]`;
    })
    .join("\n");
}

/** ISO 8601 UTC 毫秒时间戳，只允许 Z 结尾（规范对序列化格式的要求） */
export function a2aTimestamp(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 23)}Z`;
}
