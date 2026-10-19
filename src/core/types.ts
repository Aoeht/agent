import { z } from "zod";
import OpenAI from "openai";
import type { BudgetStopReason } from "./run_budget";

// 直接使用官方定义的类型
// type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
// ✅ Zod v4 中 z.record() 需要两个参数：keySchema + valueSchema
// ✅ 给 execute 一个明确的运行时类型（不再依赖 zod 推导）

// 工具运行时上下文：目前只有取消信号，MCP 调用会一路透传下去
export interface ToolRuntime {
  signal?: AbortSignal;
  /** 本地可信工具提供的图片附件；不经 JSON 文本或 trace 传递。 */
  emitImage?: (image: { dataUrl: string; label: string }) => void;
  requestHuman?: (prompt: string, signal: AbortSignal) => Promise<string | null>;
  /** 单次 run 内失败的浏览器网址，防止模型反复打断用户验证。 */
  browserFailures?: Set<string>;
}

/**
 * MCP `prompts/get` 返回消息的 role（规范允许 system/user/assistant）。
 * Server 可以用 system 角色下发模板自带的约束，渲染时不能压平成 user ——
 * 那会把 System 层的优先级降级成 User 层。
 */
export type McpPromptRole = "system" | "user" | "assistant";

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * LLM 可见的 JSON Schema。第一方工具经 defineTool 创建时从 Zod schema 派生（单一事实来源）；
   * MCP 工具为 Server 下发的 inputSchema 原文，入参由 Server 按 MCP 协议自行校验。
   */
  parameters?: Record<string, unknown>;
  /**
   * 允许与同批调用并发执行：只读无副作用的工具，或写入已串行化且幂等的工具
   * （如 rag_search，缓存写入走跨进程文件锁 + 进程内写链，见 knowledge_store.withLock）。
   */
  parallelSafe?: boolean;
  execute: (args: unknown, runtime?: ToolRuntime) => Promise<unknown>;
}

/** 把 ZodError 压成 "字段: 消息" 列表，便于作为 error observation 直接回给模型 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * 第一方工具的构造器：Zod schema 是唯一事实来源，不再手写第二份 JSON Schema。
 * - JSON Schema 在创建时派生一次（io: "input"，带 default 的字段不进 required）并缓存进
 *   parameters，toOpenAITools 每轮请求零开销。
 * - execute 收到的入参先过 schema 校验：默认值填充、trim 等变换统一生效，业务代码拿到
 *   的是带类型的解析结果；校验失败抛出字段级错误信息（registry 会转成 error observation）。
 *   直连 tool.execute()（测试、脚本）同样走校验，语义与经注册表调用完全一致。
 */
export function defineTool<T extends z.ZodType>(config: {
  name: string;
  description: string;
  schema: T;
  parallelSafe?: boolean;
  execute: (args: z.output<T>, runtime?: ToolRuntime) => Promise<unknown>;
}): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    parameters: z.toJSONSchema(config.schema, { io: "input" }) as Record<string, unknown>,
    ...(config.parallelSafe !== undefined ? { parallelSafe: config.parallelSafe } : {}),
    // async 包装：校验失败必须以 rejected promise 形式抛出（契约是 Promise<unknown>），
    // 否则直连 execute 的调用方会在拿到 Promise 之前遭遇同步异常
    execute: async (args: unknown, runtime?: ToolRuntime): Promise<unknown> => {
      const parsed = config.schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments for ${config.name}: ${formatZodIssues(parsed.error)}`);
      }
      return config.execute(parsed.data, runtime);
    },
  };
}

// ✅ Agent 消息类型（严格对齐 OpenAI API）

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }          // ← 允许数组
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// ✅ 只保留 function call 类型，排除 custom tool call
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ✅ 每一步（一次 LLM 调用 + 工具执行）的详细信息
export interface StepInfo {
  iteration: number;
  /** 本轮 LLM 单次调用消耗的 Token */
  tokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 本轮 LLM 的文本输出（思考过程或解释，可能为 null） */
  llmContent: string | null;
  /** 该步骤执行的所有工具调用详情 */
  toolCalls: {
    id: string;
    name: string;
    arguments: string;
    result: string;
    resultPreview: string; // 方便日志查看
  }[];
}

// ✅ Agent 运行结果
export interface AgentResult {
  success: boolean;
  messages: Message[];
  finalAnswer: string | null;
  toolCallsCount: number;
  totalTokens: number;
  /** 每步的详细 token 与工具调用记录 */
  steps: StepInfo[];
  /** 因运行预算越线而提前停止时记录原因；正常结束为 undefined */
  budgetStopped?: BudgetStopReason | undefined;
}
