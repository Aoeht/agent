// src/core/plan_store.ts
/**
 * 任务计划的状态仓：update_plan 工具是唯一的写入端，Agent 是唯一的消费端。
 *
 * 生命周期与单次 run 绑定：runLoop 开始时 reset，计划块只注入消息、不落会话历史
 * （与工具消息同待遇）——新任务就是新计划，跨 run 续聊不该幽灵般带回上一任务的清单。
 */
export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  content: string;
  status: PlanStepStatus;
}

const STATUS_LABEL: Record<PlanStepStatus, string> = {
  pending: "待执行",
  in_progress: "进行中",
  completed: "已完成",
};

const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: "⬜",
  in_progress: "▶️",
  completed: "✅",
};

/** 终端渲染（给人看）：REPL 的 plan_update 事件订阅方直接用它 */
export function formatPlanCli(steps: PlanStep[]): string {
  const completed = steps.filter((s) => s.status === "completed").length;
  const lines = steps.map(
    (s, i) => `  ${STATUS_ICON[s.status]} ${i + 1}. ${s.content}`
  );
  return [`📋 任务计划 ${completed}/${steps.length}：`, ...lines].join("\n");
}

export class PlanStore {
  private steps: PlanStep[] = [];
  /** 模型最近一次 update_plan 之后是否有变更未被 Agent 注入上下文 */
  private dirty = false;

  /** 全量替换：update_plan 每次都提交完整清单，不是增量补丁 */
  replace(steps: PlanStep[]): void {
    this.steps = steps.map((s) => ({ content: s.content, status: s.status }));
    this.dirty = true;
  }

  /** 新 run 开始清场：上一任务的计划不泄漏进本任务的上下文 */
  reset(): void {
    this.steps = [];
    this.dirty = false;
  }

  get isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** 快照拷贝：事件广播给任意多消费者，拿到手随意改不影响仓内状态 */
  getSteps(): PlanStep[] {
    return this.steps.map((s) => ({ ...s }));
  }

  /** Agent 注入上下文前消费变更标记：没有新变更就不重发计划块 */
  consumeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  /** 注入上下文的计划块正文（给模型看）：自我指令层内容，不套不可信围栏 */
  renderForContext(): string {
    const completed = this.steps.filter((s) => s.status === "completed").length;
    const lines = this.steps.map(
      (s, i) => `${i + 1}. [${STATUS_LABEL[s.status]}] ${s.content}`
    );
    return [
      `【当前任务计划】（进度 ${completed}/${this.steps.length}）`,
      "以下是你为本任务制定并维护的执行计划，按序推进：每完成一步就用 update_plan 更新对应状态；" +
        "发现计划与实际情况不符时，先修订计划再继续执行。",
      ...lines,
    ].join("\n");
  }
}
