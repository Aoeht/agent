// src/server/protocol.ts
/**
 * Web UI 与服务器之间的线上契约 —— 前后端之间**唯一的耦合点**。
 *
 * 演进纪律：只做增量。新增事件类型、给既有事件加**可选**字段都向后兼容；
 * 删除字段或改变既有字段语义时，必须与 web/ 同步改版。
 * 前端只 `import type` 本文件的类型，不引入任何后端运行时代码。
 *
 * 传输形态：
 * - 下行（服务器 → 前端）：GET /sessions/:id/events，SSE，每条消息 `data: <ServerEvent JSON>\n\n`；
 *   连接建立后先发一条 hello 声明运行环境。
 * - 上行（前端 → 服务器）：REST，见下面的端点清单。
 *
 * 端点清单（v1）：
 *   GET    /sessions                  → SessionSummaryDTO[]
 *   POST   /sessions                  → SessionSummaryDTO（新建）
 *   GET    /sessions/:id/history      → SessionDetailDTO（摘要 + 历史）
 *   GET    /sessions/:id/tasks        → TaskRecord[]（独立任务历史）
 *   GET    /sessions/:id/checkpoints  → CheckpointListDTO（回合级检查点，最新在前）
 *   POST   /sessions/:id/checkpoints/rewind body { seq, scope } → RewindResponse；回合中 409
 *   GET    /mcp/catalog               → McpCatalogDTO（资源 + 提示模板清单，🧩 面板用）
 *   GET    /mcp/resource?serverId=&uri= → McpResourceReadDTO（正文预览，超长截断）
 *   POST   /sessions/:id/messages     body { text, images? } → 202；忙时 409 { error }
 *   POST   /sessions/:id/cancel       → 204
 *   GET    /jobs                      → { jobs: JobSummaryDTO[] }（最近 50 条，按开始时间倒序）
 *   GET    /jobs/:id/log?stream=&after= → JobLogChunkDTO（不带 after 取尾部快照）
 *   POST   /jobs/:id/kill             → { ok, status }；已在跑则终止
 *   POST   /approvals/:id             body ApprovalDecisionBody → 204；未知/已过期 404/410
 *   POST   /inputs/:id                body { text } → 204（human_input_request 的应答）
 *   GET    /status                    → StatusDTO
 *
 * 访问门禁（设了 AGENT_UI_TOKEN 时；见 src/server/auth.ts）：
 *   GET    /login                     → 口令登录页
 *   POST   /login                     body { token } → 302 + HttpOnly cookie；口令不对 401
 *   其余端点（含 SSE 与静态资源）无凭据时：浏览器导航回登录页，API 回 401
 */

import { z } from "zod";
import { STOP_REASONS } from "../core/run_outcome";
import type { RunOutcome } from "../core/run_outcome";
import { TaskSchema, VerificationSchema } from "../core/task_types";
import type { TaskRecord } from "../core/task_types";
import { THINKING_EFFORTS } from "../utils/thinking_effort";
import type { ThinkingEffort } from "../utils/thinking_effort";

/** 统一思考程度档位：default 跟随厂商默认，off/low/medium/high 按当前模型映射厂商参数 */
export const ThinkingEffortSchema = z.enum(THINKING_EFFORTS);
export type { ThinkingEffort };

// ---------- 共享小结构 ----------

/** 计划步骤：update_plan 的全量快照语义，与 core/plan_store.ts 的 PlanStep 对齐 */
export const PlanStepSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/** step 事件携带的工具调用记录（模型实际看到的截断预览） */
const ToolCallRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  resultPreview: z.string().optional(),
});

