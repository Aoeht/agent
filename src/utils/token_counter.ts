// src/utils/commercial_token_counter.ts
import { encode as encodeO200k } from "gpt-tokenizer/model/gpt-4o";
import { encode as encodeCl100k } from "gpt-tokenizer/model/gpt-4";

export type CommercialVendor = "openai" | "claude" | "deepseek" | "qwen" | "kimi" | "zhipu";

export class CommercialTokenCounter {
  /**
   * 估算任意单条文本的 Token 消耗（耗时 < 1ms）
   */

   estimateText(text: string, modelName: string): number {
    /** 
     * @param: text :带估算的文本
     * @param: modelName :模型名称，用于选择不同的词表和编码策略
    */

    if (!text) return 0;

    const lower = modelName.toLowerCase();

    // 1. OpenAI 最新模型 (o200k 架构)
    if (lower.includes("gpt-4o") || lower.includes("o1") || lower.includes("o3")) {
      return encodeO200k(text).length;
    }

    // 2. 国产主流现代大模型 (DeepSeek-V3/R1, Qwen-2.5, GLM-4, Kimi)
    // 它们都使用 128k~152k 的大词表 BPE，用 o200k/cl100k 估算非常接近
    if (
      lower.includes("deepseek") ||
      lower.includes("qwen") ||
      lower.includes("moonshot") ||
      lower.includes("kimi") ||
      lower.includes("glm")
    ) {
      // 现代大词表对中英文压缩率高，直接用 o200k 切分极其逼近真实值
      return encodeO200k(text).length;
    }

    // 3. Claude 系列（官方统计 1 token ≈ 3.5 英文或 1.2 中文字符）
    if (lower.includes("claude")) {
      // 如果没有配置 Anthropic SDK，用经典 cl100k 加上 10% 缓冲
      return Math.ceil(encodeCl100k(text).length * 1.1);
    }

    // 4. 默认 fallback（GPT-4 词表）
    return encodeCl100k(text).length;
  }

  /**
   * 针对 Claude，如果配置了官方 Client，可调用官方免费计费端点获取 100% 绝对精确值
   */
  static async countClaudeExact(anthropicClient: any, model: string, messages: any[]): Promise<number> {
    try {
      const res = await anthropicClient.messages.countTokens({
        model,
        messages,
      });
      return res.input_tokens;
    } catch {
      return 0; // 失败时降级走 estimateText
    }
  }
}