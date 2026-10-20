// src/server/sessions.ts
import { Agent } from "../core/agent";
import { SessionStore } from "../core/session_store";
import { newSession } from "../core/session_picker";
import { TraceRecorder } from "../core/trace";
import { buildSystemPrompt } from "../prompts/system";
import { ToolRegistry, ToolCallMiddleware } from "../core/registry";
import { PlanStore } from "../core/plan_store";
import { createToolTelemetry } from "../tools/telemetry";
import { copyMcpTools, registerSessionTools } from "../bootstrap";
import { contextWindowFor } from "../utils/model_registry";
import type { AgentResult, ToolDefinition, ToolRuntime } from "../core/types";
import type { UiBridge } from "./bridge";
import { runSessionStore } from "./run_context";
import type { ServerRuntime } from "./runtime";
import type { ServerEvent, SessionDetailDTO, SessionSummaryDTO, StatusDTO } from "./protocol";

/**
 * 会话级事件扇出：publish 做成箭头字段，运行时组装可以早于本类实例化就持有它
 * （UiBridge 与工具事件中间件都在组装期拿到这个引用）。
 */
export class EventHub {
  private listeners = new Map<string, Set<(event: ServerEvent) => void>>();

  publish = (sessionId: string, event: ServerEvent): void => {
    const set = this.listeners.get(sessionId);
    if (event.type !== "token" && event.type !== "step") {
      console.log(`[Hub] publish ${event.type} -> ${sessionId}（${set?.size ?? 0} 个订阅者）`);
    }
    for (const listener of [...(set ?? [])]) listener(event);
  };

  subscribe(sessionId: string, listener: (event: ServerEvent) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    console.log(`[Hub] subscribe ${sessionId}（现 ${set.size} 个）`);
    return () => {
      set.delete(listener);
      console.log(`[Hub] unsubscribe ${sessionId}（余 ${set.size} 个）`);
    };
  }
}

interface SessionEntry {
  store: SessionStore;
  /** 懒创建：第一次 sendMessage 才组装（MCP/上下文已在启动期就绪） */
  agent?: Agent | undefined;
  /** 会话的独立注册表（与 agent 同生命周期；切换沙箱/工具开关时按需重建） */
  registry?: ToolRegistry | undefined;
  /** 注册表全量定义快照：工具开关的关→开恢复数据源 */
  toolDefs?: Map<string, ToolDefinition> | undefined;
  /** 本会话被关闭的工具（下一轮请求即从工具列表移除；仅内存态） */
  disabledTools?: Set<string> | undefined;
  /** 会话还没有任何对话时为 true：第一个成功的回合结束后起一次名 */
  needsName: boolean;
  controller?: AbortController | undefined;
}

export interface SessionManagerOptions {
  hub: EventHub;
  bridge: UiBridge;
  runtime: ServerRuntime;
  sessionDir: string;
  traceDir: string;
}

/**
 * 会话管理：一个会话一个 Agent（历史各自落盘在 .agent-sessions/<id>.jsonl），
 * 且各持一份独立的工具注册表与 PlanStore——多会话可以并行跑回合，互不踩状态。
 * 全进程共享的只有：MCP 连接（adapter 挂在共享注册表上，会话创建时按定义拷贝）
 * 与配置/技能/沙箱解析结果。已知取舍见 copyMcpTools 的注释（热更新不传播到已建会话）。
 */
export class SessionManager {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(private readonly options: SessionManagerOptions) {}

  /** 该会话是否正有回合在跑（每会话独立，跨会话并行不受限） */
  isBusy(sessionId: string): boolean {
    return this.entries.get(sessionId)?.controller !== undefined;
  }

  /** 是否任意会话都在跑（切换沙箱目录前检查） */
  anyBusy(): boolean {
    return [...this.entries.values()].some((entry) => entry.controller !== undefined);
  }

  /**
   * 丢弃全部会话 Agent（切换沙箱根后调用）：下个回合用新根重建注册表与提示词。
   * 对话历史都在磁盘上，重建无损失；调用前须确认 anyBusy() 为 false。
   */
  resetAgents(): void {
    for (const entry of this.entries.values()) {
      entry.agent = undefined;
      entry.registry = undefined;
      entry.toolDefs = undefined;
    }
  }

  /** 工具清单 + 本会话的开关状态（供 UI 渲染开关面板） */
  async listTools(sessionId: string): Promise<{
    tools: Array<{ name: string; description: string }>;
    disabled: string[];
  }> {
    const entry = this.entry(sessionId);
    const source =
      entry.toolDefs ??
      new Map(this.options.runtime.registry.list().map((def) => [def.name, def]));
    const tools = [...source.values()].map((def) => ({
      name: def.name,
      description: def.description.length > 140 ? `${def.description.slice(0, 140)}…` : def.description,
    }));
    return { tools, disabled: [...(entry.disabledTools ?? [])] };
  }