/** Grounded 引用来源：与最终回答中的 [n] 标记一一对应（核心字段对齐 core/citations.ts） */
export const CitationSchema = z.object({
  index: z.number().int().positive(),
  title: z.string(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  tool: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const RunOutcomeSchema = z.object({
  runStatus: z.enum(["completed", "stopped", "failed"]),
  taskStatus: z.enum(["answered", "verified", "incomplete", "blocked"]),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  verification: VerificationSchema.optional(),
  stopReason: z.enum(STOP_REASONS),
  finishReason: z.string().nullable(),
  refusal: z.string().nullable(),
  errorMessage: z.string().optional(),
});

/** 审批表单字段描述：对齐 MCP elicitation 的 requestedSchema 形状 */
export type RequestedSchemaField = {
  type?: string;
  title?: string;
  description?: string;
  default?: string | number | boolean;
};

// ---------- 下行事件 ----------

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task_update"), task: TaskSchema }),
  /** SSE 连接建立后第一条：声明当前运行环境（右栏「环境」卡片的数据源） */
  z.object({
    type: z.literal("hello"),
    model: z.string(),
    configRevision: z.number().optional(),
    summaryModel: z.string().optional(),
    /** 沙箱后端描述，如 "docker 容器（断网）" 或 "宿主机进程（回退原因）" */
    sandbox: z.string(),
    /** 沙箱根目录（可在 UI 里切换，切换后重连/新回合生效） */
    sandboxRoot: z.string().optional(),
    /** 该会话模型的上下文窗口（token），配合 step.tokens.promptTokens 显示上下文占用 */
    contextWindow: z.number().int().optional(),
    /** 会话级窗口覆盖（只在实际覆盖时出现；缺省表示按模型名查表） */
    contextWindowOverride: z.number().int().optional(),
    temperature: z.number().optional(),
    maxIterations: z.number().int().optional(),
    thinkingEffort: ThinkingEffortSchema.optional(),
    /** 该会话的模型是否接受图片输入（AGENT_VISION 且通道可用）：前端据此禁用附件按钮 */
    vision: z.boolean().optional(),
    promptHash: z.string().optional(),
    skills: z.array(z.string()).optional(),
    mcpServers: z
      .array(z.object({ id: z.string(), ok: z.boolean(), tools: z.number().int().optional() }))
      .optional(),
  }),
  z.object({ type: z.literal("run_start"), userMessage: z.string(), promptHash: z.string().optional(),
    /** 该回合来自排队消息时携带：前端把排队芯片转成正式用户气泡（等待过的消息才有，立即执行的不带） */
    queueId: z.string().optional(),
    /** 随消息上传的图片元数据（名称/类型/原图大小）：前端画附件标签用，像素不进事件流 */
    images: z.array(z.object({ name: z.string(), mimeType: z.string(), sizeBytes: z.number().int() })).optional() }),
  /** 流式增量文本；与 step.llmContent 二选一消费（流式开启时消费方忽略 step.llmContent） */
  z.object({ type: z.literal("token"), delta: z.string() }),
  /** 工具开始执行（UI 渲染转圈状态）；由服务器侧工具中间件桥接发布 */
  z.object({
    type: z.literal("tool_call_start"),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    type: z.literal("tool_call_end"),
    callId: z.string(),
    /** 缺省时按 callId 关联 start */
    name: z.string().optional(),
    result: z.string().optional(),
    isError: z.boolean().optional(),
  }),
  /** 工具执行心跳（长阻塞工具的已运行时长；callId 与 tool_call_start 同值） */
  z.object({
    type: z.literal("tool_progress"),
    callId: z.string(),
    name: z.string(),
    elapsedMs: z.number().int().nonnegative(),
  }),
  /** 一轮 LLM 调用完成（对应 core 的 step 事件） */
  z.object({
    type: z.literal("step"),
    iteration: z.number().int(),
    llmContent: z.string().nullable().optional(),
    toolCalls: z.array(ToolCallRecordSchema).optional(),
    /** 本轮真实用量：promptTokens ≈ 发送时的上下文长度，供 UI 画上下文占用 */
    tokens: z
      .object({
        promptTokens: z.number().int(),
        completionTokens: z.number().int(),
        totalTokens: z.number().int(),
        /** prompt 里命中服务端前缀缓存的部分（provider 不上报时缺省；promptTokens 的子集） */
        cachedPromptTokens: z.number().int().optional(),
      })
      .optional(),
  }),
  /** 会话级配置变化（模型/摘要模型/上下文窗口/温度/迭代上限/思考程度，POST /sessions/:id/config 后广播） */
  z.object({
    type: z.literal("session_config"),
    model: z.string(),
    configRevision: z.number().optional(),
    contextWindow: z.number().int().optional(),
    /** 会话级窗口覆盖（清空后不带该字段） */
    contextWindowOverride: z.number().int().optional(),
    summaryModel: z.string().optional(),
    temperature: z.number().optional(),
    maxIterations: z.number().int().optional(),
    thinkingEffort: ThinkingEffortSchema.optional(),
  }),
  z.object({ type: z.literal("plan_update"), steps: z.array(PlanStepSchema) }),
  /** 上下文压缩动作：action 枚举与 core/events.ts 的 CompactEvent 对齐 */
  z.object({
    type: z.literal("compact"),
    action: z.enum([
      "stub_tool_outputs",
      "drop_tool_history",
      "fold_summary",
      "stage3_clip",
      "summary_failed",
      "hard_truncate",
      "emergency",
      "drop_images",
      "longterm_summary",
      "memory_write",
      "memory_failed",
    ]),
    messages: z.number().int().optional(),
    tokens: z.number().int().optional(),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("retry"),
    attempt: z.number().int(),
    delayMs: z.number(),
    reason: z.string(),
  }),
  /**
   * 人工审批请求（Confirmer 的 UI 版）：前端弹模态框，用 POST /approvals/:id 应答；
   * 超时未应答服务器按 decline 处理。页面刷新后服务器必须重发未决请求。
   */
  z.object({
    type: z.literal("approval_request"),
    id: z.string(),
    /** 来源：MCP serverId 或 "run_script" 等本地工具 */
    source: z.string().optional(),
    toolName: z.string().optional(),
    message: z.string(),
    requestedSchema: z.record(z.string(), z.custom<RequestedSchemaField>()).optional(),
  }),
  /** 人工输入请求（ToolRuntime.requestHuman 的 UI 版）：POST /inputs/:id 应答 */
  z.object({
    type: z.literal("human_input_request"),
    id: z.string(),
    source: z.string().optional(),
    prompt: z.string(),
  }),
  z.object({
    type: z.literal("run_end"),
    task: TaskSchema.optional(),
    ...RunOutcomeSchema.partial().shape,
    success: z.boolean(),
    finalAnswer: z.string().nullable().optional(),
    totalTokens: z.number().int(),
    /** 本轮命中前缀缓存的 prompt token 合计（provider 不上报时缺省） */
    cachedPromptTokens: z.number().int().optional(),
    toolCallsCount: z.number().int(),
    iterations: z.number().int(),
    budgetStopped: z.string().optional(),
    /**
     * Grounded 引用来源：与最终回答中的 [n] 标记一一对应。
     * 前端据此把 [n] 渲染成可点击的来源卡片。
     */
    citations: z.array(CitationSchema).optional(),
  }),
  /** 会话名生成完成（新会话第一轮结束后） */
  z.object({ type: z.literal("session_name"), name: z.string() }),
  /**
   * 会话消息队列快照：忙时发送的消息先排队，当前回合结束后自动按序接续。
   * 每次变化（入队 / 撤销 / 出队开跑）都发全量列表；SSE（重）连后也补发一次。
   */
  z.object({
    type: z.literal("queue_changed"),
    items: z.array(z.object({ id: z.string(), text: z.string() })),
  }),
  /**
   * 会话可见的工具集变了（MCP 热载入/工具增删在回合开始时对齐进会话注册表）。
   * 无载荷：前端收到后重新 GET /sessions/:id/tools 刷新开关面板。
   */
  z.object({ type: z.literal("tools_changed") }),
  /**
   * 会话被回滚到某个检查点（检查点面板回滚对话/全部时发）：
   * 其他标签页收到后重拉历史，避免显示已被截断的旧消息。
   */
  z.object({
    type: z.literal("history_rewound"),
    seq: z.number().int().positive(),
    scope: z.enum(["code", "chat", "all"]),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type SessionConfigEvent = Extract<ServerEvent, { type: "session_config" }>;

/**
 * POST /sessions/:id/messages 请求体里的一张图片。像素只在请求体里走一次：
 * 不写会话文件、不进 SSE、不进 trace；服务端按 src/core/user_images.ts 的口径复核。
 */
export interface UserImageUploadBody {
  name?: string;
  mimeType?: string;
  /** `data:image/(png|jpeg|webp|gif);base64,...` */
  dataUrl: string;
}

/**
 * POST /sessions/:id/messages 响应：普通消息入队走 run 生命周期（queued=true）；
 * 斜杠命令命中命令通道时 handled=true，lines 为命令输出（就地执行，不入队、
 * 不发 run_start/run_end、不落会话文件——与 REPL 终端打印同权的一次性 UI 态）。
 */
export interface MessageSendResponse {
  ok: true;
  queued: boolean;
  /** handled 时无意义（命令不经队列），恒为 "" */
  queueId: string;
  handled?: boolean;
  /** 命令输出行（handled 时有） */
  lines?: string[];
  /** "history" = 会话文件被改写（/rewind），前端应重拉历史与 session 详情 */
  refresh?: "history";
}

// ---------- REST DTO ----------

export interface SessionSummaryDTO {
  sessionId: string;
  name?: string;
  messageCount: number;
  /** ISO 8601 */
  lastUpdated: string;
  firstUserText: string;
}

/**
 * 模型可用性探测结果（GET /models/status 里的单条）：对候选模型真发一条微型补全请求。
 * 服务商 /models 清单里"有"不等于"能用"（免费配额按模型计），对话开始前先探一次。
 * 结构与 core/model_probe.ts 的 ModelProbeResult 一致——DTO 在协议层独立声明，
 * web/ 只允许经 @protocol 跨边界拿类型。
 */
export interface ModelProbeStatus {
  model: string;
  ok: boolean;
  kind: "ok" | "quota" | "unavailable" | "error";
  /** 失败时的错误摘要，前端 tooltip 用 */
  detail?: string;
  latencyMs?: number;
  /** 剩余配额（响应头限流字段，能拿到才有；DashScope 实测不返回） */
  quota?: string;
}

/** GET /models/status 的响应体：探测结果 + 账户级配额（智谱 trial_balance，能拿到才有） */
export interface ModelProbeStatusResponse {
  models: ModelProbeStatus[];
  /** 账户级剩余配额/余额的可读描述（服务商支持时才有，如智谱 trial_balance） */
  accountQuota?: string;
}

export interface HistoryMessageDTO {
  role: "user" | "assistant";
  content: string;
  /**
   * Grounded 引用来源：历史回放时透出的贡献（assistant 终答消息落盘时随行写入），
   * 前端据此重建与回答中 [n] 标记对应的可点击来源卡片。非终答消息 / 老会话没有该字段。
   */
  citations?: Citation[];
  outcome?: RunOutcome;
}

export interface SessionDetailDTO {
  task?: TaskRecord;
  summary: SessionSummaryDTO;
  messages: HistoryMessageDTO[];
}

export interface StatusDTO {
  model: string;
  summaryModel?: string;
  sandbox: string;
  promptHash?: string;
  skills: string[];
  mcpServers: Array<{ id: string; ok: boolean; tools?: number }>;
}

// ---------- 回合级检查点（GET /sessions/:id/checkpoints） ----------

/** 回滚范围：code=只恢复工作区文件，chat=只截断对话，all=两者都做（与 /rewind 的 c/t/a 对齐） */
export const RewindScopeSchema = z.enum(["code", "chat", "all"]);
export type RewindScope = z.infer<typeof RewindScopeSchema>;

/**
 * 一个回合级检查点：seq 是影子仓库的 ref 序号（稳定标识，删旧后仍可比对），
 * records 是快照边界处的会话记录数——回滚对话即截断到该条数。
 */
export interface CheckpointSummaryDTO {
  seq: number;
  /** ISO 8601 */
  time: string;
  /** 该回合的用户输入（列表标题） */
  input: string;
  records: number;
}

export interface CheckpointListDTO {
  /** AGENT_CHECKPOINTS=0 时为 false：面板据此显示"已关闭"而不是空列表 */
  enabled: boolean;
  /** 最新在前 */
  checkpoints: CheckpointSummaryDTO[];
}

/** POST /sessions/:id/checkpoints/rewind 的响应：lines 为与 REPL 同口径的执行输出 */
export interface RewindResponse {
  ok: true;
  seq: number;
  scope: RewindScope;
  /** 恢复的文件数（scope 含 code 才有） */
  restored?: number;
  /** 删除的新增文件数（scope 含 code 才有） */
  deleted?: number;
  /** 截断后的会话记录数（scope 含 chat 才有） */
  records?: number;
  lines: string[];
  /** "history" = 会话文件被改写，前端应重拉历史与 session 详情 */
  refresh?: "history";
}

// ---------- MCP 目录（GET /mcp/catalog、GET /mcp/resource） ----------

/** 面板列表用的一条资源摘要（不含正文；正文按需读，见 McpResourceReadDTO） */
export interface McpResourceSummaryDTO {
  serverId: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpPromptArgumentDTO {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptSummaryDTO {
  serverId: string;
  name: string;
  description?: string;
  arguments: McpPromptArgumentDTO[];
}

/** 资源与模板清单；单侧列取失败只降级为空数组，原因进 errors 供面板提示 */
export interface McpCatalogDTO {
  resources: McpResourceSummaryDTO[];
  prompts: McpPromptSummaryDTO[];
  errors?: string[];
}

/** 一条资源内容：文本（超 20k 截断）或二进制字节数，二选一 */
export interface McpResourceContentDTO {
  uri: string;
  mimeType?: string;
  text?: string;
  truncated?: boolean;
  blobBytes?: number;
}

export interface McpResourceReadDTO {
  contents: McpResourceContentDTO[];
}

// ---------- 后台脚本任务（GET /jobs） ----------

/**
 * 一条后台任务记录：结构对齐 core/job_store.ts 的 JobRecord（DTO 在协议层独立声明）。
 * 状态在服务器**读取时**校正：到点回收标 timed_out；进程已消失又没收到 close 标 exited
 * 并置 reconciled（真实退出码不可知，前端不要编一个）。
 */
export interface JobSummaryDTO {
  id: string;
  /** 工作区相对路径 */
  script: string;
  args: string[];
  backend: "host" | "docker";
  status: "running" | "exited" | "timed_out" | "killed";
  exitCode?: number;
  /** epoch 毫秒 */
  startedAt: number;
  deadlineAt: number;
  endedAt?: number;
  reconciled?: boolean;
  container?: string;
}

/**
 * GET /jobs/:id/log 的一帧：按字节偏移续拉即 tail -f。
 * reset=true 表示这是尾部快照（首屏或文件变短），前端应清空后整体替换。
 */
export interface JobLogChunkDTO {
  stream: "stdout" | "stderr";
  text: string;
  /** 下次请求的 after 偏移 */
  offset: number;
  /** 日志文件当前字节数（可展示进度） */
  size: number;
  reset: boolean;
}

/** POST /approvals/:id 的请求体：accept 可带表单内容，decline 不带 */
export interface ApprovalDecisionBody {
  action: "accept" | "decline";
  content?: Record<string, string | number | boolean | string[]>;
}
