// src/a2a/projection.ts
/**
 * 本地运行结果 → 公共 A2A 结构的白名单投影（A2A 进阶篇第 6 章）。
 *
 * 信息边界是安全要求不是格式问题：AgentResult 是内部视角，messages 里塞着
 * system prompt、工具原始返回、压缩摘要——直接序列化等于把内部逻辑交给对端
 * （Opaque Execution 原则）。投影只白名单式取两样东西：
 *   - result.finalAnswer（终答文本 → 产物 + 完结消息）
 *   - 状态信息（runOutcome.stopReason → TaskState）
 * 其余字段（messages / steps / citations / 内部 taskId）**从不进入出站结构**，
 * 这不是"记得别写"，而是投影函数根本拿不到别的东西（参数只收需要的字段）。
 */
import { randomUUID } from "node:crypto";
import type { AgentResult } from "../core/types";
import type { StopReason } from "../core/run_outcome";
import { a2aTimestamp, type Artifact, type Message, type Task, type TaskState } from "./types";

/**
 * stopReason → A2A TaskState（进阶篇 6.2 的建议映射，单 Agent 版）：
 * - 正常回答（含验收通过）→ COMPLETED
 * - cancelled → CANCELED（终态不可重启）
 * - model_refusal / content_filter → REJECTED（agent 拒绝承接该任务）
 * - 其余未完成 → FAILED，stopReason 进失败消息，对端能分类
 */
export function stopReasonToTaskState(stopReason: StopReason): TaskState {
  if (stopReason === "answer" || stopReason === "verified_answer") return "TASK_STATE_COMPLETED";
  if (stopReason === "cancelled") return "TASK_STATE_CANCELED";
  if (stopReason === "model_refusal" || stopReason === "content_filter") return "TASK_STATE_REJECTED";
  return "TASK_STATE_FAILED";
}

/** 停止原因的对外文案：只描述"任务没做成"，不携带内部诊断细节（路径/提示词/工具返回） */
export function stopReasonToPublicText(stopReason: StopReason, errorMessage?: string): string {
  const labels: Partial<Record<StopReason, string>> = {
    plan_incomplete: "任务未全部完成（计划仍有未完成步骤）",
    empty_response: "任务未能产生有效输出",
    model_refusal: "模型拒绝回答该任务",
    content_filter: "内容被安全策略过滤",
    output_truncated: "输出被截断，任务未完成",
    incomplete_stream: "响应流未完整结束，任务未完成",
    budget_exceeded: "达到运行预算上限，任务未完成",
    iteration_limit: "达到迭代上限，任务未完成",
    cancelled: "任务已被取消",
    error: "任务执行出错",
    verification_failed: "自验收未通过，任务未交付",
    recovery_required: "存在待核对的中断操作，任务未交付",
  };
  const label = labels[stopReason] ?? "任务未能完成";
  // errorMessage 只保留一句话，避免内部异常栈/路径外泄
  const trimmedError = errorMessage?.trim();
  return trimmedError !== undefined && trimmedError !== "" ? `${label}：${trimmedError.split("\n")[0]}` : label;
}

export interface ProjectionResult {
  state: TaskState;
  /** 完结消息（ROLE_AGENT，role 固定，parts 只含终答文本） */
  agentMessage: Message;
  /** 产物列表：终答非空时恰好一个文本产物 */
  artifacts: Artifact[];
}

/**
 * 把一次 Agent run 投影成 A2A 的完结表示。
 * 取消的 run 也照常投影（state=CANCELED，取消前的部分结果放进消息正文供对端参考）。
 */
export function projectAgentResult(result: Pick<AgentResult, "finalAnswer" | "stopReason" | "errorMessage">): ProjectionResult {
  const state = stopReasonToTaskState(result.stopReason);
  const text = result.finalAnswer?.trim() ?? "";
  const fallback = text !== "" ? text : stopReasonToPublicText(result.stopReason, result.errorMessage);
  const agentMessage: Message = {
    role: "ROLE_AGENT",
    messageId: randomUUID(),
    parts: [{ text: fallback }],
  };
  const artifacts =
    state === "TASK_STATE_COMPLETED" && text !== ""
      ? [
          {
            artifactId: randomUUID(),
            name: "最终回答",
            parts: [{ text }],
          },
        ]
      : [];
  return { state, agentMessage, artifacts };
}

/** 投影结果套进既有 Task：状态与产物收口在这里，调用方不再手改 Task */
export function applyProjection(task: Task, projection: ProjectionResult): void {
  task.status = { state: projection.state, message: projection.agentMessage, timestamp: a2aTimestamp() };
  if (projection.artifacts.length > 0) {
    task.artifacts = projection.artifacts;
  }
}