  /**
   * 设置本会话关闭的工具集合。立即生效：Agent 每轮迭代都从注册表现取工具列表，
   * 反注册的工具下一轮模型就看不到了；重新打开从定义快照恢复。
   * Agent 尚未创建时只记集合，ensureAgent 组装注册表后应用。
   */
  async setDisabledTools(sessionId: string, disabled: string[]): Promise<void> {
    const entry = this.entry(sessionId);
    const source =
      entry.toolDefs ??
      new Map(this.options.runtime.registry.list().map((def) => [def.name, def]));
    const unknown = disabled.filter((name) => !source.has(name));
    if (unknown.length > 0) throw new Error(`未知工具: ${unknown.join(", ")}`);

    entry.disabledTools = new Set(disabled);
    const registry = entry.registry;
    if (registry === undefined || entry.toolDefs === undefined) return;
    for (const [name, definition] of entry.toolDefs) {
      if (disabled.includes(name)) {
        registry.unregister(name);
      } else if (!registry.has(name)) {
        registry.register(definition, { replace: true });
      }
    }
  }

  /**
   * 应用会话级配置（模型/温度/迭代上限）。模型切换与 REPL /model 同语义：
   * agent.setModel + 落盘 recordModel，续聊自动恢复；温度与迭代上限仅内存态。
   * 成功后广播 session_config（含当前生效的全量值与该模型的上下文窗口）。
   */
  async applySessionConfig(
    sessionId: string,
    patch: { model?: string; temperature?: number; maxIterations?: number }
  ): Promise<void> {
    const entry = this.entry(sessionId);
    if (entry.controller !== undefined) throw new Error("当前会话已有任务在运行");
    const agent = await this.ensureAgent(entry, sessionId);

    if (patch.model !== undefined && patch.model.trim() !== "" && patch.model.trim() !== agent.model) {
      agent.setModel(patch.model.trim());
      await entry.store.recordModel(agent.model);
    }
    if (patch.temperature !== undefined) agent.setTemperature(patch.temperature);
    if (patch.maxIterations !== undefined) agent.setMaxIterations(patch.maxIterations);

    this.options.hub.publish(sessionId, {
      type: "session_config",
      model: agent.model,
      contextWindow: contextWindowFor(agent.model),
      temperature: agent.temperature,
      maxIterations: agent.maxIterations,
    });
  }

  async list(): Promise<SessionSummaryDTO[]> {
    const summaries = await SessionStore.list(this.options.sessionDir);
    return summaries.map((summary) => ({
      sessionId: summary.sessionId,
      ...(summary.name !== undefined ? { name: summary.name } : {}),
      messageCount: summary.messageCount,
      lastUpdated: summary.lastUpdated.toISOString(),
      firstUserText: summary.firstUserText,
    }));
  }

  async create(): Promise<SessionSummaryDTO> {
    const picked = newSession(this.options.sessionDir, { log: () => {} });
    this.entry(picked.sessionId);
    return {
      sessionId: picked.sessionId,
      messageCount: 0,
      lastUpdated: new Date().toISOString(),
      firstUserText: "",
    };
  }

  async history(sessionId: string): Promise<SessionDetailDTO> {
    const entry = this.entry(sessionId);
    const loaded = await entry.store.load();
    const messages: SessionDetailDTO["messages"] = [];
    for (const message of loaded.messages) {
      if ((message.role === "user" || message.role === "assistant") && typeof message.content === "string") {
        messages.push({ role: message.role, content: message.content });
      }
    }
    return { summary: await this.summaryFor(sessionId, messages.length), messages };
  }

  async status(): Promise<StatusDTO> {
    const { config, skills, sandbox, mcp } = this.options.runtime;
    const activeModel = [...this.entries.values()].find((entry) => entry.agent !== undefined)?.agent?.model;
    return {
      model: activeModel ?? config.model,
      summaryModel: config.summaryModel,
      sandbox:
        sandbox.backend === "docker"
          ? `docker 容器（${sandbox.image} · 网络${sandbox.network === "none" ? "断开" : "bridge"}）`
          : `宿主机进程（${sandbox.reason}）`,
      skills: skills.map((skill) => skill.name),
      mcpServers: mcp.getStatus().map((server) => ({
        id: server.id,
        ok: server.connected,
        tools: server.tools.length,
      })),
    };
  }

  /** SSE 订阅：建立后立即发 hello（运行环境）与该会话的未决审批/输入请求 */
  subscribe(sessionId: string, listener: (event: ServerEvent) => void): () => void {
    this.entry(sessionId);
    const unsubscribe = this.options.hub.subscribe(sessionId, listener);
    void this.helloFor(sessionId).then((hello) => {
      this.options.hub.publish(sessionId, hello);
      for (const event of this.options.bridge.pendingEventsFor(sessionId)) {
        this.options.hub.publish(sessionId, event);
      }
    });
    return unsubscribe;
  }

