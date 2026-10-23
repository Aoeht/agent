// src/core/budget_prompt.ts
/**
 * 预算越线提示的共用文案：CLI 用 readline 问 y/N，Web 用审批卡（accept=追加）。
 * 额度怎么加由 RunBudget.proposeExtension 决定，这里只负责把"命中了什么、用了多少、
 * 追加后是多少"说清楚，两个入口不各写一套。
 */
import type { BudgetExtensionRequest } from "./run_budget";

export function formatBudgetExtensionPrompt(request: BudgetExtensionRequest): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  const { used, current, next } = request;
  switch (request.reason) {
    case "max_total_tokens":
      return `本次运行 token 预算已用尽（已用 ${fmt(used.totalTokens)} / 上限 ${fmt(current.maxTotalTokens ?? 0)}）。追加到 ${fmt(next.maxTotalTokens ?? 0)} 继续本轮？`;
    case "max_tool_calls":
      return `本次运行工具调用次数已达上限（已用 ${fmt(used.toolCalls)} / 上限 ${fmt(current.maxToolCalls ?? 0)}）。追加到 ${fmt(next.maxToolCalls ?? 0)} 次继续本轮？`;
    case "max_tool_calls_per_name":
      return `单个工具的调用次数已达上限（${fmt(current.maxToolCallsPerName ?? 0)} 次）。追加到 ${fmt(next.maxToolCallsPerName ?? 0)} 次继续本轮？`;
    case "max_wall_clock":
      return `本次运行时长已达上限（已用 ${minutes(used.elapsedMs)}）。再追加 ${minutes(current.maxWallClockMs ?? 0)} 继续本轮？`;
  }
}

/** CLI 的 y/N 解析：只认明确的肯定答复；空行、EOF、其它输入都按不追加处理 */
export function acceptedBudgetExtension(answer: string | null): boolean {
  return answer !== null && /^(y|yes|是|好|继续|追加)$/i.test(answer.trim());
}
