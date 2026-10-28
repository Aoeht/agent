// web/src/state/store.tsx
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ApprovalDecisionBody,
  JobSummaryDTO,
  ModelProbeStatus,
  PlanStep,
  ServerEvent,
  SessionDetailDTO,
  SessionSummaryDTO,
  ThinkingEffort,
} from "@protocol";
import type { SessionConfigInput, Transport } from "../lib/transport";
import type { LocalImageAttachment } from "../lib/attachments";
import { toUploadBodies } from "../lib/attachments";
import { MockTransport } from "../lib/mock";
import { STOP_REASON_LABELS, type RunOutcome } from "../../../src/core/run_outcome";
import type { TaskRecord } from "../../../src/core/task_types";

// ---------- 会话内的可渲染项 ----------

/** 用户气泡上的图片标识：本端乐观气泡带 dataUrl 画缩略图，转正/重连后只剩元数据 */
export interface UserImageBadge {
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl?: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; images?: UserImageBadge[] }
  | {
      kind: "assistant";
      id: string;
      text: string;
      streaming: boolean;
      /** Grounded 引用来源：与回答中的 [n] 标记对应（仅 run_end 透传的最终回答携带） */
      citations?: ReadonlyArray<{ index: number; title: string; url?: string; snippet?: string; tool: string }>;
    }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      args: string;
      status: "running" | "done" | "error";
      result?: string;
      /** 最近一次心跳报告的已运行毫秒数（长阻塞工具才有） */
      elapsedMs?: number;
    }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  /** 斜杠命令的本地回显：⌨️ 命令原文 + 输出行（一次性 UI 态，不落盘，刷新后即消失） */
  | { kind: "command"; id: string; text: string; lines: string[] };

export type RunStatus = "idle" | "running" | "awaiting_approval" | "awaiting_input";

export interface SessionUIState {
  task?: TaskRecord;
  summary?: SessionSummaryDTO;
  items: ChatItem[];
  plan: PlanStep[];
  status: RunStatus;
  /** 会话当前生效的模型（hello / session_config 更新） */
  model?: string;
  configRevision?: number;
  /** 会话当前生效的摘要模型（历史压缩/长期摘要/会话命名/记忆提取共用） */
  summaryModel?: string;
  temperature?: number;
  maxIterations?: number;
  /** 思考程度档位（hello / session_config 更新；default 跟随厂商默认） */
  thinkingEffort?: ThinkingEffort;
  /** 模型是否接受图片输入（hello.vision）：false 时输入框的附件按钮禁用 */
  visionCapable?: boolean;
  /** 该模型上下文窗口（token）；配合 lastPromptTokens 画上下文占用 */
  contextWindow?: number;
  /** 最近一次 step 的 promptTokens ≈ 发送时的上下文长度 */
  lastPromptTokens?: number;
  /** 最近一次 step 的前缀缓存命中（provider 不上报时保持上次的值） */
  lastCachedTokens?: number;
  /** 本次页面会话里累计消耗（每次 run_end 累加） */
  accumulatedTokens?: number;
  /** 排队中的消息（忙时发送；回合结束后自动按序执行，run_start.queueId 到达时转正） */
  queue?: Array<{ id: string; text: string; imageCount?: number }>;
  /** 最近一次开始执行的排队消息 id：撤掉"响应比 SSE 慢"时重复补芯片的竞态 */
  lastRunQueueId?: string;
  /** 工具清单与本会话的关闭集合（切换会话时加载） */
  tools?: Array<{ name: string; description: string }>;
  disabledTools?: string[];
  pendingApproval?: {
    id: string;
    source?: string;
    toolName?: string;
    message: string;
    requestedSchema?: Record<string, import("@protocol").RequestedSchemaField>;
  };
  pendingInput?: { id: string; source?: string; prompt: string };
  stats?: { success: boolean; totalTokens: number; toolCallsCount: number; iterations: number; cachedPromptTokens?: number } & Partial<RunOutcome>;
  runStartIndex?: number;
  meta?: Extract<ServerEvent, { type: "hello" }>;
  cancelledByUser?: boolean;
}

