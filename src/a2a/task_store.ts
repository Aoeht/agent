// src/a2a/task_store.ts
/**
 * A2A Task 存储与状态机承载（评估文档路线图阶段 3 的轻量版）。
 *
 * - 内存 Map 是事实来源；每次状态变化追加一行快照到 .agent-a2a/tasks.jsonl（审计留痕），
 *   重启时回放：终态照原样恢复，非终态如实标记 FAILED——进程死了任务不可能还在 WORKING，
 *   谎报状态比丢状态更糟（跨重启续跑是后续阶段，见 docs/A2A实现说明.md 范围外清单）。
 * - 取消通道：每个在跑任务挂一个 AbortController；CancelTask 语义是"请求取消"，
 *   真正的终态以 Agent run 返回的 stopReason 为准（进阶篇 5.5 的不对称提醒）。
 * - ListTasks 按规范：status.timestamp 降序 + 游标分页 + nextPageToken 空串结尾；
 *   includeArtifacts=false 时 artifacts 字段必须**整体省略**（不能是 [] 或 null）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { a2aTimestamp, isTerminal, type Task, type TaskState } from "./types";

export interface TaskEntry {
  task: Task;
  /** 在跑任务的取消通道；终态任务无此字段 */
  controller?: AbortController;
}

export interface ListTasksParams {
  contextId?: string;
  pageSize?: number;
  pageToken?: string;
  includeArtifacts?: boolean;
}

export interface TaskPage {
  tasks: Task[];
  nextPageToken: string;
}

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

/** 游标就是排序后列表里的起始下标（内存存储，offset 即游标；换持久化后端时再升级） */
function encodeCursor(index: number): string {
  return Buffer.from(`i:${index}`, "utf8").toString("base64url");
}

function decodeCursor(token: string): number | undefined {
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const match = /^i:(\d+)$/.exec(raw);
    return match ? Number.parseInt(match[1]!, 10) : undefined;
  } catch {
    return undefined;
  }
}

export class TaskStore {
  private readonly entries = new Map<string, TaskEntry>();
  private readonly snapshotPath: string;
  private loaded = false;

  constructor(dir?: string) {
    const base = dir ?? (process.env.AGENT_A2A_DIR?.trim() || path.join(process.cwd(), ".agent-a2a"));
    this.snapshotPath = path.join(base, "tasks.jsonl");
  }

  /** 回放快照（幂等；读失败只降级为空表，不阻塞服务启动） */
  init(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(this.snapshotPath, "utf8");
    } catch {
      return;
    }
    const latest = new Map<string, Task>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as { task?: Task };
        if (parsed.task?.id !== undefined && parsed.task.id !== "") latest.set(parsed.task.id, parsed.task);
      } catch {
        // 半行/坏行跳过：快照是追加型，后面还有更新的版本
      }
    }
    for (const task of latest.values()) {
      if (!isTerminal(task.status.state)) {
        // 重启前还在跑的任务：如实标记失败，不冒充"仍在运行"
        task.status = { state: "TASK_STATE_FAILED", timestamp: a2aTimestamp() };
      }
      this.entries.set(task.id, { task });
    }
  }

  /** 新建任务（调用方负责初始状态；返回同一个引用，之后的状态变化直接改 entry.task） */
  create(initial: { contextId: string; state: TaskState }): TaskEntry {
    this.init();
    const task: Task = {
      id: randomUUID(),
      contextId: initial.contextId,
      status: { state: initial.state, timestamp: a2aTimestamp() },
    };
    const entry: TaskEntry = { task };
    this.entries.set(task.id, entry);
    this.persist(entry);
    return entry;
  }

  get(id: string): TaskEntry | undefined {
    this.init();
    return this.entries.get(id);
  }

  /** 状态落库 + 快照追加（终态/取消等每次变化都调） */
  save(entry: TaskEntry): void {
    this.persist(entry);
  }

  list(params: ListTasksParams): TaskPage {
    this.init();
    const all = [...this.entries.values()]
      .filter((entry) => (params.contextId !== undefined ? entry.task.contextId === params.contextId : true))
      // 规范 2.5：按 status timestamp 降序（ISO Z 字符串可直接比较）
      .sort((a, b) => (b.task.status.timestamp ?? "").localeCompare(a.task.status.timestamp ?? ""));
    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, params.pageSize !== undefined && Number.isFinite(params.pageSize) ? Math.floor(params.pageSize) : PAGE_SIZE_DEFAULT)
    );
    const start = params.pageToken !== undefined && params.pageToken !== "" ? decodeCursor(params.pageToken) : 0;
    const safeStart = start !== undefined && start >= 0 && start <= all.length ? start : 0;
    const slice = all.slice(safeStart, safeStart + pageSize);
    const nextIndex = safeStart + slice.length;
    return {
      // includeArtifacts=false（默认）时 artifacts 字段整体省略，不是空数组——
      // 客户端以"字段是否存在"判断语义，[] 会被误读
      tasks: slice.map((entry) => stripArtifactsUnless(entry.task, params.includeArtifacts === true)),
      nextPageToken: nextIndex < all.length ? encodeCursor(nextIndex) : "",
    };
  }

  private persist(entry: TaskEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.snapshotPath), { recursive: true });
      fs.appendFileSync(this.snapshotPath, `${JSON.stringify({ task: entry.task })}\n`);
    } catch {
      // 快照写不进去不影响任务本身（内存仍是事实来源），审计留痕降级
    }
  }
}

function stripArtifactsUnless(task: Task, includeArtifacts: boolean): Task {
  if (includeArtifacts || task.artifacts === undefined) return task;
  const { artifacts: _omitted, ...rest } = task;
  return rest as Task;
}
