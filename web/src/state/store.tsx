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
  PlanStep,
  ServerEvent,
  SessionDetailDTO,
  SessionSummaryDTO,
} from "@protocol";
import type { SessionConfigInput, Transport } from "../lib/transport";
import { MockTransport } from "../lib/mock";

// ---------- 会话内的可渲染项 ----------

export type ChatItem =
  | { kind: "user"; id: string; text: string }
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
    }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string };

export type RunStatus = "idle" | "running" | "awaiting_approval" | "awaiting_input";

export interface SessionUIState {
  summary?: SessionSummaryDTO;
  items: ChatItem[];
  plan: PlanStep[];
  status: RunStatus;
  /** 会话当前生效的模型（hello / session_config 更新） */
  model?: string;
  temperature?: number;
  maxIterations?: number;
  /** 该模型上下文窗口（token）；配合 lastPromptTokens 画上下文占用 */
  contextWindow?: number;
  /** 最近一次 step 的 promptTokens ≈ 发送时的上下文长度 */
  lastPromptTokens?: number;
  /** 本次页面会话里累计消耗（每次 run_end 累加） */
  accumulatedTokens?: number;
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
  stats?: { success: boolean; totalTokens: number; toolCallsCount: number; iterations: number };
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
  /** 服务器级设置（目前只有沙箱根目录） */
  appSettings: { sandboxRoot?: string };
}

// ---------- Action 与 reducer ----------

type Action =
  | { type: "sessions_loaded"; sessions: SessionSummaryDTO[] }
  | { type: "models_loaded"; models: string[] }
  | { type: "settings_loaded"; sandboxRoot?: string }
  | { type: "sandbox_root_changed"; sandboxRoot: string }
  | { type: "tools_loaded"; id: string; tools: Array<{ name: string; description: string }>; disabled: string[] }
  | { type: "session_created"; summary: SessionSummaryDTO }
  | { type: "session_opened"; detail: SessionDetailDTO }
  | { type: "select"; id: string }
  | { type: "user_sent"; id: string; text: string }
  | { type: "event"; id: string; event: ServerEvent }
  | { type: "approval_resolved"; id: string }
  | { type: "input_resolved"; id: string }
  | { type: "run_failed_local"; id: string; message: string }
  | { type: "cancel_requested"; id: string };

const uid = () => Math.random().toString(36).slice(2, 10);

function notice(text: string, tone: "info" | "warn" | "error" = "info"): ChatItem {
  return { kind: "notice", id: uid(), tone, text };
}

function emptySession(): SessionUIState {
  return { items: [], plan: [], status: "idle" };
}

function historyToItems(detail: SessionDetailDTO): ChatItem[] {
  return detail.messages.map((message) =>
    message.role === "user"
      ? { kind: "user", id: uid(), text: message.content }
      : { kind: "assistant", id: uid(), text: message.content, streaming: false }
  );
}