interface AppState {
  transportKind: Transport["kind"];
  sessions: SessionSummaryDTO[];
  currentId: string | null;
  byId: Record<string, SessionUIState>;
  /** 可选模型清单（GET /models，启动时拉一次） */
  models: string[];
  /** 模型可用性探测（GET /models/status）：对话开始时刷新，探测失败的模型从下拉列表剔除 */
  modelStatus: ModelProbeStatus[];
  /** 账户级配额/余额（服务商支持时才有，如智谱 trial_balance） */
  modelAccountQuota?: string;
  /** 服务器级设置（目前只有沙箱根目录） */
  appSettings: { sandboxRoot?: string };
  /** 后台脚本任务（服务器全局，不属于某个会话；轮询刷新） */
  jobs: JobSummaryDTO[];
}

// ---------- Action 与 reducer ----------

type Action =
  | { type: "sessions_loaded"; sessions: SessionSummaryDTO[] }
  | { type: "models_loaded"; models: string[] }
  | { type: "model_status_loaded"; status: ModelProbeStatus[]; accountQuota?: string }
  | { type: "settings_loaded"; sandboxRoot?: string }
  | { type: "sandbox_root_changed"; sandboxRoot: string }
  | { type: "jobs_loaded"; jobs: JobSummaryDTO[] }
  | { type: "tools_loaded"; id: string; tools: Array<{ name: string; description: string }>; disabled: string[] }
  | { type: "session_created"; summary: SessionSummaryDTO }
  | { type: "session_opened"; detail: SessionDetailDTO }
  | { type: "select"; id: string | null }
  | { type: "user_sent"; id: string; text: string; images?: LocalImageAttachment[] }
  /** POST /messages 返回 queued=true 后补芯片（SSE 的 queue_changed 可能先/后到，按 id 幂等） */
  | { type: "queue_item_synced"; id: string; item: { id: string; text: string; imageCount?: number } }
  | { type: "queue_item_removed"; id: string; queueId: string }
  | { type: "event"; id: string; event: ServerEvent }
  | { type: "approval_resolved"; id: string }
  | { type: "input_resolved"; id: string }
  | { type: "run_failed_local"; id: string; message: string }
  | { type: "cancel_requested"; id: string }
  /** 斜杠命令就地执行的回显（POST 应答 handled=true）；乐观气泡在 reducer 里收回换命令卡 */
  | { type: "command_result"; id: string; text: string; lines: string[] }
  /** 会话文件被改写（/rewind）后强制重拉的历史快照（session_opened 不覆盖已有 items） */
  | { type: "history_reloaded"; id: string; detail: SessionDetailDTO };

const uid = () => Math.random().toString(36).slice(2, 10);

function notice(text: string, tone: "info" | "warn" | "error" = "info"): ChatItem {
  return { kind: "notice", id: uid(), tone, text };
}

function emptySession(): SessionUIState {
  return { items: [], plan: [], status: "idle" };
}

export function historyToItems(detail: SessionDetailDTO): ChatItem[] {
  const items = detail.messages.flatMap((message): ChatItem[] => {
    // 历史回放的引用：落盘时随终答消息写入，这里重建可点击的来源卡片
    const citations = message.citations && message.citations.length > 0 ? message.citations : undefined;
    if (message.role === "user") return [{ kind: "user", id: uid(), text: message.content }];
    const items: ChatItem[] = message.content || citations ? [{
          kind: "assistant",
          id: uid(),
          text: message.content,
          streaming: false,
          ...(citations ? { citations } : {}),
        }] : [];
    if (message.outcome && message.outcome.stopReason !== "answer") {
      items.push(notice(`${message.outcome.taskStatus === "verified" ? "✓" : "⚠️"} ${STOP_REASON_LABELS[message.outcome.stopReason]}`,
        message.outcome.taskStatus === "verified" ? "info" : "warn"));
    }
    return items;
  });
  if (detail.task) items.push(...recoveryNotices(detail.task));
  return items;
}

function recoveryNotices(task: TaskRecord): ChatItem[] {
  return task.actions.filter(action => action.state === "unknown").map(action =>
    notice(`待核对操作 ${action.tool}（${action.id}）：${action.arguments}。检查实际结果后输入 /task resolve ${action.id} applied 核对说明；若确认未执行，用 not_applied。待核对较多时可用 /task resolve all applied 核对说明 一次记录。`, "warn"));
}

