// src/server/sessions.ts
import { Agent } from "../core/agent";
import { SessionStore } from "../core/session_store";
import { newSession } from "../core/session_picker";
import { TraceRecorder } from "../core/trace";
import { buildSystemPrompt } from "../prompts/system";
import { snapshotEnv } from "../prompts/env_block";
import { ToolRegistry, ToolCallMiddleware, isErrorObservation } from "../core/registry";
import { PlanStore } from "../core/plan_store";
import { createToolTelemetry } from "../tools/telemetry";
import { copyMcpTools, registerSessionTools } from "../bootstrap";
import { contextWindowFor } from "../utils/model_registry";
import type { AgentResult, ToolDefinition, ToolRuntime } from "../core/types";
import type { UiBridge } from "./bridge";
import { runSessionStore } from "./run_context";
import type { ServerRuntime } from "./runtime";
import type { ServerEvent, SessionConfigEvent, SessionDetailDTO, SessionSummaryDTO, StatusDTO, Citation, ThinkingEffort, MessageSendResponse } from "./protocol";
import { RunOutcomeSchema } from "./protocol";
import { TaskStore } from "../core/task_store";
import { formatBudgetExtensionPrompt } from "../core/budget_prompt";
import { handleSlashCommand, isCommandText, type RunStatsSummary } from "../core/command_router";
import { CheckpointStore, createCheckpointSnapshotHook } from "../core/checkpoint_store";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * 落盘行 citations 的形状校验：JSONL 是无人看守的磁盘格式，手工编辑 / 旧版本 / 写坏的字段
 * 都可能混进来。坏引用直接丢弃（filter），不让畸形数据进 DTO 破坏前端渲染。
 */
function isPersistedCitation(value: unknown): value is Citation {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.index === "number" &&
    Number.isFinite(c.index) &&
    typeof c.title === "string" &&
    c.title.trim() !== "" &&
    typeof c.tool === "string" &&
    (c.url === undefined || typeof c.url === "string") &&
    (c.snippet === undefined || typeof c.snippet === "string")
  );
}

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

/** 排队中的待发消息：当前回合结束后按 FIFO 接续执行 */
interface QueuedMessage {
  id: string;
  text: string;
  /** 入队时会话正忙（这条消息等待过）：run_start 才带 queueId，前端据此把芯片转成气泡 */
  waited: boolean;
}

/** 单会话排队上限：防失控堆积；满了拒绝并提示 */
const MAX_QUEUE_LENGTH = 8;

interface SessionEntry {
  initializing?: Promise<Agent> | undefined;
  configuring?: boolean;
  configRevision: number;
  store: SessionStore;
  /** 懒创建：首次订阅、设置或发送时组装（MCP/上下文已在启动期就绪） */
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
  /** 忙时到达的消息排队处（FIFO）；当前回合 finally 里自动接续下一条 */
  queue: QueuedMessage[];
  /** 回合级检查点（/rewind 用）；随 agent 一起创建，AGENT_CHECKPOINTS=0 时为 undefined */
  checkpoints?: CheckpointStore | undefined;
  /** 上一回合用量摘要（/tokens 用）；runTurn 发布 run_end 后更新 */
  lastRunStats?: RunStatsSummary | undefined;
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
  private configRevision = Date.now();

  private nextConfigRevision(): number {
    return this.configRevision = Math.max(Date.now(), this.configRevision + 1);
  }

  constructor(private readonly options: SessionManagerOptions) {}

  /** 该会话是否正有回合在跑（每会话独立，跨会话并行不受限）；排队中的消息也算"有事要做" */
  isBusy(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return entry !== undefined && (entry.controller !== undefined || entry.queue.length > 0);
  }

  /** 是否任意会话都在跑（切换沙箱目录前检查） */
  anyBusy(): boolean {
    return [...this.entries.values()].some((entry) =>
      entry.controller !== undefined || entry.queue.length > 0 || entry.configuring || entry.initializing !== undefined);
  }

