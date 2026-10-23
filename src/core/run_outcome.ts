import type { Verification } from "./task_types";
/** 运行正常结束不等于任务经过验收。answered 只表示已给出完整回答。 */
export const STOP_REASONS = [
  "answer", "plan_incomplete", "empty_response", "model_refusal", "content_filter",
  "output_truncated", "incomplete_stream", "budget_exceeded", "iteration_limit",
  "cancelled", "error",
  "verified_answer", "verification_failed", "recovery_required",
] as const;
export type StopReason = typeof STOP_REASONS[number];

export interface RunOutcome {
  runStatus: "completed" | "stopped" | "failed";
  taskStatus: "answered" | "verified" | "incomplete" | "blocked";
  taskId?: string | undefined;
  runId?: string | undefined;
  verification?: Verification | undefined;
  stopReason: StopReason;
  finishReason: string | null;
  refusal: string | null;
  errorMessage?: string | undefined;
}

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  verified_answer: "验收通过（已独立检查所列条件）",
  verification_failed: "验收未通过",
  recovery_required: "中断操作待核对，尚未继续执行",
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
    success: stopReason === "answer" || stopReason === "verified_answer",
    runStatus: stopReason === "error" ? "failed"
      : ["answer", "verified_answer", "verification_failed", "plan_incomplete"].includes(stopReason) ? "completed" : "stopped",
    taskStatus: stopReason === "verified_answer" ? "verified" : stopReason === "answer" ? "answered"
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

/** 兼容服务商明确的策略错误码；不凭 HTTP 状态或普通措辞猜测拒绝。 */
export function isContentPolicyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    code?: unknown;
    message?: unknown;
    error?: { code?: unknown; innererror?: { code?: unknown } };
  };
  const codes = [e.code, e.error?.code, e.error?.innererror?.code];
  if (codes.some((code) => typeof code === "string" &&
    ["content_filter", "content_policy_violation", "responsibleaipolicyviolation", "data_inspection_failed"]
      .includes(code.toLowerCase()))) {
    return true;
  }
  // DashScope/Qwen 在流式输出触发安全审核时只给 400 + 这句话，没有策略 code
  return typeof e.message === "string" && /DataInspectionFailed/i.test(e.message);
}
