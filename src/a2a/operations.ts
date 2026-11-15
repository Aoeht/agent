// src/a2a/operations.ts
/**
 * A2A 抽象操作层（第 2 层，规范 5.x）：SendMessage / SendStreamingMessage / GetTask /
 * CancelTask / ListTasks 的语义实现，不碰 HTTP——JSON-RPC 信封、错误码翻译都在
 * jsonrpc.ts（第 3 层）。将来加 REST 绑定时本文件零改动。
 *
 * 任务生命周期（v1.0）：
 *   SUBMITTED → WORKING → COMPLETED / FAILED / CANCELED / REJECTED
 * 终态不可重启：对终态任务发后续消息会开新任务（同 contextId 关联）；
 * 工作中收到第二条消息按规范 v1.1 roadmap 的建议明确拒绝，不发明私有排队机制。
 *
 * 阻塞语义（v1.0 的 returnImmediately，与 v0.3 blocking 相反）：缺省**阻塞**到终态，
 * returnImmediately=true 才立即返回快照。所以 SendMessage 的处理函数可能长时间不返回，
 * 调用方（jsonrpc 层）不能按"快速函数调用"写超时。
 */
import { randomUUID } from "node:crypto";
import type { A2aTaskRunner } from "./runner";
import { applyProjection, projectAgentResult } from "./projection";
import { TaskStore, type TaskEntry } from "./task_store";
import {
  InvalidParamsError,
  TaskNotFoundError,
  TaskNotCancelableError,
  UnsupportedOperationError,
  a2aTimestamp,
  isTerminal,
  parseInboundMessage,
  partsToText,
  type Message,
  type StreamingResponse,
  type Task,
  type TaskState,
} from "./types";

/** 任务墙钟兜底：缺省 10 分钟（远端任务不能没有死线；到点 abort → CANCELED） */
const DEFAULT_TASK_TIMEOUT_MS = 600_000;

