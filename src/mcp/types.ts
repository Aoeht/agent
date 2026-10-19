// src/mcp/types.ts
import type {
  ElicitRequestFormParams,
  LoggingLevel,
  Prompt,
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "../core/registry";
import type { McpPromptRole } from "../core/types";

/** 模型可见的工具返回内容块 */
export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ToolResourceContent {
  type: "resource";
  resource: unknown;
}

export type ToolContentBlock = ToolTextContent | ToolImageContent | ToolResourceContent;

export interface ToolExecutionResult {
  isError: boolean;
  content: ToolContentBlock[];
  /** Server 按 outputSchema 返回的结构化结果，优先于文本猜测 */
  structured?: unknown;
  raw?: unknown;
}

/** 执行上下文，支持取消信号 */
export interface ToolExecutionContext {
  serverId: string;
  toolName: string;
  /** 注册进 ToolRegistry 的命名空间名 */
  registeredName: string;
  annotations?: ToolAnnotationsLite;
  signal?: AbortSignal;
}

/** 中间件（安全拦截、审计日志、限流等） */
export type ToolMiddleware = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
  next: () => Promise<ToolExecutionResult>
) => Promise<ToolExecutionResult>;

export interface McpToolProgress {
  serverId: string;
  toolName: string;
  registeredName: string;
  progress: number;
  total?: number;
  message?: string;
}

export type McpProgressHandler = (event: McpToolProgress) => void;

export interface McpAuditEvent {
  phase: "started" | "completed" | "denied" | "failed";
  serverId: string;
  toolName: string;
  registeredName: string;
  args: Record<string, unknown>;
  durationMs?: number;
  resultChars?: number;
  errorName?: string;
}

export type McpAuditHandler = (event: McpAuditEvent) => void;

export interface McpServerLogEvent {
  serverId: string;
  level: LoggingLevel;
  logger?: string;
  data: unknown;
}

export type McpServerLogHandler = (event: McpServerLogEvent) => void;

/**
 * 人工确认请求。真实的 `elicitation/create` 会带 requestedSchema（服务端要收集的结构化字段）；
 * 本地策略触发的 "ask"（未经过协议，直接由 adapter 发起）不带 schema，走简单 y/n 确认。
 */
export interface ElicitationRequest {
  serverId: string;
  message: string;
  requestedSchema?: ElicitRequestFormParams["requestedSchema"];
}

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationResult {
  action: ElicitationAction;
  content?: Record<string, string | number | boolean | string[]>;
}

/** 人工确认的落地实现（CLI/UI 均可），接收请求、返回人的决定 */
export type Confirmer = (request: ElicitationRequest) => Promise<ElicitationResult>;

/**
 * Server 通过 `resources/list` 暴露的一段"数据"（不是动作，模型不能"调用"它，
 * 只能由 host 挑选后读进上下文）。字段直接复用 SDK 的 `Resource`，只额外加 serverId 归属。
 */
export interface McpResourceInfo extends Resource {
  serverId: string;
}

/** `resources/templates/list` 返回的 URI 模板（动态资源，按变量展开成具体 URI） */
export interface McpResourceTemplateInfo extends ResourceTemplate {
  serverId: string;
}

/** `prompts/list` 返回的可复用提示模板 */
export interface McpPromptInfo extends Prompt {
  serverId: string;
}

export type McpResourceContent =
  | { uri: string; text: string; mimeType?: string }
  | { uri: string; blob: string; mimeType?: string };

/**
 * `prompts/get` 返回的一条消息，content 复用工具侧已有的内容块表示。
 * role 取 MCP 规范允许的消息角色：Server 可以用 system 角色下发模板自带的约束，
 * 渲染时不能压平成 user —— 那会把 System 层的优先级降级成 User 层。
 */
export interface McpPromptMessage {
  /** role 原样保留（含 system，见 core/types 的 McpPromptRole），渲染时不降级成 user */
  role: McpPromptRole;
  content: ToolContentBlock;
}

export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/**
 * Server 在 tools/list 里声明的意图标记（MCP 规范的 ToolAnnotations）。
 * 全部是可选的：不声明就要退回路径守卫这类启发式判断。
 */
export interface ToolAnnotationsLite {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** 会触达本地沙箱之外的世界（网络 / 第三方 API），副作用不可回收 */
  openWorldHint?: boolean;
}

