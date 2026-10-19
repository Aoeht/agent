// src/core/tool_outputs.ts
import fs from "node:fs/promises";
import path from "node:path";

/**
 * 工具结果进入上下文前的统一出口：单条超大结果不截断的话，
 * 压缩层救不了它——最新待消费的工具组永远原样保留，一条 8 万 token 的
 * 返回会自己顶爆请求。截断 + 落盘让"信息无损"与"token 可控"兼得：
 * 超上限先头尾截断；超过落盘阈值的整篇写入会话目录，消息中留摘要与文件路径。
 */
export interface ToolOutputPolicy {
  /** 单条结果进入上下文的 token 上限，超过则截断 */
  maxTokens: number;
  /** 超过该 token 数且配置了 offloadDir 时，整篇落盘、消息中只留摘要与路径 */
  offloadTokens: number;
  /** 落盘目录；缺省表示不落盘（只截断）。`| undefined` 是 exactOptionalPropertyTypes 下"显式传空"的写法 */
  offloadDir?: string | undefined;
  countTokens: (text: string) => number;
}

export interface ProcessedToolOutput {
  /** 实际进入上下文的文本 */
  content: string;
  fullTokens: number;
  truncated: boolean;
  offloadedPath?: string;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "tool";
}

/** token 预算 → 大致字符数（按该文本实测的 token/char 压缩率换算，中英文都适用） */
function charsForTokens(
  text: string,
  fullTokens: number,
  tokenBudget: number,
  countTokens: (t: string) => number
): number {
  if (text.length === 0 || fullTokens <= 0) return 0;
  return Math.max(1, Math.floor((text.length / fullTokens) * tokenBudget));
}

export async function processToolOutput(
  raw: string,
  toolName: string,
  policy: ToolOutputPolicy
): Promise<ProcessedToolOutput> {
  if (!raw) return { content: raw, fullTokens: 0, truncated: false };
  const fullTokens = policy.countTokens(raw);
  if (fullTokens <= policy.maxTokens) {
    return { content: raw, fullTokens, truncated: false };
  }

  if (policy.offloadDir && fullTokens > policy.offloadTokens) {
    try {
      await fs.mkdir(policy.offloadDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(
        policy.offloadDir,
        `${stamp}-${sanitizeName(toolName)}-${Math.random().toString(36).slice(2, 8)}.txt`
      );
      await fs.writeFile(filePath, raw, "utf-8");
      const headChars = charsForTokens(raw, fullTokens, Math.floor(policy.maxTokens * 0.85), policy.countTokens);
      return {
        content:
          `${raw.slice(0, headChars)}\n\n…[工具输出过长已截断：原始约 ${fullTokens} tokens，此处仅保留开头。` +
          `完整输出已保存到文件（供人工或后续程序查看）：${filePath}]…`,
        fullTokens,
        truncated: true,
        offloadedPath: filePath,
      };
    } catch {
      // 落盘失败（目录不可写等）→ 退回普通截断，别让存储问题打断 run
    }
  }

  const headBudget = Math.floor(policy.maxTokens * 0.7);
  const tailBudget = Math.floor(policy.maxTokens * 0.3);
  const headChars = charsForTokens(raw, fullTokens, headBudget, policy.countTokens);
  const tailChars = charsForTokens(raw, fullTokens, tailBudget, policy.countTokens);
  const omitted = Math.max(0, fullTokens - headBudget - tailBudget);
  return {
    content:
      `${raw.slice(0, headChars)}\n\n…[工具输出过长已截断：原始约 ${fullTokens} tokens，` +
      `省略中间约 ${omitted} tokens]…\n\n${raw.slice(raw.length - tailChars)}`,
    fullTokens,
    truncated: true,
  };
}
