// src/core/summary_call.ts
import OpenAI from "openai";

export interface SummaryUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SummaryResult {
  content: string;
  usage?: SummaryUsage;
}

/** 摘要调用瞬时失败（连接/429/5xx）的重试次数，不含首次 */
export const SUMMARY_MAX_RETRIES = 2;

/** 摘要重试的基础退避（指数 + 抖动） */
export const SUMMARY_RETRY_BASE_DELAY_MS = 500;

/** 可重试：连接中断/超时、429 限流、5xx；模型不存在/输入超限等直接换模型 */
export function isRetryableSummaryError(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

/** 可被 AbortSignal 打断的退避等待：取消不该卡在重试的 timer 上 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("摘要调用已取消"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("摘要调用已取消"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 摘要模型调用：瞬时失败退避重试；重试用尽或模型不可用（404、输入超限等）时
 * 回退下一个候选（通常是主模型），避免一次瞬时故障就丢掉摘要。
 * 空摘要不重试同一模型（多半是输出格式问题），直接换下一个候选。
 */
export async function requestSummaryWithRetry(opts: {
  /** 候选模型：首个带重试，其余各尝试一次 */
  models: string[];
  /** 每个模型的单次调用；content 为空表示模型没有给出可用摘要 */
  call: (model: string) => Promise<SummaryResult>;
  signal?: AbortSignal | undefined;
  retries?: number;
  baseDelayMs?: number;
}): Promise<SummaryResult> {
  const models = opts.models.filter((model, index, all) => Boolean(model) && all.indexOf(model) === index);
  const retries = opts.retries ?? SUMMARY_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? SUMMARY_RETRY_BASE_DELAY_MS;
  let lastError: unknown = new Error("没有可用的摘要模型");

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    const modelRetries = i === 0 ? retries : 0;
    for (let attempt = 0; attempt <= modelRetries; attempt++) {
      if (opts.signal?.aborted) throw lastError;
      try {
        const result = await opts.call(model);
        const content = result.content.trim();
        if (content) return { ...result, content };
        lastError = new Error(`摘要模型 ${model} 返回空内容`);
        break;
      } catch (error) {
        lastError = error;
        if (opts.signal?.aborted) throw error;
        if (!isRetryableSummaryError(error) || attempt === modelRetries) break;
        const delayMs = Math.round(baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs);
        await abortableSleep(delayMs, opts.signal);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