/** 单个 ServerEvent → 会话状态的纯函数迁移（UI 渲染的全部逻辑都在这） */
export function applyEvent(s: SessionUIState, e: ServerEvent): SessionUIState {
  switch (e.type) {
    case "task_update":
      if (s.task && s.task.updatedAt > e.task.updatedAt) return s;
      return { ...s, task: e.task, plan: e.task.plan,
        status: e.task.state === "running" ? "running" : e.task.state === "waiting_input" ? "awaiting_input"
          : e.task.state === "waiting_approval" ? "awaiting_approval" : "idle" };
    case "hello":
      return {
        ...s,
        meta: e,
        ...((e.configRevision ?? 0) < (s.configRevision ?? 0) ? {} : {
          model: e.model,
          configRevision: e.configRevision,
          contextWindow: e.contextWindow ?? s.contextWindow,
          summaryModel: e.summaryModel ?? s.summaryModel,
          temperature: e.temperature ?? s.temperature,
          maxIterations: e.maxIterations ?? s.maxIterations,
          thinkingEffort: e.thinkingEffort ?? s.thinkingEffort,
          visionCapable: e.vision ?? s.visionCapable,
        }),
      };
    case "session_config":
      if ((e.configRevision ?? 0) < (s.configRevision ?? 0)) return s;
      return {
        ...s,
        model: e.model,
        configRevision: e.configRevision,
        contextWindow: e.contextWindow ?? s.contextWindow,
        summaryModel: e.summaryModel ?? s.summaryModel,
        temperature: e.temperature ?? s.temperature,
        maxIterations: e.maxIterations ?? s.maxIterations,
        thinkingEffort: e.thinkingEffort ?? s.thinkingEffort,
      };
    case "run_start": {
      // 排队消息转正：芯片移除、正式用户气泡此刻进入聊天流（未排队路径的气泡由 user_sent 先加）
      const queued = e.queueId !== undefined;
      const images = e.images && e.images.length > 0
        ? e.images.map(({ name, mimeType, sizeBytes }) => ({ name, mimeType, sizeBytes }))
        : undefined;
      const items = queued
        ? [...s.items, { kind: "user" as const, id: uid(), text: e.userMessage, ...(images ? { images } : {}) }]
        : s.items;
      const queue = queued ? s.queue?.filter((item) => item.id !== e.queueId) : s.queue;
      return {
        ...s,
        items,
        queue,
        ...(queued ? { lastRunQueueId: e.queueId } : {}),
        status: "running",
        stats: undefined,
        cancelledByUser: false,
        runStartIndex: items.length,
      };
    }
    case "queue_changed":
      return { ...s, queue: e.items };
    case "tools_changed":
      // 无载荷信号：订阅回调里直接重拉 listTools，这里无需迁移状态
      return s;
    case "token": {
      const items = [...s.items];
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + e.delta };
      } else {
        items.push({ kind: "assistant", id: uid(), text: e.delta, streaming: true });
      }
      return { ...s, items };
    }
    case "tool_call_start":
      return {
        ...s,
        items: [
          ...s.items,
          { kind: "tool", id: uid(), callId: e.callId, name: e.name, args: e.arguments, status: "running" },
        ],
      };
    case "tool_call_end":
      return {
        ...s,
        items: s.items.map((item) =>
          item.kind === "tool" && item.callId === e.callId
            ? {
                ...item,
                status: e.isError ? ("error" as const) : ("done" as const),
                result: e.result ?? item.result,
              }
            : item
        ),
      };
    case "tool_progress":
      return {
        ...s,
        items: s.items.map((item) =>
          item.kind === "tool" && item.callId === e.callId ? { ...item, elapsedMs: e.elapsedMs } : item
        ),
      };
    case "step": {
      // 非流式后端的兜底：把整段 LLM 输出补成一条 assistant 消息
      const last = s.items[s.items.length - 1];
      const tokens = {
        lastPromptTokens: e.tokens?.promptTokens ?? s.lastPromptTokens,
        lastCachedTokens: e.tokens?.cachedPromptTokens ?? s.lastCachedTokens,
      };
      if (e.llmContent && !(last?.kind === "assistant" && last.streaming)) {
        return {
          ...s,
          items: [...s.items, { kind: "assistant", id: uid(), text: e.llmContent, streaming: false }],
          ...tokens,
        };
      }
      return { ...s, ...tokens };
    }
    case "plan_update":
      return { ...s, plan: e.steps };
    case "compact":
      return {
        ...s,
        items: [
          ...s.items,
          notice(
            `🗜️ 上下文压缩：${e.detail ?? e.action}${e.tokens !== undefined ? `（省 ~${e.tokens} tokens）` : ""}`,
            e.action === "summary_failed" ? "warn" : "info"
          ),
        ],
      };
    case "retry":
      return {
        ...s,
        items: [
          ...s.items,
          notice(`⚠️ LLM 第 ${e.attempt} 次重试（${e.delayMs}ms 后）：${e.reason}`, "warn"),
        ],
      };
    case "approval_request":
      return {
        ...s,
        status: "awaiting_approval",
        pendingApproval: {
          id: e.id,
          source: e.source,
          toolName: e.toolName,
          message: e.message,
          requestedSchema: e.requestedSchema,
        },
      };
    case "human_input_request":
      return {
        ...s,
        status: "awaiting_input",
        pendingInput: { id: e.id, source: e.source, prompt: e.prompt },
      };
    case "run_end": {
      const citations = e.citations && e.citations.length > 0 ? e.citations : undefined;
      const items = [...s.items];
      // 只在本轮匹配终答，避免历史回答或工具前的解释吞掉本轮拒绝信息。
      let matched = false;
      for (let i = items.length - 1; i >= (s.runStartIndex ?? 0); i--) {
        const it = items[i];
        if (it?.kind === "assistant") {
          const isFinal = !matched && !!e.finalAnswer && it.text === e.finalAnswer;
          items[i] = { ...it, streaming: false, ...(isFinal && citations ? { citations } : {}) };
          if (isFinal) matched = true;
        }
      }
      if (!matched && (e.finalAnswer?.trim() || citations)) {
        items.push({
          kind: "assistant",
          id: uid(),
          text: e.finalAnswer ?? "",
          streaming: false,
          ...(citations ? { citations } : {}),
        });
      }
      if (!e.success) {
        items.push(
          notice(
            s.cancelledByUser ? "⏹️ 已中断本次运行" : `⚠️ ${e.stopReason ? STOP_REASON_LABELS[e.stopReason] : "本回合未完成"}${e.budgetStopped ? `（${e.budgetStopped}）` : ""}`,
            "warn"
          )
        );
      }
      if (e.errorMessage) items.push(notice(`详情：${e.errorMessage}`, "error"));
      if (e.task) items.push(...recoveryNotices(e.task));
      if (e.verification?.status === "passed") {
        items.push(notice(e.task && e.task.criteriaSource !== "host"
          ? "✓ 已实测模型自设的验收条件，全部通过（标准由模型提出，请自行判断它是否覆盖你的要求）。"
          : "✓ 已独立检查所列验收条件，全部通过。"));
      }
      if (e.verification?.status === "failed") {
        for (const check of e.verification.checks.filter(check => !check.passed)) {
          items.push(notice(`验收失败：${check.description}（${check.path}）：${check.detail}`, "warn"));
        }
      }
      return {
        ...s,
        ...(e.task ? { task: e.task, plan: e.task.plan } : {}),
        items,
        status: "idle",
        pendingApproval: undefined,
        pendingInput: undefined,
        accumulatedTokens: (s.accumulatedTokens ?? 0) + e.totalTokens,
        stats: {
          success: e.success,
          runStatus: e.runStatus,
          taskStatus: e.taskStatus,
          stopReason: e.stopReason,
          finishReason: e.finishReason,
          refusal: e.refusal,
          taskId: e.taskId,
          runId: e.runId,
          verification: e.verification,
          totalTokens: e.totalTokens,
          ...(e.cachedPromptTokens ? { cachedPromptTokens: e.cachedPromptTokens } : {}),
          toolCallsCount: e.toolCallsCount,
          iterations: e.iterations,
        },
      };
    }
    case "session_name":
      return {
        ...s,
        summary: s.summary ? { ...s.summary, name: e.name } : s.summary,
        items: [...s.items, notice(`🏷️ 会话名：${e.name}`)],
      };
    case "error":
      return {
        ...s,
        status: "idle",
        pendingApproval: undefined,
        pendingInput: undefined,
        items: [...s.items, notice(`❌ ${e.message}`, "error")],
      };
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "sessions_loaded":
      return { ...state, sessions: action.sessions };
    case "models_loaded":
      return { ...state, models: action.models };
    case "model_status_loaded":
      return {
        ...state,
        modelStatus: action.status,
        ...(action.accountQuota !== undefined ? { modelAccountQuota: action.accountQuota } : {}),
      };
    case "settings_loaded":
      return {
        ...state,
        appSettings: {
          ...state.appSettings,
          ...(action.sandboxRoot !== undefined ? { sandboxRoot: action.sandboxRoot } : {}),
        },
      };
    case "sandbox_root_changed":
      return { ...state, appSettings: { ...state.appSettings, sandboxRoot: action.sandboxRoot } };
    case "jobs_loaded":
      return { ...state, jobs: action.jobs };
    case "tools_loaded": {
      const s = state.byId[action.id];
      if (!s) return state;
      return {
        ...state,
        byId: { ...state.byId, [action.id]: { ...s, tools: action.tools, disabledTools: action.disabled } },
      };
    }
    case "session_created":
      return {
        ...state,
        sessions: [action.summary, ...state.sessions],
        byId: { ...state.byId, [action.summary.sessionId]: { ...emptySession(), summary: action.summary } },
      };
    case "session_opened": {
      const existing = state.byId[action.detail.summary.sessionId] ?? emptySession();
      // 已有渲染内容（比如正在跑的回合）不覆盖，只补齐摘要
      const merged: SessionUIState =
        existing.items.length > 0
          ? { ...existing, summary: action.detail.summary }
          : { ...existing, summary: action.detail.summary, items: historyToItems(action.detail),
            ...(action.detail.task ? { task: action.detail.task, plan: action.detail.task.plan } : {}) };
      return { ...state, byId: { ...state.byId, [action.detail.summary.sessionId]: merged } };
    }
    case "select":
      // id=null = 回到欢迎界面：不选中任何会话，也不往 byId 塞 null 键
      return {
        ...state,
        currentId: action.id,
        byId: action.id
          ? { ...state.byId, [action.id]: state.byId[action.id] ?? emptySession() }
          : state.byId,
      };
    case "user_sent": {
      const s = state.byId[action.id] ?? emptySession();
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.id]: {
            ...s,
            status: "running",
            stats: undefined,
            cancelledByUser: false,
            items: [
              ...s.items,
              {
                kind: "user",
                id: uid(),
                text: action.text,
                ...(action.images && action.images.length > 0 ? { images: action.images } : {}),
              },
            ],
          },
        },
      };
    }
    case "queue_item_synced": {
      const s = state.byId[action.id] ?? emptySession();
      // SSE 的 run_start 已把它转正（fetch 响应比事件慢）：不补芯片，也不回滚气泡
      if (s.lastRunQueueId === action.item.id) return state;
      // 发送时以为是空闲加了乐观气泡、实际服务端在忙：气泡收回，改由芯片承载
      const items = [...s.items];
      const last = items[items.length - 1];
      if (last?.kind === "user" && last.text === action.item.text) items.pop();
      const queue = [...(s.queue ?? [])];
      if (!queue.some((item) => item.id === action.item.id)) queue.push(action.item);
      return { ...state, byId: { ...state.byId, [action.id]: { ...s, items, queue } } };
    }
    case "queue_item_removed": {
      const s = state.byId[action.id];
      if (!s?.queue) return state;
      return {
        ...state,
        byId: { ...state.byId, [action.id]: { ...s, queue: s.queue.filter((item) => item.id !== action.queueId) } },
      };
    }
    case "event": {
      const s = state.byId[action.id] ?? emptySession();
      const next = applyEvent(s, action.event);
      const event = action.event; // 局部常量才能把类型收窄带进下面的回调
      let sessions = state.sessions;
      if (event.type === "session_name") {
        sessions = sessions.map((x) => (x.sessionId === action.id ? { ...x, name: event.name } : x));
      }
      return { ...state, byId: { ...state.byId, [action.id]: next }, sessions };
    }
    case "approval_resolved": {
      const s = state.byId[action.id];
      if (!s) return state;
      return { ...state, byId: { ...state.byId, [action.id]: { ...s, status: "running", pendingApproval: undefined } } };
    }
    case "input_resolved": {
      const s = state.byId[action.id];
      if (!s) return state;
      return { ...state, byId: { ...state.byId, [action.id]: { ...s, status: "running", pendingInput: undefined } } };
    }
    case "run_failed_local": {
      const s = state.byId[action.id] ?? emptySession();
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.id]: { ...s, status: "idle", items: [...s.items, notice(`❌ ${action.message}`, "error")] },
        },
      };
    }
    case "cancel_requested": {
      const s = state.byId[action.id];
      if (!s) return state;
      return { ...state, byId: { ...state.byId, [action.id]: { ...s, cancelledByUser: true } } };
    }
    case "command_result": {
      const s = state.byId[action.id] ?? emptySession();
      // 乐观气泡收回（空闲时 user_sent 加的那条），由命令卡承载命令原文与输出；
      // 命令不经 run 生命周期，status 拉回 idle（user_sent 曾置 running）
      const items = [...s.items];
      const last = items[items.length - 1];
      if (last?.kind === "user" && last.text === action.text) items.pop();
      items.push({ kind: "command", id: uid(), text: action.text, lines: action.lines });
      return { ...state, byId: { ...state.byId, [action.id]: { ...s, status: "idle", items } } };
    }
    case "history_reloaded": {
      const s = state.byId[action.id] ?? emptySession();
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.id]: {
            ...s,
            summary: action.detail.summary,
            items: historyToItems(action.detail),
            ...(action.detail.task ? { task: action.detail.task, plan: action.detail.task.plan } : {}),
          },
        },
      };
    }
  }
}

