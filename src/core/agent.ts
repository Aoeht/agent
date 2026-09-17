import OpenAI from "openai";
import { toolRegistry } from "../tools/registry";
import { Message, AgentResult, ToolCall } from "./types";

interface AgentConfig {
  model: string;
  systemPrompt: string;
  maxIterations?: number;
  temperature?: number;
}

// ✅ 类型守卫：区分 function call 和 custom tool call
function isFunctionToolCall(
  tc: OpenAI.Chat.Completions.ChatCompletionMessageToolCall
): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & {
  function: { name: string; arguments: string };
} {
  return tc.type === "function" && "function" in tc;
}

export class Agent {
  private client: OpenAI;
  private config: Required<AgentConfig>;

  constructor(config: AgentConfig) {
    this.client = new OpenAI();
    this.config = {
      maxIterations: 10,
      temperature: 0,
      ...config,
    };
  }

  async run(userMessage: string): Promise<AgentResult> {
    const messages: Message[] = [
      { role: "system", content: this.config.systemPrompt },
      { role: "user", content: userMessage },
    ];

    let iterations = 0;
    let totalTokens = 0;
    let toolCallsCount = 0;

    while (iterations < this.config.maxIterations) {
      iterations++;

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        tools: toolRegistry.toOpenAITools(),
        temperature: this.config.temperature,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("No response from LLM");

      totalTokens += response.usage?.total_tokens ?? 0;
      const assistantMsg = choice.message;

      // ✅ 无工具调用 = 任务完成
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        return {
          success: true,
          messages,
          finalAnswer: assistantMsg.content,
          toolCallsCount,
          totalTokens,
        };
      }

      // ✅ 过滤并转换 tool_calls，只保留 function 类型
      const validToolCalls: ToolCall[] = [];
      for (const tc of assistantMsg.tool_calls) {
        if (isFunctionToolCall(tc)) {
          validToolCalls.push({
            id: tc.id,
            type: "function",
            function: tc.function,
          });
        }
      }

      // ✅ 将窄化后的 tool_calls 追加到消息历史
            // ✅ 构建 assistant 消息对象
      const assistantMessage: Message = {
        role: "assistant",
        content: assistantMsg.content,
      };

      // ✅ 只在有有效工具调用时才添加 tool_calls 属性
      if (validToolCalls.length > 0) {
        assistantMessage.tool_calls = validToolCalls;
      }

      messages.push(assistantMessage);

      // ✅ 执行每个有效的工具调用
      for (const toolCall of validToolCalls) {
        toolCallsCount++;
        let toolResult: string;

        try {
          const toolDef = toolRegistry.get(toolCall.function.name);
          if (!toolDef) {
            toolResult = JSON.stringify({
              error: `Unknown tool: ${toolCall.function.name}`,
            });
          } else {
            const parsedArgs = JSON.parse(toolCall.function.arguments);
            toolResult = await toolRegistry.execute(
              toolCall.function.name,
              parsedArgs
            );
          }
        } catch (parseError) {
          toolResult = JSON.stringify({
            error: `Invalid arguments: ${
              parseError instanceof Error
                ? parseError.message
                : "Parse error"
            }. Please check the schema and retry.`,
          });
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
    }

    return {
      success: false,
      messages,
      finalAnswer: null,
      toolCallsCount,
      totalTokens,
    };
  }
}