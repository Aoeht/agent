import { z } from "zod";
import type { AgentResult, ToolRuntime } from "./types";
import type { RunBudgetLimits } from "./run_budget";
import type { RunOutcome } from "./run_outcome";
import type { Citation } from "./citations";

const taskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  role: z.enum(["researcher", "analyst", "reviewer"]),
  goal: z.string().trim().min(1).max(4000),
  dependsOn: z.array(z.string()).max(8),
}).strict();
export const TeamPlanSchema = z.object({ tasks: z.array(taskSchema).min(1).max(8) }).strict();
export type TeamPlan = z.infer<typeof TeamPlanSchema>;
export type TeamTask = TeamPlan["tasks"][number];
export type ChildState = "pending" | "running" | "answered" | "failed" | "skipped" | "cancelled";
export interface ChildResult extends RunOutcome {
  finalAnswer: string | null;
  totalTokens: number;
  toolCallsCount: number;
  citations: Citation[];
}
export interface ChildRecord {
  parentRunId: string;
  task: TeamTask;
  state: ChildState;
  result?: ChildResult;
  reason?: string;
}

/** Validate the entire DAG before creating even one child. */
export function validateTeamPlan(input: unknown, maxTasks = 6): TeamPlan {
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
    if (!task) throw new Error(`任务依赖不存在：${id}`);
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
}

export class AgentScheduler {
  constructor(private readonly options: SchedulerOptions, private readonly createChild: ChildFactory) {
    for (const [key, value] of Object.entries(options)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须是正整数`);
    }
    if (options.concurrency > 8 || options.maxTasks > 8) throw new Error("第一版最多支持 8 个任务/并发槽位");
  }

  async run(input: {
    parentRunId: string;
    userGoal: string;
    plan: TeamPlan;
    budget: TeamTokenBudget;
    signal: AbortSignal;
    onTask?: (record: ChildRecord) => void;
  }): Promise<ChildRecord[]> {
    const plan = validateTeamPlan(input.plan, this.options.maxTasks);
    const records: ChildRecord[] = plan.tasks.map(task => ({ parentRunId: input.parentRunId, task, state: "pending" }));
    const byId = new Map(records.map(record => [record.task.id, record]));
    const active = new Map<string, Promise<void>>();
    const notify = (record: ChildRecord) => input.onTask?.(structuredClone(record));
    const execute = async (record: ChildRecord, settle: (actual: number) => void) => {
      let child: ChildRunner | undefined;
      let actual = this.options.childTokens;
      try {
        input.signal.throwIfAborted();
        child = this.createChild({
          parentRunId: input.parentRunId, userGoal: input.userGoal, task: structuredClone(record.task),
          dependencies: record.task.dependsOn.map(id => structuredClone(byId.get(id)!)),
          budget: { maxTotalTokens: this.options.childTokens, maxToolCalls: this.options.childToolCalls,
            maxToolCallsPerName: Math.min(12, this.options.childToolCalls) },
          // Do not leak parent task controllers or budget-extension callbacks to children.
          runtime: { signal: input.signal },
        });
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