/** 单个 ServerEvent → 会话状态的纯函数迁移（UI 渲染的全部逻辑都在这） */
function applyEvent(s: SessionUIState, e: ServerEvent): SessionUIState {
  switch (e.type) {
    case "hello":
      return {
        ...s,
        meta: e,
        model: e.model,
        contextWindow: e.contextWindow ?? s.contextWindow,
        temperature: e.temperature ?? s.temperature,
        maxIterations: e.maxIterations ?? s.maxIterations,
      };
    case "session_config":
      return {
        ...s,
        model: e.model,
        contextWindow: e.contextWindow ?? s.contextWindow,
        temperature: e.temperature ?? s.temperature,
        maxIterations: e.maxIterations ?? s.maxIterations,
      };
    case "run_start":
      return { ...s, status: "running", stats: undefined, cancelledByUser: false };
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
    case "step": {
      // 非流式后端的兜底：把整段 LLM 输出补成一条 assistant 消息
      const last = s.items[s.items.length - 1];
      if (e.llmContent && !(last?.kind === "assistant" && last.streaming)) {
        return {
          ...s,
          items: [...s.items, { kind: "assistant", id: uid(), text: e.llmContent, streaming: false }],
          lastPromptTokens: e.tokens?.promptTokens ?? s.lastPromptTokens,
        };
      }
      return { ...s, lastPromptTokens: e.tokens?.promptTokens ?? s.lastPromptTokens };
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
      const items = s.items.map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it
      );
      if (e.finalAnswer && e.finalAnswer.trim() && !items.some((it) => it.kind === "assistant" && it.text.trim())) {
        items.push({
          kind: "assistant",
          id: uid(),
          text: e.finalAnswer,
          streaming: false,
          ...(e.citations && e.citations.length > 0 ? { citations: e.citations } : {}),
        });
      }
      if (!e.success) {
        items.push(
          notice(
            s.cancelledByUser ? "⏹️ 已中断本次运行" : `⚠️ 本回合未完成${e.budgetStopped ? `（${e.budgetStopped}）` : ""}`,
            "warn"
          )
        );
      }
      return {
        ...s,
        items,
        status: "idle",
        pendingApproval: undefined,
        pendingInput: undefined,
        accumulatedTokens: (s.accumulatedTokens ?? 0) + e.totalTokens,
        stats: {
          success: e.success,
          totalTokens: e.totalTokens,
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
          : { ...existing, summary: action.detail.summary, items: historyToItems(action.detail) };
      return { ...state, byId: { ...state.byId, [action.detail.summary.sessionId]: merged } };
    }
    case "select":
      return { ...state, currentId: action.id, byId: { ...state.byId, [action.id]: state.byId[action.id] ?? emptySession() } };
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
            items: [...s.items, { kind: "user", id: uid(), text: action.text }],
          },
        },
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
  }
}

// ---------- Provider 与 actions ----------

export interface Store {
  state: AppState;
  current: SessionUIState | null;
  actions: {
    selectSession(id: string): void;
    newSession(): Promise<void>;
    send(text: string): Promise<void>;
    cancel(): Promise<void>;
    resolveApproval(decision: ApprovalDecisionBody): Promise<void>;
    resolveInput(text: string): Promise<void>;
    applySessionConfig(config: SessionConfigInput): Promise<void>;
    setSandboxRoot(dir: string): Promise<void>;
    toggleTool(name: string, enabled: boolean): Promise<void>;
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
    appSettings: {},
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  // 首次加载：拉会话列表并自动打开最近的一个；顺带拉模型清单与服务器设置
  useEffect(() => {
    let alive = true;
    void resolvedTransport.listSessions().then((sessions) => {
      if (!alive) return;
      dispatch({ type: "sessions_loaded", sessions });
      if (sessions[0]) dispatch({ type: "select", id: sessions[0].sessionId });
    });
    void resolvedTransport.listModels().then((models) => {
      if (!alive) return;
      dispatch({ type: "models_loaded", models });
    });
    void resolvedTransport.getSettings().then((settings) => {
      if (!alive) return;
      dispatch({ type: "settings_loaded", sandboxRoot: settings.sandboxRoot });
    });
    return () => {
      alive = false;
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
    void resolvedTransport.listTools(currentId).then((toolState) => {
      if (alive) dispatch({ type: "tools_loaded", id: currentId, ...toolState });
    });
    const unsubscribe = resolvedTransport.subscribe(currentId, (event) =>
      dispatch({ type: "event", id: currentId, event })
    );
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [currentId, resolvedTransport]);

  const actions = useMemo<Store["actions"]>(
    () => ({
      selectSession(id: string) {
        dispatch({ type: "select", id });
      },
      async newSession() {
        const summary = await resolvedTransport.createSession();
        dispatch({ type: "session_created", summary });
        dispatch({ type: "select", id: summary.sessionId });
      },
      async send(text: string) {
        const id = stateRef.current.currentId;
        if (!id) return;
        dispatch({ type: "user_sent", id, text });
        try {
          await resolvedTransport.sendMessage(id, text);
        } catch (error) {
          dispatch({
            type: "run_failed_local",
            id,
            message: error instanceof Error ? error.message : String(error),
          });
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
        await resolvedTransport.applySessionConfig(id, config);
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
    }),
    [resolvedTransport]
  );

  const current = state.currentId ? (state.byId[state.currentId] ?? null) : null;
  const value = useMemo<Store>(() => ({ state, current, actions }), [state, current, actions]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore 必须在 StoreProvider 内使用");
  return store;
}
