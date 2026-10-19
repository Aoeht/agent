// src/core/events.ts
import { EventEmitter } from "node:events";
import type { BudgetStopReason } from "./run_budget";
import type { PlanStep } from "./plan_store";
import type { StepInfo } from "./types";

export interface RunStartEvent {
  userMessage: string;
  /**
   * 本轮 system prompt 的指纹（12 位十六进制）。
   * 提示词没有版本号时，行为一变就没法归因到底是改了提示词还是换了模型/数据；
   * 指纹随每个 run 进 trace，"这条轨迹用的是哪版规则"就是可查的。
   */
  promptHash?: string;
}

export interface RunEndEvent {
  success: boolean;
  totalTokens: number;
  toolCallsCount: number;
  /** 完成的迭代数（含强制收尾那一次） */
  iterations: number;
  /** 因预算越线提前停止时的原因；正常结束缺省 */
  budgetStopped?: BudgetStopReason;
}

export interface StepEvent {
  step: StepInfo;
}

export interface TokenEvent {
  delta: string;
}

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  reason: string;
}

/** 模型通过 update_plan 工具更新了任务计划：steps 是更新后的全量快照 */
export interface PlanUpdateEvent {
  steps: PlanStep[];
}

/**
 * 上下文压缩动作：不做就排查不了"模型为什么忘了 X"——
 * 折叠了哪些内容、省了多少 token、摘要是否失败，都从这里走。
 */
export interface CompactEvent {
  action:
    | "stub_tool_outputs" /** 旧工具输出替换为占位符（保留调用与参数） */
    | "drop_tool_history" /** 旧工具组整体移出请求 */
    | "fold_summary" /** 旧对话轮折叠进滚动摘要 */
    | "summary_failed" /** 摘要调用失败（已降级，不中断 run） */
    | "hard_truncate" /** 摘要不可用时的最后兜底：硬截断更早对话 */
    | "emergency" /** API 报上下文超限后的强制压缩重试 */
    | "longterm_summary"; /** 跨 run 长期摘要已更新 */
  /** 受影响的消息条数（如折叠的对话条数） */
  messages?: number;
  /** 本次动作节省的 token 估算 */
  tokens?: number;
  detail?: string;
}

export interface AgentEventMap {
  run_start: RunStartEvent;
  step: StepEvent;
  token: TokenEvent;
  retry: RetryEvent;
  plan_update: PlanUpdateEvent;
  compact: CompactEvent;
  run_end: RunEndEvent;
}

export type AgentEventName = keyof AgentEventMap;

/**
 * Agent 的类型化事件总线：取代零散的 onStep/onToken/onRetry 回调。
 * CLI 渲染、trace 落盘、指标统计等任意多个消费者订阅同一事件流，互不干扰；
 * 新增观察者不再需要改 Agent 的构造参数。
 */
export class AgentEventBus extends EventEmitter {
  on<E extends AgentEventName>(event: E, listener: (payload: AgentEventMap[E]) => void): this {
    return super.on(event, listener);
  }

  once<E extends AgentEventName>(event: E, listener: (payload: AgentEventMap[E]) => void): this {
    return super.once(event, listener);
  }

  off<E extends AgentEventName>(event: E, listener: (payload: AgentEventMap[E]) => void): this {
    return super.off(event, listener);
  }

  emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): boolean {
    return super.emit(event, payload);
  }
}
