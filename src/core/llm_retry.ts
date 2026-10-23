import OpenAI from "openai";

/** 传输类可重试失败：连接中断/超时、429 限流、5xx 服务端错误。
 * 拒绝、截断、格式不合法等语义失败不属于此类，重试不会有不同结果。 */
export function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

/** 指数退避 + 抖动：base * 2^(attempt-1) + 随机抖动，attempt 从 1 计。 */
export function retryDelayMs(baseDelayMs: number, attempt: number): number {
  return Math.round(baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs);
}
