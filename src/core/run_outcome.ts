/** 运行正常结束不等于任务经过验收。answered 只表示已给出完整回答。 */
export const STOP_REASONS = [
  "answer", "plan_incomplete", "empty_response", "model_refusal", "content_filter",
  "output_truncated", "incomplete_stream", "budget_exceeded", "iteration_limit",
  "cancelled", "error",
] as const;
export type StopReason = typeof STOP_REASONS[number];

export interface RunOutcome {
  runStatus: "completed" | "stopped" | "failed";
  taskStatus: "answered" | "incomplete" | "blocked";
  stopReason: StopReason;
  finishReason: string | null;
  refusal: string | null;
  errorMessage?: string | undefined;
}

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  answer: "已回答（未独立验收）",
  plan_incomplete: "计划仍有未完成步骤",
  empty_response: "模型返回空内容",
  model_refusal: "模型拒绝回答，尚未完成判断",
  content_filter: "内容被过滤，尚未完成判断",
  output_truncated: "模型输出被截断",
  incomplete_stream: "响应流未完整结束",
  budget_exceeded: "达到运行预算上限",
  iteration_limit: "达到迭代上限",
  cancelled: "已中断本次运行",
  error: "运行出错",
};

export function runOutcome(
  stopReason: StopReason,
  response?: { finishReason: string | null; refusal: string | null },
): RunOutcome & { success: boolean } {
  return {
    success: stopReason === "answer",
    runStatus: stopReason === "error" ? "failed"
      : stopReason === "answer" || stopReason === "plan_incomplete" ? "completed" : "stopped",
    taskStatus: stopReason === "answer" ? "answered"
      : stopReason === "model_refusal" || stopReason === "content_filter" ? "blocked" : "incomplete",
    stopReason,
    finishReason: response?.finishReason ?? null,
    refusal: response?.refusal ?? null,
  };
}

/** 只依据接口字段识别；不把回答中的“抱歉/不能”等普通词汇当成拒绝。 */
export function responseStopReason(response: {
  finishReason: string | null;
  refusal: string | null;
  interrupted?: boolean;
}): StopReason | undefined {
  if (response.finishReason === "content_filter") return "content_filter";
  if (response.refusal?.trim()) return "model_refusal";
  if (response.finishReason === "length") return "output_truncated";
  if (response.interrupted) return "incomplete_stream";
  return undefined;
}

/** 兼容服务商明确的策略错误码；不凭 HTTP 状态或错误描述猜测拒绝。 */
export function isContentPolicyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; error?: { code?: unknown; innererror?: { code?: unknown } } };
  const codes = [e.code, e.error?.code, e.error?.innererror?.code];
  return codes.some((code) => typeof code === "string" &&
    ["content_filter", "content_policy_violation", "responsibleaipolicyviolation"].includes(code.toLowerCase()));
}
