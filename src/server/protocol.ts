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
 *   POST   /sessions/:id/messages     body { text } → 202；忙时 409 { error }
 *   POST   /sessions/:id/cancel       → 204
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
    temperature: z.number().optional(),
    maxIterations: z.number().int().optional(),
    promptHash: z.string().optional(),
    skills: z.array(z.string()).optional(),
    mcpServers: z
      .array(z.object({ id: z.string(), ok: z.boolean(), tools: z.number().int().optional() }))
      .optional(),
  }),
  z.object({ type: z.literal("run_start"), userMessage: z.string(), promptHash: z.string().optional(),
    /** 该回合来自排队消息时携带：前端把排队芯片转成正式用户气泡（等待过的消息才有，立即执行的不带） */
    queueId: z.string().optional() }),
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
  /** 会话级配置变化（模型/温度/迭代上限，POST /sessions/:id/config 后广播） */
  z.object({
    type: z.literal("session_config"),
    model: z.string(),
    configRevision: z.number().optional(),
    contextWindow: z.number().int().optional(),
    temperature: z.number().optional(),
    maxIterations: z.number().int().optional(),
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
      "longterm_summary",
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
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type SessionConfigEvent = Extract<ServerEvent, { type: "session_config" }>;

// ---------- REST DTO ----------

export interface SessionSummaryDTO {
  sessionId: string;
  name?: string;
  messageCount: number;
  /** ISO 8601 */
  lastUpdated: string;
  firstUserText: string;
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

/** POST /approvals/:id 的请求体：accept 可带表单内容，decline 不带 */
export interface ApprovalDecisionBody {
  action: "accept" | "decline";
  content?: Record<string, string | number | boolean | string[]>;
}
