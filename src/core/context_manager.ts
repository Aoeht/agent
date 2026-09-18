// src/core/context-manager.ts
import OpenAI from "openai";
import { Message } from "./types";

interface ContextConfig {
  maxTokens: number;        // 模型上下文上限
  reserveTokens: number;    // 预留给当前回复的token
  summaryModel: string;     // 用于摘要的廉价模型
}

export class ContextManager {
  private client: OpenAI;
  private config: ContextConfig;

  constructor(config: ContextConfig) {
    this.client = new OpenAI();
    this.config = config;
  }
   private estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") chars += msg.content.length;
      if ("tool_calls" in msg && msg.tool_calls) {
        chars += JSON.stringify(msg.tool_calls).length;
      }
    }
    return Math.ceil(chars / 3); // 中英混合取折中值
  }
  /**
   * ✅ 智能压缩消息历史，确保不超过 token 预算
   */
  async compress(messages: Message[]): Promise<Message[]> {
   
    if (messages.length <= 2) return messages;

  // ✅ 未超预算时直接返回，不做任何处理
  
    const totalTokens = this.estimateTokens(messages);
    const budget = this.config.maxTokens - this.config.reserveTokens;

    if (totalTokens <= budget) return messages;

    // 策略：保留 system + 最近N条 + 中间摘要
    const systemMsg = messages.find((m) => m.role === "system");
    const recentMessages: Message[] = [];
    let recentTokens = 0;
    const recentBudget = Math.floor(budget * 0.4); // 40%预算给最近消息

    // 从后往前取最近消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === "system") continue;
      const msgTokens = this.estimateTokens([msg]);
      if (recentTokens + msgTokens > recentBudget) break;
      recentMessages.unshift(msg);
      recentTokens += msgTokens;
    }

    // 对中间历史做摘要
    const middleMessages = messages.filter(
      (m) => m.role !== "system" && !recentMessages.includes(m)
    );
    // 对中间历史做摘要


    let summaryContent = "";
    if (middleMessages.length >= 2) {
      summaryContent = await this.summarize(middleMessages);
    }

    // 重组消息
    const compressed: Message[] = [];
    if (systemMsg) compressed.push(systemMsg);
    if (summaryContent) {
      compressed.push({
        role: "user",
        content: `[Historical Context Summary]\n${summaryContent}`,
      });
      compressed.push({
        role: "assistant",
        content: "Understood. I have the historical context summarized above.",
      });
    }
    compressed.push(...recentMessages);

    return compressed;
  }

  private async summarize(messages: Message[]): Promise<string> {
    const conversationText = messages
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[non-text]"}`)
      .join("\n");

    const resp = await this.client.chat.completions.create({
      model: this.config.summaryModel,
      messages: [
        {
          role: "system",
          content:
            "Summarize the following conversation in 3-5 bullet points. Focus on: key decisions, tool call results, and unresolved questions. Be concise.",
        },
        { role: "user", content: conversationText },
      ],
      max_tokens: 300,
      temperature: 0,
    });

    return resp.choices[0]?.message?.content ?? "No summary available.";
  }

  /**
   * ✅ 粗略 token 估算（1 token ≈ 4 chars for English, ~2 chars for Chinese）
   * 生产环境建议用 tiktoken 精确计算
   */

}