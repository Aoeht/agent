import { z } from "zod";

// ✅ Zod v4 中 z.record() 需要两个参数：keySchema + valueSchema
// ✅ 给 execute 一个明确的运行时类型（不再依赖 zod 推导）
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: unknown) => Promise<unknown>;
}

// Schema 仅用于验证外部输入，内部类型用 interface 保证
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.any()),
});

// ✅ Agent 消息类型（严格对齐 OpenAI API）
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// ✅ 只保留 function call 类型，排除 custom tool call
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ✅ Agent 运行结果
export interface AgentResult {
  success: boolean;
  messages: Message[];
  finalAnswer: string | null;
  toolCallsCount: number;
  totalTokens: number;
}