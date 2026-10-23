import { TeamPlanSchema, parseSubmission, parseReview, type Submission, type TeamReview,
  type ReviewCheck, type TeamPlan, type TeamTask } from "./team_contracts";
export { TeamPlanSchema } from "./team_contracts";
export type { TeamPlan, TeamTask } from "./team_contracts";
import type { AgentResult, ToolRuntime } from "./types";
import type { RunBudgetLimits } from "./run_budget";
import type { RunOutcome } from "./run_outcome";
import type { Citation } from "./citations";

export type ChildState = "pending" | "running" | "answered" | "failed" | "skipped" | "cancelled";
export interface ChildResult extends RunOutcome {
  finalAnswer: string | null;
  totalTokens: number;
  toolCallsCount: number;
  citations: Citation[];
  submission?: Submission;
  review?: TeamReview;
}
export interface ChildRecord {
  parentRunId: string;
  task: TeamTask;
  state: ChildState;
  round: number;
  mode: "work" | "review";
  result?: ChildResult;
  reason?: string;
}

/** Validate the entire DAG before creating even one child. */
export function validateTeamPlan(input: unknown, maxTasks = 6, externalIds: ReadonlySet<string> = new Set()): TeamPlan {
  const plan = TeamPlanSchema.parse(input);
  if (plan.tasks.length > maxTasks) throw new Error(`子任务数量不能超过 ${maxTasks}`);
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  if (byId.size !== plan.tasks.length) throw new Error("子任务 ID 重复");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("任务依赖存在循环");
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) {
      if (externalIds.has(id)) return;
      throw new Error(`任务依赖不存在：${id}`);
    }
    if (new Set(task.checks.map(check => check.id)).size !== task.checks.length) throw new Error(`任务 ${id} 的检查项 ID 重复`);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error(`任务 ${id} 的依赖重复`);
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of plan.tasks) visit(task.id);
  return plan;
}

/** Reservations prevent concurrent children from each spending the same allowance.
 * Like RunBudget, token limits are checked between requests, not a billing hard cap. */
export class TeamTokenBudget {
  used = 0;
  private reserved = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("总 token 预算必须是正整数");
  }
  get available(): number { return Math.max(0, this.limit - this.used - this.reserved); }
  reserve(tokens: number): ((actual: number) => void) | undefined {
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > this.available) return undefined;
    this.reserved += tokens;
    let settled = false;
    return (actual) => {
      if (settled) throw new Error("预算不能重复结算");
      settled = true;
      this.reserved -= tokens;
      // Missing/invalid accounting conservatively charges the allocation.
      this.used += Number.isFinite(actual) && actual >= 0 ? Math.ceil(actual) : tokens;
    };
  }
}

export interface ChildExecution {
  parentRunId: string;
  userGoal: string;
  task: TeamTask;
  dependencies: ChildRecord[];
  budget: RunBudgetLimits;
  runtime: ToolRuntime;
  round: number;
  mode: "work" | "review";
  previous?: ChildRecord;
  feedback: ReviewCheck[];
  reviewTargets: ChildRecord[];
  /** 宿主安排的一次性格式修复：重放该任务上一次的最终回答与校验错误，只修正输出格式。
   * 修复运行不提供检索工具，消耗并入原任务的预算结算。 */
  repair?: { previousAnswer: string; validationError: string };
}
export interface ChildRunner {
  run(): Promise<AgentResult>;
  shutdown(): Promise<unknown>;
}
export type ChildFactory = (execution: ChildExecution) => ChildRunner;
export interface SchedulerOptions {
  concurrency: number;
  maxTasks: number;
  childTokens: number;
  childToolCalls: number;
  /** 单个子任务墙钟上限（毫秒）；0 或缺省表示仅按 remainingTeamMs 派生。 */
  childTimeoutMs?: number;
}