// ---------- Provider 与 actions ----------

export interface Store {
  state: AppState;
  current: SessionUIState | null;
  actions: {
    selectSession(id: string): void;
    /** 回到欢迎界面（不选中任何会话；不创建空会话） */
    goWelcome(): void;
    newSession(): Promise<void>;
    /** 欢迎界面首发：创建会话 →（可选）应用模型等配置 → 发送第一条消息 */
    createAndSend(text: string, config?: SessionConfigInput, images?: LocalImageAttachment[]): Promise<void>;
    send(text: string, images?: LocalImageAttachment[]): Promise<void>;
    /** 撤销一条排队中的消息 */
    removeQueued(queueId: string): Promise<void>;
    cancel(): Promise<void>;
    resolveApproval(decision: ApprovalDecisionBody): Promise<void>;
    resolveInput(text: string): Promise<void>;
    applySessionConfig(config: SessionConfigInput): Promise<void>;
    setSandboxRoot(dir: string): Promise<void>;
    toggleTool(name: string, enabled: boolean): Promise<void>;
    /** 重拉后台任务列表（面板打开时高频调用） */
    refreshJobs(): Promise<void>;
    /** 终止一个仍在跑的后台任务 */
    killJob(id: string): Promise<void>;
    /** 后台任务日志增量（面板自己持有文本状态，不进全局 store） */
    readJobLog(jobId: string, stream: "stdout" | "stderr", after?: number): Promise<import("@protocol").JobLogChunkDTO>;
  };
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({
  children,
  transport,
}: {
  children: ReactNode;
  transport?: Transport;
}) {
  // 传输实例必须整个生命周期稳定：放在 useState 初始化器里只建一次。
  // 若用默认参数 new MockTransport()，Provider 每次重渲染都会换一个实例，
  // 两个 effect 随之反复重跑，会话状态永远弹回 fixtures。
  const [resolvedTransport] = useState<Transport>(() => transport ?? new MockTransport());
  const [state, dispatch] = useReducer(reducer, {
    transportKind: resolvedTransport.kind,
    sessions: [],
    currentId: null,
    byId: {},
    models: [],
    modelStatus: [],
    appSettings: {},
    jobs: [],
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  // 首次加载：拉会话列表、模型清单与服务器设置；不自动选中——首页停在欢迎界面，
  // 点左侧会话进入，或发首条消息时才创建会话（createAndSend）
  useEffect(() => {
    let alive = true;
    void resolvedTransport.listSessions().then((sessions) => {
      if (!alive) return;
      dispatch({ type: "sessions_loaded", sessions });
    });
    void resolvedTransport.listModels().then((models) => {
      if (!alive) return;
      dispatch({ type: "models_loaded", models });
    });
    void resolvedTransport
      .listModelStatus()
      .then((result) => {
        if (!alive) return;
        dispatch({
          type: "model_status_loaded",
          status: result.models,
          ...(result.accountQuota !== undefined ? { accountQuota: result.accountQuota } : {}),
        });
      })
      .catch(() => {
        // 探测端点不可用（老版本后端）不拦 UI：下拉框只是没有可用性过滤与标注
      });
    void resolvedTransport.getSettings().then((settings) => {
      if (!alive) return;
      dispatch({ type: "settings_loaded", sandboxRoot: settings.sandboxRoot });
    });
    return () => {
      alive = false;
    };
  }, [resolvedTransport]);

  // 后台任务全局轮询：页头徽标与面板共用这份状态。面板打开时另有 1s 刷新
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void resolvedTransport
        .listJobs()
        .then((jobs) => {
          if (alive) dispatch({ type: "jobs_loaded", jobs });
        })
        .catch(() => {
          // 老版本后端没有 /jobs：静默保持空列表
        });
    };
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [resolvedTransport]);

  // 当前会话变化：拉历史 + 订阅事件流
  const currentId = state.currentId;
  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    void resolvedTransport.openSession(currentId).then((detail) => {
      if (alive) dispatch({ type: "session_opened", detail });
    });
    // 每次对话开始刷新模型可用性（服务端 60s 缓存，切换会话的重复拉取几乎零成本）
    void resolvedTransport
      .listModelStatus()
      .then((result) => {
        if (alive) dispatch({
          type: "model_status_loaded",
          status: result.models,
          ...(result.accountQuota !== undefined ? { accountQuota: result.accountQuota } : {}),
        });
      })
      .catch(() => {});
    void resolvedTransport.listTools(currentId).then((toolState) => {
      if (alive) dispatch({ type: "tools_loaded", id: currentId, ...toolState });
    });
    // 每次 run 结束重新检查模型可用性与额度：run 中途配额耗尽的模型，下一轮从列表里消失
    const refreshModelStatus = () => {
      void resolvedTransport
        .listModelStatus()
        .then((result) => {
          if (!alive) return;
          dispatch({
            type: "model_status_loaded",
            status: result.models,
            ...(result.accountQuota !== undefined ? { accountQuota: result.accountQuota } : {}),
          });
        })
        .catch(() => {});
    };
    const unsubscribe = resolvedTransport.subscribe(currentId, (event) => {
      // MCP 热载入等引起的工具集变化：重拉本会话的工具开关面板数据
      if (event.type === "tools_changed") {
        void resolvedTransport.listTools(currentId).then((toolState) => {
          if (alive) dispatch({ type: "tools_loaded", id: currentId, ...toolState });
        }).catch(() => {});
        return;
      }
      if (event.type === "run_end") refreshModelStatus();
      dispatch({ type: "event", id: currentId, event });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [currentId, resolvedTransport]);

  const actions = useMemo<Store["actions"]>(() => {
    // 发送主体按会话 id 操作：send 走当前会话，createAndSend 在刚建的新会话上复用同一段逻辑
    const sendMessageTo = async (id: string, text: string, images: LocalImageAttachment[] = []) => {
      // 空闲时保留即时本地回显（含缩略图）；忙时不加气泡——消息进队列，等 run_start.queueId 转正
      const busy = (stateRef.current.byId[id]?.status ?? "idle") !== "idle";
      if (!busy) {
        dispatch({ type: "user_sent", id, text, ...(images.length > 0 ? { images } : {}) });
      }
      try {
        const result = await resolvedTransport.sendMessage(
          id,
          text,
          images.length > 0 ? toUploadBodies(images) : undefined
        );
        if (result.handled) {
          // 斜杠命令通道：会话文件被改写（/rewind）时先重拉历史，再补命令卡
          // （user_sent 的乐观气泡由 command_result 收回换成命令卡；/task 不走这里）
          if (result.refresh === "history") {
            try {
              const detail = await resolvedTransport.openSession(id);
              dispatch({ type: "history_reloaded", id, detail });
            } catch {
              // 重拉失败保留现状，命令输出照常显示
            }
          }
          dispatch({ type: "command_result", id, text, lines: result.lines ?? [] });
          return;
        }
        if (result.queued) {
          dispatch({
            type: "queue_item_synced",
            id,
            item: {
              id: result.queueId,
              text,
              ...(images.length > 0 ? { imageCount: images.length } : {}),
            },
          });
        }
      } catch (error) {
        dispatch({
          type: "run_failed_local",
          id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    return {
      selectSession(id: string) {
        dispatch({ type: "select", id });
      },
      goWelcome() {
        dispatch({ type: "select", id: null });
      },
      async newSession() {
        const summary = await resolvedTransport.createSession();
        dispatch({ type: "session_created", summary });
        dispatch({ type: "select", id: summary.sessionId });
      },
      async createAndSend(text: string, config?: SessionConfigInput, images?: LocalImageAttachment[]) {
        const summary = await resolvedTransport.createSession();
        dispatch({ type: "session_created", summary });
        dispatch({ type: "select", id: summary.sessionId });
        // 欢迎界面选的模型/参数还没有会话可落：建会话后立刻应用，失败不阻断首条消息
        if (config && Object.keys(config).length > 0) {
          try {
            const applied = await resolvedTransport.applySessionConfig(summary.sessionId, config);
            dispatch({ type: "event", id: summary.sessionId, event: applied });
          } catch {
            // 模型名失效等情况：会话沿用服务器默认配置继续
          }
        }
        await sendMessageTo(summary.sessionId, text, images);
      },
      async send(text: string, images?: LocalImageAttachment[]) {
        const id = stateRef.current.currentId;
        if (!id) return;
        await sendMessageTo(id, text, images);
      },
      async removeQueued(queueId: string) {
        const id = stateRef.current.currentId;
        if (!id) return;
        dispatch({ type: "queue_item_removed", id, queueId }); // 乐观移除，服务端 queue_changed 会纠正
        try {
          await resolvedTransport.removeQueuedMessage(id, queueId);
        } catch {
          // 撤单迟到（已开跑/已结束）：忽略，以服务端事件为准
        }
      },
      async cancel() {
        const id = stateRef.current.currentId;
        if (!id) return;
        dispatch({ type: "cancel_requested", id });
        await resolvedTransport.cancel(id);
      },
      async resolveApproval(decision: ApprovalDecisionBody) {
        const id = stateRef.current.currentId;
        const pending = id ? stateRef.current.byId[id]?.pendingApproval : undefined;
        if (!id || !pending) return;
        dispatch({ type: "approval_resolved", id });
        await resolvedTransport.respondApproval(id, pending.id, decision);
      },
      async resolveInput(text: string) {
        const id = stateRef.current.currentId;
        const pending = id ? stateRef.current.byId[id]?.pendingInput : undefined;
        if (!id || !pending) return;
        dispatch({ type: "input_resolved", id });
        await resolvedTransport.respondInput(id, pending.id, text);
      },
      async applySessionConfig(config: SessionConfigInput) {
        const id = stateRef.current.currentId;
        if (!id) return;
        const applied = await resolvedTransport.applySessionConfig(id, config);
        // HTTP 应答也是权威配置；无需等待 SSE 建连或再次选择。
        dispatch({ type: "event", id, event: applied });
      },
      async setSandboxRoot(dir: string) {
        await resolvedTransport.setSandboxRoot(dir);
        const settings = await resolvedTransport.getSettings();
        dispatch({ type: "sandbox_root_changed", sandboxRoot: settings.sandboxRoot });
      },
      async toggleTool(name: string, enabled: boolean) {
        const id = stateRef.current.currentId;
        if (!id) return;
        const session = stateRef.current.byId[id];
        if (!session?.tools) return;
        // 乐观更新；失败时回源重取（覆盖本地状态）
        const disabled = new Set(session.disabledTools ?? []);
        if (enabled) disabled.delete(name);
        else disabled.add(name);
        const nextDisabled = [...disabled];
        dispatch({ type: "tools_loaded", id, tools: session.tools, disabled: nextDisabled });
        try {
          await resolvedTransport.setToolState(id, nextDisabled);
        } catch {
          const toolState = await resolvedTransport.listTools(id);
          dispatch({ type: "tools_loaded", id, ...toolState });
        }
      },
      async refreshJobs() {
        const jobs = await resolvedTransport.listJobs();
        dispatch({ type: "jobs_loaded", jobs });
      },
      async killJob(id: string) {
        await resolvedTransport.killJob(id);
        const jobs = await resolvedTransport.listJobs();
        dispatch({ type: "jobs_loaded", jobs });
      },
      async readJobLog(jobId, stream, after) {
        return resolvedTransport.readJobLog(jobId, stream, after);
      },
    };
  }, [resolvedTransport]);

  const current = state.currentId ? (state.byId[state.currentId] ?? null) : null;
  const value = useMemo<Store>(() => ({ state, current, actions }), [state, current, actions]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore 必须在 StoreProvider 内使用");
  return store;
}