  /**
   * 丢弃全部会话 Agent（切换沙箱根后调用）：下个回合用新根重建注册表与提示词。
   * 对话历史都在磁盘上，重建无损失；调用前须确认 anyBusy() 为 false（队列空才允许切换）。
   */
  resetAgents(): void {
    for (const entry of this.entries.values()) {
      entry.agent = undefined;
      entry.registry = undefined;
      entry.toolDefs = undefined;
      entry.queue = [];
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
   * 应用会话级配置（模型/摘要模型/温度/迭代上限/思考程度）。模型与摘要模型切换会落盘
   * （recordModel / recordSummaryModel），续聊自动恢复；温度、迭代上限与思考程度仅内存态。
   * 成功后广播 session_config（含当前生效的全量值与该模型的上下文窗口）。
   */
  async applySessionConfig(
    sessionId: string,
    patch: { model?: string; summaryModel?: string; temperature?: number; maxIterations?: number; thinkingEffort?: ThinkingEffort }
  ): Promise<SessionConfigEvent> {
    const entry = this.entry(sessionId);
    if (entry.controller !== undefined || entry.queue.length > 0 || entry.configuring) throw new Error("当前会话还有任务在运行或排队");
    entry.configuring = true;
    try {
      const agent = await this.ensureAgent(entry, sessionId);

      if (patch.model !== undefined && patch.model.trim() !== "" && patch.model.trim() !== agent.model) {
        await entry.store.recordModel(patch.model.trim());
        agent.setModel(patch.model.trim());
      }
      if (patch.summaryModel !== undefined && patch.summaryModel.trim() !== "" &&
          patch.summaryModel.trim() !== agent.summaryModel) {
        const next = patch.summaryModel.trim();
        await entry.store.recordSummaryModel(next);
        agent.setSummaryModel(next);
      }
      if (patch.temperature !== undefined) agent.setTemperature(patch.temperature);
      if (patch.maxIterations !== undefined) agent.setMaxIterations(patch.maxIterations);
      if (patch.thinkingEffort !== undefined) agent.setThinkingEffort(patch.thinkingEffort);

      entry.configRevision = this.nextConfigRevision();
      const applied: SessionConfigEvent = {
        type: "session_config",
        configRevision: entry.configRevision,
        model: agent.model,
        contextWindow: contextWindowFor(agent.model),
        summaryModel: agent.summaryModel,
        temperature: agent.temperature,
        maxIterations: agent.maxIterations,
        thinkingEffort: agent.thinkingEffort,
      };
      this.options.hub.publish(sessionId, applied);
      return applied;
    } finally {
      entry.configuring = false;
    }
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
        // 终答消息落盘时随行写入的引用：透出给前端重建引用卡片；损坏行直接丢弃
        const citations = message.role === "assistant" ? (message as { citations?: unknown }).citations : undefined;
        const kept = Array.isArray(citations) ? citations.filter(isPersistedCitation) : undefined;
        const outcome = RunOutcomeSchema.safeParse(
          message.role === "assistant" ? (message as { outcome?: unknown }).outcome : undefined,
        );
        messages.push({
          role: message.role,
          content: message.content,
          ...(kept && kept.length > 0 ? { citations: kept } : {}),
          ...(outcome.success ? { outcome: outcome.data } : {}),
        });
      }
    }
    const task = this.taskStoreFor(entry).current();
    return { summary: await this.summaryFor(sessionId, messages.length), messages, ...(task ? { task } : {}) };
  }

  tasks(sessionId: string) {
    return this.taskStoreFor(this.entry(sessionId)).list();
  }