export class AgentScheduler {
  constructor(private readonly options: SchedulerOptions, private readonly createChild: ChildFactory) {
    for (const key of ["concurrency", "maxTasks", "childTokens", "childToolCalls"] as const) {
      const value = options[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须是正整数`);
    }
    if (options.concurrency > 8 || options.maxTasks > 8) throw new Error("第一版最多支持 8 个任务/并发槽位");
    if (options.childTimeoutMs !== undefined && (!Number.isSafeInteger(options.childTimeoutMs) || options.childTimeoutMs < 0)) {
      throw new Error("childTimeoutMs 必须是非负整数");
    }
  }

  async run(input: {
    parentRunId: string;
    userGoal: string;
    plan: TeamPlan;
    budget: TeamTokenBudget;
    signal: AbortSignal;
    onTask?: (record: ChildRecord) => void;
    round?: number;
    mode?: "work" | "review";
    context?: ChildRecord[];
    feedback?: ReviewCheck[];
    /** 团队剩余毫秒数；每次启动子任务时现取，用于派生子任务墙钟上限。 */
    remainingTeamMs?: () => number;
  }): Promise<ChildRecord[]> {
    const context = structuredClone(input.context ?? []);
    const plan = validateTeamPlan(input.plan, this.options.maxTasks, new Set(context.map(record => record.task.id)));
    const records: ChildRecord[] = plan.tasks.map(task => ({ parentRunId: input.parentRunId, task, state: "pending",
      round: input.round ?? 0, mode: input.mode ?? "work" }));
    const byId = new Map([...context, ...records].map(record => [record.task.id, record]));
    const active = new Map<string, Promise<void>>();
    const notify = (record: ChildRecord) => input.onTask?.(structuredClone(record));
    const execute = async (record: ChildRecord, settle: (actual: number) => void) => {
      let child: ChildRunner | undefined;
      let actual = this.options.childTokens;
      try {
        input.signal.throwIfAborted();
        // 每个子任务都带墙钟上限：取固定配置与团队剩余时间的较小值，防止单个慢任务吃满全局超时。
        const wallClockMs = Math.min(
          this.options.childTimeoutMs && this.options.childTimeoutMs > 0 ? this.options.childTimeoutMs : Number.POSITIVE_INFINITY,
          input.remainingTeamMs ? Math.max(1_000, Math.floor(input.remainingTeamMs())) : Number.POSITIVE_INFINITY);
        const budgetLimits: RunBudgetLimits = { maxTotalTokens: this.options.childTokens,
          maxToolCalls: this.options.childToolCalls,
          maxToolCallsPerName: Math.min(12, this.options.childToolCalls) };
        if (Number.isFinite(wallClockMs)) budgetLimits.maxWallClockMs = wallClockMs;
        const execution: ChildExecution = {
          parentRunId: input.parentRunId, userGoal: input.userGoal, task: structuredClone(record.task),
          dependencies: record.task.dependsOn.map(id => structuredClone(byId.get(id)!)),
          budget: budgetLimits,
          // Do not leak parent task controllers or budget-extension callbacks to children.
          runtime: { signal: input.signal },
          round: record.round, mode: record.mode,
          ...(context.find(item => item.task.id === record.task.id)
            ? { previous: context.find(item => item.task.id === record.task.id)! } : {}),
          feedback: structuredClone((input.feedback ?? []).filter(check => check.taskId === record.task.id)),
          reviewTargets: record.mode === "review" ? context : [],
        };
        child = this.createChild(execution);
        const result = await child.run();
        actual = result.totalTokens;
        const { finalAnswer, totalTokens, toolCallsCount, citations, runStatus, taskStatus, stopReason,
          finishReason, refusal, taskId, runId, errorMessage } = result;
        record.result = { finalAnswer, totalTokens, toolCallsCount, citations, runStatus, taskStatus, stopReason,
          finishReason, refusal, taskId, runId, errorMessage };
        record.state = input.signal.aborted || stopReason === "cancelled" ? "cancelled"
          : runStatus === "completed" && ["answered", "verified"].includes(taskStatus) && finalAnswer?.trim()
            ? "answered" : "failed";
        if (record.state !== "answered") record.reason = errorMessage ?? stopReason;
        if (record.state === "answered") {
          const accepted = (candidate: AgentResult) => candidate.runStatus === "completed" &&
            ["answered", "verified"].includes(candidate.taskStatus) && !!candidate.finalAnswer?.trim();
          try {
            if (record.mode === "review") record.result.review = parseReview(finalAnswer!, context);
            else record.result.submission = parseSubmission(finalAnswer!, record.task);
          } catch (error) {
            // 结构校验失败先走一次无工具格式修复，远比等复核补查整轮重跑便宜；仍失败才判 failed。
            const validationError = error instanceof Error ? error.message : String(error);
            input.signal.throwIfAborted();
            const repairChild = this.createChild({ ...execution, repair: { previousAnswer: finalAnswer!, validationError } });
            try {
              const repaired = await repairChild.run();
              actual += repaired.totalTokens;
              if (!accepted(repaired)) throw new Error(repaired.errorMessage ?? repaired.stopReason ?? "修复运行未给出回答");
              if (record.mode === "review") record.result.review = parseReview(repaired.finalAnswer!, context);
              else record.result.submission = parseSubmission(repaired.finalAnswer!, record.task);
              record.result.finalAnswer = repaired.finalAnswer;
              record.result.totalTokens += repaired.totalTokens;
              record.reason = "首次结构化输出未通过校验，已由一次性无工具修复接受";
            } catch (repairError) {
              record.state = "failed";
              record.reason = `结构化结果无效：${validationError}；格式修复未成功：${
                repairError instanceof Error ? repairError.message : String(repairError)}`;
            } finally {
              try { await repairChild.shutdown(); }
              catch (closeError) {
                record.state = input.signal.aborted ? "cancelled" : "failed";
                record.reason = `子 Agent 清理失败：${String(closeError)}`;
              }
            }
          }
        }
      } catch (error) {
        record.state = input.signal.aborted ? "cancelled" : "failed";
        record.reason = error instanceof Error ? error.message : String(error);
        if (!child) actual = 0;
      } finally {
        try { await child?.shutdown(); }
        catch (error) {
          record.state = input.signal.aborted ? "cancelled" : "failed";
          record.reason = `子 Agent 清理失败：${String(error)}`;
        }
        settle(actual);
        notify(record);
      }
    };

    // Promise.race frees a slot as soon as any child finishes; no wave/barrier scheduling.
    try {
      while (records.some(record => record.state === "pending") || active.size) {
        for (const record of records) {
          if (record.state !== "pending") continue;
          if (input.signal.aborted) {
            record.state = "cancelled";
            record.reason = "父任务已取消";
            notify(record);
            continue;
          }
          const deps = record.task.dependsOn.map(id => byId.get(id)!);
          if (deps.some(dep => ["failed", "skipped", "cancelled"].includes(dep.state))) {
            record.state = "skipped";
            record.reason = "依赖任务未成功回答";
            notify(record);
            continue;
          }
          if (deps.some(dep => dep.state !== "answered") || active.size >= this.options.concurrency) continue;
          const settle = input.budget.reserve(this.options.childTokens);
          if (!settle) {
            if (active.size) continue; // A running child may release its unused allocation.
            record.state = "skipped";
            record.reason = "剩余预算不足以启动子任务";
            notify(record);
            continue;
          }
          record.state = "running";
          notify(record);
          const pending = execute(record, settle).finally(() => { active.delete(record.task.id); });
          active.set(record.task.id, pending);
        }
        if (active.size) await Promise.race(active.values());
      }
      return records;
    } finally {
      // Do not return while launched children still own resources.
      await Promise.allSettled(active.values());
    }
  }
}
