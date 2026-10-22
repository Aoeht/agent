import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskSchema, type TaskRecord, type AcceptanceCriterion, type Verification } from "./task_types";
import type { PlanStep } from "./plan_store";
import type { RunOutcome } from "./run_outcome";

const now = () => new Date().toISOString();
function argumentKey(raw: string): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, sort(v)])) : value;
  try { return JSON.stringify(sort(JSON.parse(raw))); } catch { return raw; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Each transaction opens/closes its connection, including on Windows. The run owner
 * prevents two CLI/Web processes from executing the same session concurrently. */
export class TaskStore {
  private static readonly activeOwners = new Set<string>();
  private memory: TaskRecord[] = [];
  private readonly token = randomUUID();
  private activeRunId: string | undefined;
  constructor(readonly filePath?: string) {}

  private transaction<T>(fn: (records: TaskRecord[]) => T): T {
    if (!this.filePath) {
      const records = structuredClone(this.memory);
      const value = fn(records);
      this.memory = records;
      return structuredClone(value);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new Database(this.filePath, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      db.exec("CREATE TABLE IF NOT EXISTS task_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
      return db.transaction(() => {
        const row = db.query("SELECT data FROM task_state WHERE id=1").get() as { data: string } | null;
        const records = row ? TaskSchema.array().parse(JSON.parse(row.data)) : [];
        const result = fn(records);
        db.query("INSERT INTO task_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
          .run(JSON.stringify(records));
        return structuredClone(result);
      }).immediate();
    } finally { db.close(); }
  }

  private recover(task: TaskRecord | undefined): void {
    if (!task?.owner) return;
    if (task.owner.pid === process.pid ? TaskStore.activeOwners.has(task.owner.token) : alive(task.owner.pid)) return;
    delete task.owner;
    task.state = "interrupted";
    task.stopReason = "process_interrupted";
    task.updatedAt = now();
    const run = task.runs.at(-1);
    // 没有 endedAt 说明这一轮没走到收尾：它的副作用记录不会被写进历史对话轮，
    // 续跑时模型看不见，不逐条核对就会把同一次外部写入静默地重做一遍
    const abandonedRunId = run && !run.endedAt ? run.id : undefined;
    for (const action of task.actions) {
      if (action.state === "started") action.state = action.needsReconciliation ? "unknown" : "no_effect";
      else if (abandonedRunId && action.runId === abandonedRunId && action.state === "returned" && action.needsReconciliation) {
        action.state = "unknown";
        action.resolution = "process_interrupted_after_return";
      }
    }
    if (run && !run.endedAt) { run.endedAt = now(); run.stopReason = "process_interrupted"; }
  }

  current(): TaskRecord | undefined {
    return this.transaction(records => { this.recover(records.at(-1)); return records.at(-1); });
  }
  list(): TaskRecord[] {
    return this.transaction(records => { this.recover(records.at(-1)); return records; });
  }

  begin(input: string, options: { fresh?: boolean; workspace?: string; criteria?: AcceptanceCriterion[] } = {}): TaskRecord {
    const task = this.transaction(records => {
      let task = records.at(-1);
      this.recover(task);
      if (task?.owner) throw new Error("当前任务已由另一个执行器运行");
      if (task?.actions.some(a => a.state === "unknown")) throw new Error("存在结果未知的工具操作，请先核对并用 /task resolve all applied 记录处理结果");
      if (!task || options.fresh || task.state === "completed" || task.state === "superseded") {
        if (task && task.state !== "completed") task.state = "superseded";
        task = { id: randomUUID(), goal: input, state: "running", createdAt: now(), updatedAt: now(),
          plan: [], criteria: options.criteria ?? [], verification: { status: options.criteria?.length ? "pending" : "not_configured", checks: [] },
          runs: [], actions: [], ...(options.workspace ? { workspace: path.resolve(options.workspace) } : {}),
          ...(options.criteria?.length ? { criteriaSource: "host" as const } : {}) };
        records.push(task);
      } else if (task.workspace !== (options.workspace ? path.resolve(options.workspace) : undefined)) {
        throw new Error("任务工作区已变化，请切回原工作区，或用 /task new 目标 开始新任务");
      }
      task.state = "running";
      task.updatedAt = now();
      task.owner = { pid: process.pid, token: this.token };
      task.runs.push({ id: randomUUID(), input, startedAt: now() });
      return task;
    });
    TaskStore.activeOwners.add(this.token);
    this.activeRunId = task.runs.at(-1)!.id;
    return task;
  }

  /** Release only after in-flight tools settle. A failed final write can then be recovered. */
  release(expectedRunId = this.activeRunId): void {
    if (expectedRunId !== this.activeRunId) return;
    TaskStore.activeOwners.delete(this.token);
    this.activeRunId = undefined;
  }

  private update(fn: (task: TaskRecord) => void): TaskRecord {
    return this.transaction(records => {
      const task = records.at(-1);
      if (!task || task.owner?.token !== this.token) throw new Error("任务执行权已失效，停止操作");
      fn(task);
      task.updatedAt = now();
      return task;
    });
  }
  setPlan(plan: PlanStep[]): TaskRecord { return this.update(task => { task.plan = structuredClone(plan); }); }
  setWaiting(waiting?: TaskRecord["waiting"]): TaskRecord {
    return this.update(task => {
      if (waiting) { task.waiting = waiting; task.state = waiting.kind === "input" ? "waiting_input" : "waiting_approval"; }
      else { delete task.waiting; task.state = "running"; }
    });
  }
  setCriteria(criteria: AcceptanceCriterion[]): TaskRecord {
    return this.update(task => {
      if (!task.workspace) throw new Error("未配置验收工作区");
      if (!task.criteria.length && task.actions.some(a => !["set_acceptance_criteria", "read_task_state", "update_plan", "ask_user"].includes(a.tool))) {
        throw new Error("请在执行业务工具之前定义验收条件，不能按已生成的结果倒推验收标准");
      }
      if (task.criteria.length && JSON.stringify(task.criteria) !== JSON.stringify(criteria)) {
        throw new Error("已有验收条件不可由模型删除或降低；需要变更目标时请用户开启新任务");
      }
      task.criteria = structuredClone(criteria);
      task.criteriaSource ??= "agent";
      task.verification = { status: "pending", checks: [] };
    });
  }
  startAction(tool: string, args: string, needsReconciliation = true): string {
    const id = randomUUID();
    this.update(task => {
      if (task.actions.some(a => a.tool === tool && a.state === "applied" && argumentKey(a.arguments) === argumentKey(args))) {
        throw new Error("该操作已由用户确认执行过，不能原样重放；请先检查实际结果");
      }
      task.actions.push({ id, runId: task.runs.at(-1)!.id, tool, arguments: args,
        needsReconciliation, state: "started", startedAt: now() });
    });
    return id;
  }
  endAction(id: string, result: string, uncertain = false): void {
    this.update(task => {
      const action = task.actions.find(a => a.id === id)!;
      // 中断时结果不可确认：只有会影响真实世界的调用才需要人工核对，其余按无影响收口
      action.state = !uncertain ? "returned" : action.needsReconciliation ? "unknown" : "no_effect";
      action.endedAt = now(); action.resultPreview = result.slice(0, 2000);
    });
  }
  finish(outcome: RunOutcome, answer: string | null, verification: Verification): TaskRecord {
    const task = this.update(task => {
      if (outcome.taskStatus === "verified" && (verification.status !== "passed" || !task.criteria.length ||
          verification.checks.length !== task.criteria.length || verification.checks.some(c => !c.passed) ||
          task.plan.some(step => step.status !== "completed") || task.actions.some(a => a.state === "unknown" || a.state === "started"))) {
        throw new Error("缺少通过验收的独立证据");
      }
      task.verification = verification;
      task.stopReason = outcome.stopReason;
      task.lastAnswer = answer;
      delete task.waiting;
      task.state = outcome.taskStatus === "verified" ? "completed"
        : outcome.taskStatus === "blocked" ? "blocked"
        : outcome.stopReason === "cancelled" ? "cancelled"
        : outcome.runStatus === "failed" ? "failed"
        : outcome.taskStatus === "answered" ? "answered" : "incomplete";
      for (const action of task.actions) if (action.state === "started") action.state = action.needsReconciliation ? "unknown" : "no_effect";
      if (task.actions.some(a => a.state === "unknown")) task.state = "interrupted";
      const run = task.runs.at(-1)!;
      run.endedAt = now(); run.stopReason = outcome.stopReason;
      delete task.owner;
    });
    this.release();
    return task;
  }

  /** Host command only: never exposed as a model tool. `all` reconciles every pending action at once. */
  resolveAction(id: string, resolution: "applied" | "not_applied", note: string): TaskRecord {
    return this.transaction(records => {
      const task = records.at(-1);
      this.recover(task);
      if (!task || task.owner) throw new Error("任务不存在或仍在运行");
      const pending = task.actions.filter(action => action.state === "unknown" && (id === "all" || action.id === id));
      if (!pending.length) throw new Error("未找到待核对的操作");
      for (const action of pending) { action.state = resolution; action.resolution = note; action.endedAt = now(); }
      task.updatedAt = now();
      return task;
    });
  }
}