  async status(): Promise<StatusDTO> {
    const { config, skills, sandbox, mcp } = this.options.runtime;
    return {
      model: config.model,
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

  /** SSE 订阅：建立后立即发 hello（运行环境）、该会话的未决审批/输入请求与排队消息快照 */
  subscribe(sessionId: string, listener: (event: ServerEvent) => void): () => void {
    this.entry(sessionId);
    const unsubscribe = this.options.hub.subscribe(sessionId, listener);
    let subscribed = true;
    void this.helloFor(sessionId).then((hello) => {
      if (!subscribed) return;
      listener(hello);
      const entry = this.entry(sessionId);
      const task = this.taskStoreFor(entry).current();
      if (task) listener({ type: "task_update", task });
      for (const event of this.options.bridge.pendingEventsFor(sessionId)) {
        listener(event);
      }
      // 排队消息是纯内存态：刷新/重连后靠这里的快照恢复芯片显示
      if (entry.queue.length > 0) this.publishQueue(entry, sessionId, listener);
    }).catch((error: unknown) => {
      if (subscribed) listener({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return () => { subscribed = false; unsubscribe(); };
  }

  /**
   * 发消息：斜杠命令与普通消息分两路。
   * - 命令（/model /prompts /prompt /rewind /help /tokens 等，以 / 开头）：与 REPL
   *   同一条路由就地执行——不入队、不发 run_start/run_end、不落会话文件（与 REPL
   *   终端打印同权的一次性 UI 态）；/task* 例外，仍走下面的队列到 Agent 内部拦截。
   * - 普通消息：统一入队再派发。会话空闲时立即开跑（与旧行为一致）；正忙时排队，
   *   当前回合结束后自动按序接续——不再用 409 把消息打回。返回 queued=true 表示
   *   这条消息在队列里等待（前端展示为排队芯片，run_start.queueId 到达时转正）。
   */
  async sendMessage(
    sessionId: string,
    text: string
  ): Promise<Omit<MessageSendResponse, "ok">> {
    const entry = this.entry(sessionId);
    if (entry.configuring) throw new Error("当前会话正在更新配置，请稍后再发");
    if (isCommandText(text)) {
      const agent = await this.ensureAgent(entry, sessionId);
      const outcome = await handleSlashCommand(text, {
        agent,
        store: entry.store,
        mcp: this.options.runtime.mcp,
        checkpoints: entry.checkpoints,
        isBusy: () => entry.controller !== undefined || entry.queue.length > 0,
        lastRunStats: () => entry.lastRunStats,
      });
      if (outcome.kind === "handled") {
        return {
          queued: false,
          queueId: "",
          handled: true,
          lines: outcome.lines,
          ...(outcome.refresh ? { refresh: outcome.refresh } : {}),
        };
      }
      // /task* 落回普通消息路径（Agent.runManaged 内部拦截）
    }
    if (entry.queue.length >= MAX_QUEUE_LENGTH) throw new Error(`发送队列已满（${MAX_QUEUE_LENGTH} 条），请等当前回合结束`);
    const item: QueuedMessage = {
      id: `q-${randomUUID().slice(0, 8)}`,
      text,
      waited: entry.controller !== undefined,
    };
    // 先取快照再派发：runNext 会同步置位 controller，派发后再读会把"立即执行"误判成"已排队"
    const dispatchNow = entry.controller === undefined;
    entry.queue.push(item);
    this.publishQueue(entry, sessionId);
    if (dispatchNow) void this.runNext(entry, sessionId);
    return { queued: !dispatchNow, queueId: item.id };
  }

  /** 撤销一条排队消息（只影响未开始的；正在跑的用 cancel）。返回是否真的撤到了。 */
  removeQueued(sessionId: string, queueId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    const index = entry.queue.findIndex((item) => item.id === queueId);
    if (index === -1) return false;
    entry.queue.splice(index, 1);
    this.publishQueue(entry, sessionId);
    return true;
  }

  /** 当前队列快照（测试与诊断用） */
  queueSnapshot(sessionId: string): Array<{ id: string; text: string }> {
    return this.entry(sessionId).queue.map(({ id, text }) => ({ id, text }));
  }

  cancel(sessionId: string): void {
    // 只停当前回合：排队中的消息保留，当前回合收尾后按序接续（要撤排队用 removeQueued）
    this.entries.get(sessionId)?.controller?.abort();
    this.options.bridge.disposeSession(sessionId);
  }

  /** 服务器关停：中止在飞回合、收口未决审批、回收 MCP 子进程与长连接 */
  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      entry.queue = [];
    }
    for (const sessionId of this.entries.keys()) this.options.bridge.disposeSession(sessionId);
    await this.options.runtime.dispose();
  }

  // ---------- 内部 ----------

  /**
   * 取队首开跑；回合收尾（含取消/失败）后若队列还有消息则自动接续下一条。
   * 链式调用不 await：sendMessage 只负责入队与首次触发，全程事件经 hub 可观测。
   */
  private async runNext(entry: SessionEntry, sessionId: string): Promise<void> {
    const next = entry.queue.shift();
    if (!next) return;
    this.publishQueue(entry, sessionId);
    const controller = new AbortController();
    entry.controller = controller;
    try {
      await this.runTurn(entry, sessionId, next.text, controller.signal, next.waited ? next.id : undefined);
    } catch (error) {
      // runTurn 内部已把 agent.run 的失败兜成 error 事件；这里只兜逃逸异常，链条继续
      this.options.hub.publish(sessionId, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.options.bridge.disposeSession(sessionId);
      entry.controller = undefined;
      if (entry.queue.length > 0) void this.runNext(entry, sessionId);
    }
  }

  /** 队列快照广播；直连 listener 的重放变体用于订阅建立时（走 hub 会让别的订阅者收到两遍） */
  private publishQueue(entry: SessionEntry, sessionId: string, listener?: (event: ServerEvent) => void): void {
    const event: ServerEvent = { type: "queue_changed", items: entry.queue.map(({ id, text }) => ({ id, text })) };
    if (listener) listener(event);
    else this.options.hub.publish(sessionId, event);
  }

  private taskStoreFor(entry: SessionEntry): TaskStore {
    return entry.agent?.taskStore ?? new TaskStore(path.join(entry.store.dir, "tasks", `${path.basename(entry.store.filePath, ".jsonl")}.sqlite`));
  }

  private entry(sessionId: string): SessionEntry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { store: new SessionStore({ dir: this.options.sessionDir, sessionId }), needsName: false,
        configRevision: this.nextConfigRevision(), queue: [] };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  private async helloFor(sessionId: string): Promise<ServerEvent> {
    const status = await this.status();
    const entry = this.entry(sessionId);
    const agent = await this.ensureAgent(entry, sessionId);
    const model = agent.model;
    return {
      type: "hello",
      model,
      configRevision: entry.configRevision,
      // hello 声明的是本会话生效的摘要模型（会话级覆盖优先，回退服务器默认）
      summaryModel: agent.summaryModel,
      sandbox: status.sandbox,
      sandboxRoot: this.options.runtime.sandboxRoot,
      contextWindow: contextWindowFor(model),
      ...(agent !== undefined
        ? { temperature: agent.temperature, maxIterations: agent.maxIterations,
            thinkingEffort: agent.thinkingEffort }
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
    // 首次订阅与设置请求可能并发抵达，必须共享同一个初始化结果。
    if (entry.initializing) return entry.initializing;
    const pending = this.createAgent(entry, sessionId);
    entry.initializing = pending;
    try {
      return await pending;
    } finally {
      entry.initializing = undefined;
    }
  }

  private async createAgent(entry: SessionEntry, sessionId: string): Promise<Agent> {
    const { config, registry: sharedRegistry, skills, sandbox, sandboxRoot, disableRunScript, memoryStore, memoryRecall, memoryWriter, jobs } = this.options.runtime;
    const startup = await entry.store.load();
    entry.needsName = startup.messages.length === 0;

    // 每会话独立注册表：计划仓私有（并行 run 互不踩）；无状态内置工具按同一清单重新组装；
    // MCP 工具定义从共享注册表拷贝（定义绑定的是连接不是注册表，拷贝安全）
    const registry = new ToolRegistry();
    registry.use(createToolTelemetry());
    registry.use(createToolEventBridge(this.options.hub, sessionId));
    registry.use(createMcpUseTracker(this.options.bridge, sessionId));
    const planStore = new PlanStore();
    registerSessionTools(registry, {
      skills, planStore, sandbox, sandboxRoot, disableRunScript,
      config,
      memoryStore,
      // 全服共用一个任务仓实例：/jobs 面板与各会话看到的 tracked 状态一致
      jobs,
      // 委派子代理的轨迹落在本会话目录下，随会话一起可查
      delegateTraceDir: path.join(entry.store.dir, "delegates"),
    });
    copyMcpTools(sharedRegistry, registry);

    // 工具开关：快照全量定义（关→开的恢复数据源），再应用本会话的关闭集合
    entry.registry = registry;
    entry.toolDefs = new Map(registry.list().map((def) => [def.name, def]));
    for (const name of entry.disabledTools ?? []) registry.unregister(name);
    // 提示词里的文件操作分工按本会话实际启用的工具生成
    const filesystemTools = registry.list().map((def) => def.name).filter((name) => name.startsWith("filesystem__"));

    // 回合级检查点（/rewind）：影子仓库随会话目录存放（.agent-sessions 已 gitignore），
    // 快照钩子与 CLI 共用同一工厂——历史 compact 与后台长期摘要落盘之后、本轮 user 消息落盘之前拍快照
    const checkpoints = config.checkpointsEnabled
      ? new CheckpointStore({
          shadowRoot: path.join(entry.store.dir, "checkpoints", sessionId),
          sandboxRoot,
          sessionRecordCount: () => entry.store.recordCount(),
        })
      : undefined;
    entry.checkpoints = checkpoints;

    const agent = new Agent({
      model: startup.model ?? config.model,
      // 沙箱根会话级可见（提示词里告诉模型工作区在哪）；切换沙箱后 Agent 整体重建。
      // 环境快照随本次重建取一次，会话生命周期内不重算（缓存安全，见 env_block.ts）
      systemPrompt: buildSystemPrompt(sandboxRoot, skills, {
        filesystemTools,
        visionCapable: config.visionCapable,
        env: snapshotEnv(sandboxRoot),
      }),
      maxIterations: config.maxIterations,
      temperature: config.temperature,
      thinkingEffort: config.thinkingEffort,
      toolSearch: config.toolSearch,
      visionCapable: config.visionCapable,
      maxHistoryTurns: config.maxHistoryTurns,
      budget: config.budget,
      sessionStore: entry.store,
      // 摘要模型会话级恢复：会话里记录过就用记录，否则服务器默认
      summaryModel: startup.summaryModel ?? config.summaryModel,
      ...(this.options.runtime.untrustedContext !== undefined
        ? { untrustedContext: this.options.runtime.untrustedContext }
        : {}),
      tools: registry,
      planStore,
      memoryStore,
      memoryRecall,
      memoryWriter,
      verificationRoot: sandboxRoot,
      requireHostAcceptanceCriteria: config.requireHostAcceptanceCriteria,
      stream: config.stream,
      ...(checkpoints ? { onTurnStart: createCheckpointSnapshotHook(checkpoints) } : {}),
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
    agent.events.on("task_update", ({ task }) => hub.publish(sessionId, { type: "task_update", task }));
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
          ...(step.tokens.cachedPromptTokens !== undefined
            ? { cachedPromptTokens: step.tokens.cachedPromptTokens }
            : {}),
        },
      });
    });
    agent.events.on("plan_update", ({ steps }) => {
      hub.publish(sessionId, { type: "plan_update", steps });
    });
    // 工具心跳：开始/结束仍由注册表中间件发（带结果原文），这里只补"已运行多久"
    agent.events.on("tool_progress", ({ callId, name, elapsedMs }) => {
      hub.publish(sessionId, { type: "tool_progress", callId, name, elapsedMs });
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

  /**
   * 把共享注册表的 MCP 工具集合对齐进本会话注册表（增/删，按 `serverId__tool` 名）。
   * MCP 定义是无状态闭包（策略/路径守卫在 execute 里），按定义拷贝安全，与
   * copyMcpTools 同语义；变更时刷新定义快照（工具开关的恢复源）、重应用本会话
   * 关闭集合，并广播 tools_changed 让前端重拉工具面板。
   */
  private syncMcpTools(entry: SessionEntry, sessionId: string): void {
    const sessionRegistry = entry.registry;
    if (!sessionRegistry) return;
    const sharedDefs = this.options.runtime.registry.list().filter((def) => def.name.includes("__"));
    const sharedNames = new Set(sharedDefs.map((def) => def.name));
    const sessionNames = new Set(
      sessionRegistry.list().filter((def) => def.name.includes("__")).map((def) => def.name)
    );
    let changed = false;
    for (const def of sharedDefs) {
      if (!sessionNames.has(def.name)) {
        sessionRegistry.register(def, { replace: true });
        changed = true;
      }
    }
    for (const name of sessionNames) {
      if (!sharedNames.has(name)) {
        sessionRegistry.unregister(name);
        changed = true;
      }
    }
    if (!changed) return;
    entry.toolDefs = new Map(sessionRegistry.list().map((def) => [def.name, def]));
    for (const name of entry.disabledTools ?? []) sessionRegistry.unregister(name);
    this.options.hub.publish(sessionId, { type: "tools_changed" });
  }

  private async runTurn(
    entry: SessionEntry,
    sessionId: string,
    text: string,
    signal: AbortSignal,
    queueId?: string
  ): Promise<void> {
    const agent = await this.ensureAgent(entry, sessionId);
    // MCP 工具同步：共享注册表是唯一热更新目标（.mcp.json 变更 / ToolListChanged），
    // 每会话注册表在回合开始时与其对齐——长驻会话下一回合就能用上新增/移除的 MCP 工具
    this.syncMcpTools(entry, sessionId);
    this.options.hub.publish(sessionId, {
      type: "run_start",
      userMessage: text,
      promptHash: agent.systemPromptHash,
      ...(queueId !== undefined ? { queueId } : {}),
    });
    const runtime: ToolRuntime = {
      signal,
      requestHuman: this.options.bridge.requestHuman,
      askUser: this.options.bridge.askUser,
      requestBudgetExtension: (request) =>
        this.options.bridge.requestBudgetExtension(formatBudgetExtensionPrompt(request), signal),
    };

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
      runStatus: result.runStatus,
      taskStatus: result.taskStatus,
      stopReason: result.stopReason,
      finishReason: result.finishReason,
      refusal: result.refusal,
      ...(result.taskId ? { taskId: result.taskId } : {}),
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.verification ? { verification: result.verification } : {}),
      ...(result.task ? { task: result.task } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(result.finalAnswer !== null ? { finalAnswer: result.finalAnswer } : {}),
      totalTokens: result.totalTokens,
      ...(result.cachedPromptTokens ? { cachedPromptTokens: result.cachedPromptTokens } : {}),
      toolCallsCount: result.toolCallsCount,
      iterations: result.steps.length,
      ...(result.budgetStopped !== undefined ? { budgetStopped: result.budgetStopped } : {}),
      // Grounded 引用：引用表随 run_end 透出，前端把最终回答里的 [n] 渲染成来源卡片
      ...(result.citations.length > 0 ? { citations: result.citations } : {}),
    });

    // 上一回合用量摘要（/tokens 用）
    entry.lastRunStats = {
      totalTokens: result.totalTokens,
      ...(result.cachedPromptTokens ? { cachedPromptTokens: result.cachedPromptTokens } : {}),
      toolCallsCount: result.toolCallsCount,
      iterations: result.steps.length,
      model: agent.model,
      stopReason: result.stopReason,
    };

    // 会话命名：与 REPL 的 createSessionNamer 同语义——只对第一个成功的回合尝试一次；
    // 斜杠命令不触发起名（命令不产生对话内容，起名只会得到命令名本身）
    if (entry.needsName && result.success && result.finalAnswer !== null && !signal.aborted &&
        !isCommandText(text)) {
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
    // 优先用模型 tool_call id：与核心的 tool_progress 心跳同值，前端才能把两者贴到同一张卡片
    const callId = context.id ?? `tool-${Date.now().toString(36)}-${++toolEventSeq}`;
    hub.publish(sessionId, {
      type: "tool_call_start",
      callId,
      name: context.name,
      arguments: JSON.stringify(context.args ?? {}),
    });
    try {
      const result = await next();
      hub.publish(sessionId, {
        type: "tool_call_end",
        callId,
        // 工具错误由注册表序列化成 {"error": ...}，不是异常；不认出来 UI 会把失败显示成绿色
        ...(isErrorObservation(result) ? { isError: true } : {}),
        result: clipForUi(result),
      });
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