  /** 跑一个回合；该会话忙时抛错（HTTP 层映射 409）。事件全程经 hub 推给订阅者。 */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const entry = this.entry(sessionId);
    if (entry.controller !== undefined) throw new Error("当前会话已有任务在运行");
    const controller = new AbortController();
    entry.controller = controller;
    try {
      await this.runTurn(entry, sessionId, text, controller.signal);
    } finally {
      this.options.bridge.disposeSession(sessionId);
      entry.controller = undefined;
    }
  }

  cancel(sessionId: string): void {
    this.entries.get(sessionId)?.controller?.abort();
    this.options.bridge.disposeSession(sessionId);
  }

  /** 服务器关停：中止在飞回合、收口未决审批、回收 MCP 子进程与长连接 */
  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) entry.controller?.abort();
    for (const sessionId of this.entries.keys()) this.options.bridge.disposeSession(sessionId);
    await this.options.runtime.mcp.closeAll();
  }

  // ---------- 内部 ----------

  private entry(sessionId: string): SessionEntry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { store: new SessionStore({ dir: this.options.sessionDir, sessionId }), needsName: false };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private async helloFor(sessionId: string): Promise<ServerEvent> {
    const status = await this.status();
    const agent = this.entries.get(sessionId)?.agent;
    const model = agent?.model ?? status.model;
    return {
      type: "hello",
      model,
      summaryModel: status.summaryModel,
      sandbox: status.sandbox,
      sandboxRoot: this.options.runtime.sandboxRoot,
      contextWindow: contextWindowFor(model),
      ...(agent !== undefined
        ? { temperature: agent.temperature, maxIterations: agent.maxIterations }
        : {}),
      ...(agent !== undefined ? { promptHash: agent.systemPromptHash } : {}),
      skills: status.skills,
      mcpServers: status.mcpServers,
    };
  }

  private async summaryFor(sessionId: string, fallbackCount: number): Promise<SessionSummaryDTO> {
    const summaries = await SessionStore.list(this.options.sessionDir);
    const found = summaries.find((summary) => summary.sessionId === sessionId);
    if (found !== undefined) {
      return {
        sessionId: found.sessionId,
        ...(found.name !== undefined ? { name: found.name } : {}),
        messageCount: found.messageCount,
        lastUpdated: found.lastUpdated.toISOString(),
        firstUserText: found.firstUserText,
      };
    }
    return { sessionId, messageCount: fallbackCount, lastUpdated: new Date().toISOString(), firstUserText: "" };
  }

  private async ensureAgent(entry: SessionEntry, sessionId: string): Promise<Agent> {
    if (entry.agent !== undefined) return entry.agent;
    const { config, registry: sharedRegistry, skills, sandbox, sandboxRoot } = this.options.runtime;
    const startup = await entry.store.load();
    entry.needsName = startup.messages.length === 0;

    // 每会话独立注册表：计划仓私有（并行 run 互不踩）；无状态内置工具按同一清单重新组装；
    // MCP 工具定义从共享注册表拷贝（定义绑定的是连接不是注册表，拷贝安全）
    const registry = new ToolRegistry();
    registry.use(createToolTelemetry());
    registry.use(createToolEventBridge(this.options.hub, sessionId));
    registry.use(createMcpUseTracker(this.options.bridge, sessionId));
    const planStore = new PlanStore();
    registerSessionTools(registry, { skills, planStore, sandbox, sandboxRoot });
    copyMcpTools(sharedRegistry, registry);

    // 工具开关：快照全量定义（关→开的恢复数据源），再应用本会话的关闭集合
    entry.registry = registry;
    entry.toolDefs = new Map(registry.list().map((def) => [def.name, def]));
    for (const name of entry.disabledTools ?? []) registry.unregister(name);

    const agent = new Agent({
      model: startup.model ?? config.model,
      // 沙箱根会话级可见（提示词里告诉模型工作区在哪）；切换沙箱后 Agent 整体重建
      systemPrompt: buildSystemPrompt(sandboxRoot, skills),
      maxIterations: config.maxIterations,
      temperature: config.temperature,
      maxHistoryTurns: config.maxHistoryTurns,
      budget: config.budget,
      sessionStore: entry.store,
      summaryModel: config.summaryModel,
      ...(this.options.runtime.untrustedContext !== undefined
        ? { untrustedContext: this.options.runtime.untrustedContext }
        : {}),
      tools: registry,
      planStore,
      stream: config.stream,
    });
    this.attachEventRelay(agent, sessionId);
    // 与 CLI 同等可观测性：每个会话独立一份运行轨迹
    new TraceRecorder(this.options.traceDir, sessionId).attach(agent.events);
    entry.agent = agent;
    return agent;
  }

  /** Agent 事件总线 → 协议事件转发（run_end 由 runTurn 从结果发布，带 finalAnswer） */
  private attachEventRelay(agent: Agent, sessionId: string): void {
    const hub = this.options.hub;
    agent.events.on("token", ({ delta }) => {
      hub.publish(sessionId, { type: "token", delta });
    });
    agent.events.on("step", ({ step }) => {
      hub.publish(sessionId, {
        type: "step",
        iteration: step.iteration,
        ...(step.llmContent !== null ? { llmContent: step.llmContent } : {}),
        toolCalls: step.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          resultPreview: call.resultPreview,
        })),
        tokens: {
          promptTokens: step.tokens.promptTokens,
          completionTokens: step.tokens.completionTokens,
          totalTokens: step.tokens.totalTokens,
        },
      });
    });
    agent.events.on("plan_update", ({ steps }) => {
      hub.publish(sessionId, { type: "plan_update", steps });
    });
    agent.events.on("compact", (info) => {
      hub.publish(sessionId, {
        type: "compact",
        action: info.action,
        ...(info.messages !== undefined ? { messages: info.messages } : {}),
        ...(info.tokens !== undefined ? { tokens: info.tokens } : {}),
        ...(info.detail !== undefined ? { detail: info.detail } : {}),
      });
    });
    agent.events.on("retry", (info) => {
      hub.publish(sessionId, { type: "retry", attempt: info.attempt, delayMs: info.delayMs, reason: info.reason });
    });
  }

  private async runTurn(entry: SessionEntry, sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const agent = await this.ensureAgent(entry, sessionId);
    this.options.hub.publish(sessionId, {
      type: "run_start",
      userMessage: text,
      promptHash: agent.systemPromptHash,
    });
    const runtime: ToolRuntime = { signal, requestHuman: this.options.bridge.requestHuman };

    let result: AgentResult;
    try {
      // ALS 作用域：run 内的一切（工具执行、run_script 确认）都能归属到这个会话
      result = await runSessionStore.run({ sessionId }, () => agent.run(text, runtime));
    } catch (error) {
      this.options.hub.publish(sessionId, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.options.hub.publish(sessionId, {
      type: "run_end",
      success: result.success,
      ...(result.finalAnswer !== null ? { finalAnswer: result.finalAnswer } : {}),
      totalTokens: result.totalTokens,
      toolCallsCount: result.toolCallsCount,
      iterations: result.steps.length,
      ...(result.budgetStopped !== undefined ? { budgetStopped: result.budgetStopped } : {}),
      // Grounded 引用：引用表随 run_end 透出，前端把最终回答里的 [n] 渲染成来源卡片
      ...(result.citations.length > 0 ? { citations: result.citations } : {}),
    });

    // 会话命名：与 REPL 的 createSessionNamer 同语义——只对第一个成功的回合尝试一次
    if (entry.needsName && result.success && result.finalAnswer !== null && !signal.aborted) {
      entry.needsName = false;
      const name = await agent.summarizeSessionName(text, result.finalAnswer, { signal });
      if (name !== undefined) {
        const saved = await entry.store.recordSessionName(name);
        if (saved !== undefined) this.options.hub.publish(sessionId, { type: "session_name", name: saved });
      }
    }
  }
}

/** 工具执行开始/结束广播到本会话（注册表按会话私有，事件归属天然正确） */
let toolEventSeq = 0;
function createToolEventBridge(hub: EventHub, sessionId: string): ToolCallMiddleware {
  return async (context, next) => {
    const callId = `tool-${Date.now().toString(36)}-${++toolEventSeq}`;
    hub.publish(sessionId, {
      type: "tool_call_start",
      callId,
      name: context.name,
      arguments: JSON.stringify(context.args ?? {}),
    });
    try {
      const result = await next();
      hub.publish(sessionId, { type: "tool_call_end", callId, result: clipForUi(result) });
      return result;
    } catch (error) {
      hub.publish(sessionId, {
        type: "tool_call_end",
        callId,
        isError: true,
        result: clipForUi(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  };
}

function clipForUi(text: string, maxChars = 2000): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * MCP 工具在飞标记：执行期间把「serverId → 本会话」记进桥接层，
 * 供 elicitation（ALS 丢失的传输层回调）归因。非 MCP 工具直接放行。
 */
function createMcpUseTracker(bridge: UiBridge, sessionId: string): ToolCallMiddleware {
  return async (context, next) => {
    const dot = context.name.indexOf("__");
    if (dot === -1) return next();
    const serverId = context.name.slice(0, dot);
    bridge.noteServerUse(serverId, sessionId);
    try {
      return await next();
    } finally {
      bridge.releaseServerUse(serverId, sessionId);
    }
  };
}