export interface ToolPolicyRequest {
  serverId: string;
  /** Server 侧的原始工具名 */
  toolName: string;
  /** 注册进 ToolRegistry 的命名空间名 */
  registeredName: string;
  /** 已通过 annotations 归一化出的意图标记 */
  annotations?: ToolAnnotationsLite;
  /** Server 是否真的声明了 annotations；false 时 annotations 只是规范默认值，策略应更保守 */
  declared?: boolean;
  args: Record<string, unknown>;
}

export type ToolPolicyAction = "allow" | "deny" | "ask";

/**
 * 执行前的准入判断。默认全部放行（保持既有行为），
 * 需要收紧时在这里按 annotations 决策：deny 直接以工具错误形式回给模型；
 * ask 会调用 confirmer 请求人工确认，未配置 confirmer 时按 deny 处理。
 */
export type ToolPolicy = (req: ToolPolicyRequest) => ToolPolicyAction | Promise<ToolPolicyAction>;

export interface McpAdapterOptions {
  /**
   * 允许访问的根目录白名单。为空时路径守卫不生效（等于关闭文件系统防护），
   * 因此只要挂载了 filesystem 类 Server 就必须显式传入。
   */
  allowedRoots?: string[];
  /** MCP 工具注册进哪个注册表；缺省用全局单例，注入实例可与宿主 agent 共用同一工具集 */
  registry?: ToolRegistry;
  /** 单次 MCP 请求超时，默认 60s */
  requestTimeoutMs?: number;
  /** 工具结果注入 LLM 上下文前的最大字符数，默认 20000 */
  maxResultChars?: number;
  /** 纯文本结果若形似 JSON 是否解析成对象，默认 true（structuredContent 优先，不受此项影响） */
  parseJsonText?: boolean;
  /** 是否把 annotations 摘要写进工具描述让模型自己权衡，默认 true */
  annotateDescription?: boolean;
  /** 准入策略，默认 allow */
  toolPolicy?: ToolPolicy;
  /** 策略返回 ask 时用来发起人工确认；未配置时 ask 等同 deny */
  confirmer?: Confirmer;
  /** 收到 tools/call 的 MCP 进度通知时触发 */
  onProgress?: McpProgressHandler;
  /** 工具调用生命周期审计；参数中的字符串只记录长度，敏感字段会被遮蔽 */
  onAudit?: McpAuditHandler;
  /** 路径守卫始终拒绝的路径段，默认包含常见凭据与版本控制目录 */
  protectedPathNames?: string[];
  /** 追加的自定义中间件，按注册顺序执行 */
  middlewares?: ToolMiddleware[];
}

export interface SyncToolsOptions {
  /** 只注册白名单内的原始工具名；不传表示全部注册 */
  allowedTools?: string[];
  /** 覆盖 adapter 级别的请求超时 */
  requestTimeoutMs?: number;
}

interface McpServerConfigBase {
  id: string;
  /** 默认启用；显式设为 false 才会被 loadFromConfig 跳过 */
  enabled?: boolean;
  /** 建立连接的超时，默认 30s（npx 冷启动可能较慢） */
  connectTimeoutMs?: number;
  /** 该 Server 单次工具调用超时 */
  requestTimeoutMs?: number;
  /** 工具白名单，用于裁剪注入 LLM 的工具数量 */
  allowedTools?: string[];
  /** 请求 Server 发送的最低结构化日志级别；未配置时不主动设置 */
  loggingLevel?: LoggingLevel;
  /**
   * 向 Server 声明的可访问根目录（MCP roots 能力）。
   * 传了才会声明 roots 能力并注册 roots/list 处理器；
   * 不声明又不实现会让 Server 启动时报 -32601 Method not found。
   */
  roots?: string[];
}

export interface McpStdioConfig extends McpServerConfigBase {
  transport: "stdio";
  command: string;
  args?: string[];
  /** 只传增量变量；SDK 会合并平台安全默认环境（Windows 下含 SYSTEMROOT/TEMP 等） */
  env?: Record<string, string>;
  cwd?: string;
  stderr?: "inherit" | "pipe" | "ignore";
}

export interface McpSseConfig extends McpServerConfigBase {
  /** 已被 MCP 规范标记为过时，新服务优先用 streamableHttp */
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface McpStreamableHttpConfig extends McpServerConfigBase {
  transport: "streamableHttp";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpSseConfig | McpStreamableHttpConfig;

export interface ServerStartReport {
  id: string;
  ok: boolean;
  tools?: string[];
  error?: string;
}

export interface ServerStatus {
  id: string;
  transport: McpServerConfig["transport"];
  connected: boolean;
  tools: string[];
}
