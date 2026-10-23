// src/core/run_budget.ts
/** 一次 run 允许消耗的硬预算；缺省项表示不设限。 */
export interface RunBudgetLimits {
  /** 累计 prompt+completion token 上限 */
  maxTotalTokens?: number;
  /** 累计工具调用次数上限 */
  maxToolCalls?: number;
  /** 单个工具名被调用的次数上限 */
  maxToolCallsPerName?: number;
  /** 从 run 开始算的墙钟时间上限（毫秒） */
  maxWallClockMs?: number;
}

export type BudgetStopReason =
  | "max_total_tokens"
  | "max_tool_calls"
  | "max_tool_calls_per_name"
  | "max_wall_clock";

/** 越线时向用户申请追加额度：used 是当前消耗，current/next 是追加前后的限额 */
export interface BudgetExtensionRequest {
  reason: BudgetStopReason;
  used: { totalTokens: number; toolCalls: number; elapsedMs: number };
  current: RunBudgetLimits;
  next: RunBudgetLimits;
}

/**
 * 运行预算跟踪器：Agent 在每步前后记账，越线时给出停止原因。
 * 与 AbortSignal 不同，预算是「累计消耗」而非「外部中断」的语义。
 */
export class RunBudget {
  totalTokens = 0;
  toolCalls = 0;
  readonly toolCallsByName: Record<string, number> = {};

  private readonly startedAt: number;
  private limits: RunBudgetLimits;

  constructor(limits: RunBudgetLimits = {}, private readonly now: () => number = () => Date.now()) {
    this.limits = { ...limits };
    this.startedAt = this.now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  addTokens(count: number): void {
    this.totalTokens += Math.max(0, count);
  }

  /** 记账一次工具调用；返回本次调用是否在预算内（先做前置判断再累加）。 */
  recordToolCall(name: string): boolean {
    const allowed = this.check(name) === null;
    this.toolCalls += 1;
    this.toolCallsByName[name] = (this.toolCallsByName[name] ?? 0) + 1;
    return allowed;
  }

  /**
   * 当前是否已越线；传入即将调用的工具名时一并检查 per-name 上限。
   * 只读检查，不改状态。
   */
  check(upcomingToolName?: string): BudgetStopReason | null {
    const { maxTotalTokens, maxToolCalls, maxToolCallsPerName, maxWallClockMs } = this.limits;
    if (maxWallClockMs !== undefined && this.elapsedMs >= maxWallClockMs) return "max_wall_clock";
    if (maxTotalTokens !== undefined && this.totalTokens >= maxTotalTokens) return "max_total_tokens";
    if (maxToolCalls !== undefined && this.toolCalls >= maxToolCalls) return "max_tool_calls";
    if (upcomingToolName && maxToolCallsPerName !== undefined) {
      if ((this.toolCallsByName[upcomingToolName] ?? 0) >= maxToolCallsPerName) return "max_tool_calls_per_name";
    }
    return null;
  }

  /** 当前限额快照（追加预算前展示给用户） */
  limitsSnapshot(): RunBudgetLimits {
    return { ...this.limits };
  }

  /**
   * 越线后追加一个与原上限等量的额度（墙钟按已用时长追加），返回追加后的限额快照。
   * 只计算不生效：用户确认后再 applyExtension，拒绝时原限额保持不变。
   */
  proposeExtension(reason: BudgetStopReason): RunBudgetLimits {
    const next = { ...this.limits };
    switch (reason) {
      case "max_total_tokens":
        next.maxTotalTokens = this.totalTokens + (this.limits.maxTotalTokens ?? Math.max(1, this.totalTokens));
        break;
      case "max_tool_calls":
        next.maxToolCalls = this.toolCalls + (this.limits.maxToolCalls ?? Math.max(1, this.toolCalls));
        break;
      case "max_tool_calls_per_name":
        // 逐个工具名分不清是哪一个触发的（check 未传名字），统一再给一整份额度
        next.maxToolCallsPerName = Math.max(1, (this.limits.maxToolCallsPerName ?? 1) * 2);
        break;
      case "max_wall_clock":
        next.maxWallClockMs = this.elapsedMs + (this.limits.maxWallClockMs ?? 60_000);
        break;
    }
    return next;
  }

  applyExtension(limits: RunBudgetLimits): void {
    this.limits = { ...limits };
  }

  /**
   * 越线后是否还允许再发一次「强制收尾」请求。
   * 墙钟超限说明时间已到点，放弃；token/调用次数超限时，收尾只是单次调用，
   * 值得为拿到一个真实最终答案而付出。未越线（正常迭代耗尽）同样允许。
   */
  shouldAttemptFinalize(reason: BudgetStopReason | null): boolean {
    return reason !== "max_wall_clock";
  }
}
