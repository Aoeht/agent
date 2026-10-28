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

type TaskRow = { seq: number; id: string; data: string };
type ActionRow = { id: string; task_id: string; seq: number; data: string };
/** 一次事务读出的基线：记录本体 + 每行的原始 JSON，用于只回写真正变化的行 */
type Loaded = {
  records: TaskRecord[];
  taskRaw: Map<string, { seq: number; raw: string }>;
  actionRaw: Map<string, { taskId: string; seq: number; raw: string }>;
};

/**
 * 任务账本。存储不再是一行全量 JSON：动作（每次工具调用新增/更新，体量主导）单独成表，
 * 事务内按差异只写变化的那几行，其余字段留在任务行里。
 *
 * 为什么拆：单行全量回写时，一次工具调用至少 3 次事务、每次重写整段历史，累计写入随动作数
 * 平方增长（实测 400 次调用写 141 MB，每次调用 354 KB）；拆表后每次调用 2.4 KB，与历史长度无关。
 *
 * 语义不变：每次事务仍新开连接、`synchronous = FULL`（写前日志要耐断电），事务内先读全量记录
 * 再交给调用方修改，提交时按差异落盘，崩溃恢复与防重放都只看记录内容。
 * 旧文件（单行 JSON 的 task_state 表）首次打开时原地迁移。
 */
export class TaskStore {
  private static readonly activeOwners = new Set<string>();
  private memory: TaskRecord[] = [];
  private readonly token = randomUUID();
  private activeRunId: string | undefined;
  /** 表结构与旧格式迁移每实例只确认一次（CREATE/DROP 的 DDL 检查不必跟着每次事务跑） */
  private schemaChecked = false;
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
      this.ensureSchema(db);
      return db.transaction(() => {
        const loaded = this.load(db);
        const records = loaded.records;
        const result = fn(records);
        this.persist(db, records, loaded);
        return structuredClone(result);
      }).immediate();
    } finally { db.close(); }
  }

  /** 建表 + 旧格式迁移（同一事务，进程间靠 immediate 串行） */
  private ensureSchema(db: Database): void {
    if (this.schemaChecked) return;
    db.transaction(() => {
      const legacy = db.query("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='task_state'").get() as { found: number } | null;
      db.exec("CREATE TABLE IF NOT EXISTS tasks (seq INTEGER NOT NULL, id TEXT PRIMARY KEY, data TEXT NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)");
      db.exec("CREATE INDEX IF NOT EXISTS actions_by_task ON actions(task_id, seq)");
      if (!legacy) return;
      const row = db.query("SELECT data FROM task_state WHERE id=1").get() as { data: string } | null;
      const records = row ? TaskSchema.array().parse(JSON.parse(row.data)) : [];
      const insertTask = db.query("INSERT OR REPLACE INTO tasks(seq,id,data) VALUES(?,?,?)");
      const insertAction = db.query("INSERT OR REPLACE INTO actions(id,task_id,seq,data) VALUES(?,?,?,?)");
      records.forEach((task, index) => {
        const { actions, ...rest } = task;
        insertTask.run(index, task.id, JSON.stringify(rest));
        actions.forEach((action, seq) => insertAction.run(action.id, task.id, seq, JSON.stringify(action)));
      });
      db.exec("DROP TABLE task_state");
    }).immediate();
    this.schemaChecked = true;
  }

  private load(db: Database): Loaded {
    const taskRows = db.query("SELECT seq, id, data FROM tasks ORDER BY seq").all() as TaskRow[];
    const actionRows = db.query("SELECT id, task_id, seq, data FROM actions ORDER BY task_id, seq").all() as ActionRow[];
    const byTask = new Map<string, ActionRow[]>();
    for (const row of actionRows) {
      const list = byTask.get(row.task_id);
      if (list) list.push(row); else byTask.set(row.task_id, [row]);
    }
    const loaded: Loaded = { records: [], taskRaw: new Map(), actionRaw: new Map() };
    for (const row of taskRows) {
      const actions = (byTask.get(row.id) ?? []).map(action => JSON.parse(action.data) as unknown);
      loaded.records.push(TaskSchema.parse({ ...(JSON.parse(row.data) as object), actions }));
      loaded.taskRaw.set(row.id, { seq: row.seq, raw: row.data });
    }
    for (const row of actionRows) loaded.actionRaw.set(row.id, { taskId: row.task_id, seq: row.seq, raw: row.data });
    return loaded;
  }

  /** 只写变化的行：一次工具调用通常只改 1 个任务行 + 1 条动作行 */
  private persist(db: Database, records: TaskRecord[], loaded: Loaded): void {
    const upsertTask = db.query("INSERT INTO tasks(seq,id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, data=excluded.data");
    const upsertAction = db.query("INSERT INTO actions(id,task_id,seq,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_id=excluded.task_id, seq=excluded.seq, data=excluded.data");
    const deleteTask = db.query("DELETE FROM tasks WHERE id=?");
    const deleteActions = db.query("DELETE FROM actions WHERE task_id=?");
    const deleteAction = db.query("DELETE FROM actions WHERE id=?");
    const keptTasks = new Set<string>();
    const keptActions = new Set<string>();
    records.forEach((task, index) => {
      keptTasks.add(task.id);
      const { actions, ...rest } = task;
      const raw = JSON.stringify(rest);
      const previous = loaded.taskRaw.get(task.id);
      if (previous === undefined || previous.raw !== raw || previous.seq !== index) upsertTask.run(index, task.id, raw);
      actions.forEach((action, seq) => {
        keptActions.add(action.id);
        const actionJson = JSON.stringify(action);
        const prior = loaded.actionRaw.get(action.id);
        if (prior === undefined || prior.raw !== actionJson || prior.taskId !== task.id || prior.seq !== seq) {
          upsertAction.run(action.id, task.id, seq, actionJson);
        }
      });
    });
    for (const id of loaded.taskRaw.keys()) {
      if (keptTasks.has(id)) continue;
      deleteTask.run(id);
      deleteActions.run(id);
    }
    for (const id of loaded.actionRaw.keys()) if (!keptActions.has(id)) deleteAction.run(id);
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