function intEnvFallback(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface A2aOperationsOptions {
  runner: A2aTaskRunner;
  store: TaskStore;
  taskTimeoutMs?: number;
}

export class A2aOperations {
  constructor(private readonly options: A2aOperationsOptions) {}

  // ---------- 发消息（阻塞/非阻塞共用同一条执行链） ----------

  /**
   * 返回 SendResponse oneof：{task}（本实现总是建任务）。
   * v1.0 的响应是响应消息包装——result 里带 task/message 键，不是裸 Task（规范 6.x）。
   */
  async sendMessage(params: unknown): Promise<{ task: Task } | { message: Message }> {
    const { message, returnImmediately } = this.startParams(params);
    const task = await this.execute(message, returnImmediately, undefined);
    return { task };
  }

  /**
   * 流式：emit 把流事件逐条交给传输层；本方法返回即代表流应当关闭。
   * 事件顺序：完整 Task 快照（首事件，规范 6.x）→ WORKING → 进度 → 产物 → 终态。
   */
  async sendStreamingMessage(params: unknown, emit: (response: StreamingResponse) => void): Promise<void> {
    const { message, returnImmediately } = this.startParams(params);
    await this.execute(message, returnImmediately, emit);
  }

  // ---------- 查询 ----------

  getTask(params: unknown): { task: Task } {
    const id = requireTaskId(params);
    const entry = this.options.store.get(id);
    // 不区分"不存在"与"无权访问"（规范 3.3.2：防资源枚举）
    if (entry === undefined) throw new TaskNotFoundError();
    return { task: entry.task };
  }

  cancelTask(params: unknown): { task: Task } {
    const id = requireTaskId(params);
    const entry = this.options.store.get(id);
    if (entry === undefined) throw new TaskNotFoundError();
    if (isTerminal(entry.task.status.state)) {
      throw new TaskNotCancelableError(`任务 ${id} 已是终态（${entry.task.status.state}），无法取消`);
    }
    // 语义是"请求取消"：abort 只是本地放弃等待，真正的 CANCELED 由 run 的
    // stopReason=cancelled 投影而来（进阶篇 5.5：两者不重合，别把"已发取消"当"已停"）
    entry.controller?.abort();
    return { task: entry.task };
  }

  listTasks(params: unknown): { tasks: Task[]; nextPageToken: string } {
    const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    return this.options.store.list({
      ...(typeof record.contextId === "string" && record.contextId !== "" ? { contextId: record.contextId } : {}),
      ...(typeof record.pageSize === "number" ? { pageSize: record.pageSize } : {}),
      ...(typeof record.pageToken === "string" ? { pageToken: record.pageToken } : {}),
      ...(record.includeArtifacts === true ? { includeArtifacts: true } : {}),
    });
  }

  // ---------- 推送通知：能力未实现，如实拒绝 ----------

  rejectPushNotification(): never {
    throw new UnsupportedOperationError(
      "本 Agent 未实现推送通知（capabilities.pushNotifications=false），请改用流式或轮询"
    );
  }

  // ---------- 内部 ----------

  private startParams(params: unknown): { message: Message; returnImmediately: boolean } {
    if (typeof params !== "object" || params === null) throw new InvalidParamsError("params 必须是对象");
    const record = params as Record<string, unknown>;
    const message = parseInboundMessage(record.message);
    // v1.0 语义反转：缺省阻塞（等终态），returnImmediately=true 才立即返回
    const returnImmediately = record.returnImmediately === true;
    return { message, returnImmediately };
  }

  private async execute(
    message: Message,
    returnImmediately: boolean,
    emit: ((response: StreamingResponse) => void) | undefined
  ): Promise<Task> {
    const store = this.options.store;

    // 对既有任务的引用：终态任务不可复活——按规范开新任务（同 contextId 关联）；
    // 工作中的任务拒绝第二条消息（v1.1 roadmap：攒起来等终态后作为新一轮，不私有排队）
    if (message.taskId !== undefined) {
      const existing = store.get(message.taskId);
      if (existing === undefined) throw new TaskNotFoundError();
      if (!isTerminal(existing.task.status.state)) {
        throw new InvalidParamsError(
          `任务 ${message.taskId} 仍在执行（${existing.task.status.state}）：请等终态后再发后续消息，或用 CancelTask 取消`
        );
      }
    }

    const contextId = message.contextId ?? randomUUID();
    const entry = store.create({ contextId, state: "TASK_STATE_SUBMITTED" });
    const task = entry.task;
    // history 首条是调用方的原始请求（GetTask 回查时可见；parts 原样保留）
    task.history = [message];

    entry.controller = new AbortController();
    const timeoutMs = this.options.taskTimeoutMs ?? intEnvFallback("AGENT_A2A_TASK_TIMEOUT_MS", DEFAULT_TASK_TIMEOUT_MS);
    const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    // AbortSignal.any 合并取消与死线：任一触发都终止 run
    const signal = deadline !== undefined ? AbortSignal.any([entry.controller.signal, deadline]) : entry.controller.signal;

    // 流式的首事件是完整 Task 快照（SUBMITTED），随后才是 WORKING 状态更新
    emit?.({ task: structuredCloneTask(task) });
    this.transition(task, "TASK_STATE_WORKING");
    store.save(entry);
    emit?.({ statusUpdate: toStatusUpdate(task) });

    // 非阻塞：立即回快照，任务在后台继续；客户端用 GetTask 轮询
    if (returnImmediately) {
      void this.runTask(entry, contextId, message, signal, emit);
      return task;
    }

    await this.runTask(entry, contextId, message, signal, emit);
    return task;
  }

  private async runTask(
    entry: TaskEntry,
    contextId: string,
    message: Message,
    signal: AbortSignal,
    emit: ((response: StreamingResponse) => void) | undefined
  ): Promise<void> {
    const store = this.options.store;
    const task = entry.task;
    try {
      const result = await this.options.runner.run({
        contextId,
        text: partsToText(message.parts),
        signal,
        onProgress: (progress) => {
          // 公开进度摘要：只有轮次与工具名，不转发模型文本/工具返回（进阶篇 10.1）
          if (isTerminal(task.status.state)) return;
          const tools = progress.toolNames.length > 0 ? ` · ${progress.toolNames.join(", ")}` : "";
          task.status = {
            state: "TASK_STATE_WORKING",
            message: {
              role: "ROLE_AGENT",
              messageId: randomUUID(),
              parts: [{ text: `任务执行中（第 ${progress.iteration} 轮${tools}）` }],
            },
            timestamp: a2aTimestamp(),
          };
          emit?.({ statusUpdate: toStatusUpdate(task) });
        },
      });
      // 投影是唯一的出站出口：finalAnswer/stopReason 之外的字段进不了 Task
      applyProjection(task, projectAgentResult(result));
    } catch (error) {
      // runner 本身抛错（装配失败等）：转成 FAILED，别把异常栈直接抛给传输层
      const detail = error instanceof Error ? error.message : String(error);
      task.status = {
        state: "TASK_STATE_FAILED",
        message: {
          role: "ROLE_AGENT",
          messageId: randomUUID(),
          parts: [{ text: `任务执行出错：${detail.split("\n")[0]}` }],
        },
        timestamp: a2aTimestamp(),
      };
    }
    store.save(entry);
    // 流式收尾顺序：先产物后终态，最后由传输层关流表示结束（v1.0 无 final 字段）
    if (task.artifacts !== undefined && task.artifacts.length > 0) {
      emit?.({ artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: task.artifacts[0]!, lastChunk: true } });
    }
    emit?.({ statusUpdate: toStatusUpdate(task) });
  }

  private transition(task: Task, state: TaskState): void {
    task.status = { ...task.status, state, timestamp: a2aTimestamp() };
  }
}

/** 首事件快照走一次深拷贝：后台执行会继续改原对象，别让流观察者看到悬空引用 */
function structuredCloneTask(task: Task): Task {
  return JSON.parse(JSON.stringify(task)) as Task;
}

function toStatusUpdate(task: Task): { taskId: string; contextId: string; status: Task["status"] } {
  return { taskId: task.id, contextId: task.contextId, status: task.status };
}

function requireTaskId(params: unknown): string {
  const record = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  const id = record.id ?? (record.name as string | undefined);
  if (typeof id !== "string" || id === "") throw new InvalidParamsError("params.id 必须是任务 ID");
  return id;
}
