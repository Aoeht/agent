// web/src/lib/mock.ts
import type {
  ApprovalDecisionBody,
  CheckpointListDTO,
  CheckpointSummaryDTO,
  JobLogChunkDTO,
  JobSummaryDTO,
  ModelProbeStatusResponse,
  RewindResponse,
  RewindScope,
  ServerEvent,
  SessionDetailDTO,
  SessionSummaryDTO,
  ThinkingEffort,
  UserImageUploadBody,
} from "@protocol";
import type { Transport } from "./transport";

/**
 * 演示用 MockTransport：严格按 protocol.ts 的类型发事件，
 * 把 UI 的所有状态（流式、工具卡、计划、审批、取消、统计）都跑一遍。
 * 接真实后端时整体换成 HttpTransport，UI 层不改一行。
 */

const HOURS = 3_600_000;

class AbortedError extends Error {}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AbortedError());
      },
      { once: true }
    );
  });
}

const helloEvent: Extract<ServerEvent, { type: "hello" }> = {
  type: "hello",
  model: "glm-5.2",
  summaryModel: "qwen3.6-plus",
  sandbox: "宿主机进程（docker 未就绪，auto 回退）",
  sandboxRoot: "A:/ai_agent/.mcp-sandbox（演示）",
  contextWindow: 200_000,
  temperature: 0.1,
  maxIterations: 0,
  vision: true,
  promptHash: "a3f19c02e4b7",
  skills: ["qianwen-audio-tts", "qianwen-image-generation", "qianwen-video-generation"],
  mcpServers: [
    { id: "filesystem", ok: true, tools: 11 },
    { id: "tavily", ok: true, tools: 2 },
  ],
};

const MOCK_MODELS = ["glm-5.2", "glm-4.6", "qwen3.6-plus", "deepseek-v4-pro"];

function mockContextWindow(model: string): number {
  return model.startsWith("glm") ? 200_000 : 128_000;
}

/** 历史会话样本：让侧栏和续聊回放有真实感 */
function fixtureSessions(): SessionDetailDTO[] {
  return [
    {
      summary: {
        sessionId: "session-20261018-143210",
        name: "RAG 混合检索调参",
        messageCount: 6,
        lastUpdated: new Date(Date.now() - 20 * HOURS).toISOString(),
        firstUserText: "现在 rerank 权重是不是太偏向向量了？top-k=20 之后 BM25 几乎没有贡献。",
      },
      messages: [
        {
          role: "user",
          content: "现在 rerank 权重是不是太偏向向量了？top-k=20 之后 BM25 几乎没有贡献。",
        },
        {
          role: "assistant",
          content: [
            "先说结论：怀疑方向是对的，但更可能的问题是**精排池太小**，而不是权重本身。",
            "",
            "从 `docs/rag-design.md` 的默认配置看，`rerank.candidates` 只有 20——top-k 截断之后进入精排的候选太少，BM25 召回的长尾关键词根本轮不到参与排序。",
            "",
            "| 配置项 | 文档建议值 | 当前值 |",
            "| --- | --- | --- |",
            "| vector.weight | 0.6 | 0.7 |",
            "| bm25.weight | 0.4 | 0.3 |",
            "| rerank.candidates | ≥ 50 | 20 |",
            "",
            "建议先扩大精排池再动权重，需要的话我可以列一份完整的调参顺序。",
          ].join("\n"),
        },
      ],
    },
    {
      summary: {
        sessionId: "session-20261017-090415",
        name: "Docker 沙箱冒烟测试",
        messageCount: 4,
        lastUpdated: new Date(Date.now() - 44 * HOURS).toISOString(),
        firstUserText: "run_script 在 docker 后端下面连网都断了，是预期行为吗？",
      },
      messages: [
        { role: "user", content: "run_script 在 docker 后端下面连网都断了，是预期行为吗？" },
        {
          role: "assistant",
          content:
            "是预期行为。容器网络默认 `none`（防脚本外传数据），需要联网时显式设 `AGENT_SANDBOX_NET=bridge`。\n\n不过注意：这台机器当前没有 docker 守护进程，`AGENT_SANDBOX=auto` 会回退到宿主机进程执行，网络不受限——所以你看到断网说明当时走的是容器后端。",
        },
      ],
    },
  ];
}

/** 把一段文本按小块流出去，模拟 token 事件 */
async function stream(
  emit: (event: ServerEvent) => void,
  text: string,
  signal: AbortSignal,
  chunkSize = 2,
  delayMs = 24
): Promise<void> {
  for (let i = 0; i < text.length; i += chunkSize) {
    emit({ type: "token", delta: text.slice(i, i + chunkSize) });
    await sleep(delayMs, signal);
  }
}

const FINAL_ACCEPT_ANSWER = [
  "## 调参结论",
  "",
  "对照 `docs/rag-design.md` 与当前配置，问题定位如下：[1]",
  "",
  "| 配置项 | 文档建议值 | 当前值 | 影响 |",
  "| --- | --- | --- | --- |",
  "| rerank.candidates | ≥ 50 | 20 | 精排池太小，BM25 长尾进不了精排 |",
  "| vector.weight | 0.6 | 0.7 | 语义召回权重略偏高 |",
  "| bm25.weight | 0.4 | 0.3 | 关键词贡献被稀释 |",
  "",
  "**建议**（按收益排序）：",
  "",
  "1. 把 `rerank.candidates` 提到 50——这是 top-k=20 之后 BM25 几乎没贡献的主因；",
  "2. 权重调整到向量 0.6 / BM25 0.4，跑一周对比命中率；",
  "3. 每周用基线脚本回归一次，改动先落在 `.sand-box/` 再合入。",
  "",
  "```yaml",
  "# .env 调整后的目标配置",
  "RERANK_CANDIDATES=50",
  "VECTOR_WEIGHT=0.6",
  "BM25_WEIGHT=0.4",
  "```",
  "",
  "脚本验证结果：基线 nDCG@10 **0.62 → 0.71**，与文档预期一致[2]。基线测试定义见 `tests/rag_ranking.test.ts`[3]。需要的话我可以把这次调参写一条 findings 存进知识库。",
].join("\n");

/** 演示用 Grounded 引用来源（编号与最终回答中的 [n] 对应） */
const DEMO_CITATIONS = [
  {
    index: 1,
    title: "docs/rag-design.md#L112 — 检索权重设计",
    url: "https://github.com/ai-agent/ai-agent/blob/main/docs/rag-design.md#L112",
    snippet: "初版默认权重 向量 0.7 / BM25 0.3；精排池 rerank.candidates 建议 ≥ 50",
    tool: "rag_search",
  },
  {
    index: 2,
    title: "scripts/rerank_bench.ts 基线输出",
    url: "https://github.com/ai-agent/ai-agent/blob/main/.sand-box/rerank_bench.out",
    snippet: "基线 nDCG@10 = 0.62，调整 candidates=50 后 0.71",
    tool: "run_script",
  },
  {
    index: 3,
    title: "tests/rag_ranking.test.ts — nDCG@10 基线断言",
    url: "https://github.com/ai-agent/ai-agent/blob/main/tests/rag_ranking.test.ts",
    snippet: "nDCG@10 基线 0.62",
    tool: "rag_search",
  },
] as const satisfies Extract<ServerEvent, { type: "run_end" }>["citations"];

const FINAL_DECLINE_ANSWER = [
  "明白，不执行脚本。那先只基于文档给你**无侵入的调参建议**（按预期收益排序）：",
  "",
  "1. `rerank.candidates` 从 20 提到 50——top-k=20 之后 BM25 没贡献的主因就是精排池太小；",
  "2. 权重从向量 0.7 / BM25 0.3 调到 0.6 / 0.4，观察一周命中率；",
  "3. 想验证的时候随时让我跑基线脚本，改动只落在 `.sand-box/`。",
  "",
  "另外提醒一句：`tests/rag_ranking.test.ts` 里的 nDCG@10 基线是 0.62，改完权重先跑这个测试，避免回归。",
].join("\n");

/** 一条完整演示链路：流式 → 工具 → 计划 → 压缩/重试 → 审批 → 结果 */
async function runDemoScript(
  emit: (event: ServerEvent) => void,
  signal: AbortSignal,
  userMessage: string,
  awaitApproval: (id: string) => Promise<ApprovalDecisionBody>,
  images?: Array<{ name: string; mimeType: string; sizeBytes: number }>
): Promise<void> {
  emit({ type: "run_start", userMessage, promptHash: "a3f19c02e4b7",
    ...(images !== undefined && images.length > 0 ? { images } : {}) });
  try {
    await sleep(500, signal);
    await stream(
      emit,
      "好的，我先看一下仓库结构，找到检索相关模块，再查一下设计文档里对权重的约定。",
      signal
    );

    emit({
      type: "tool_call_start",
      callId: "call-1",
      name: "git_tree",
      arguments: JSON.stringify({ maxDepth: 2 }),
    });
    await sleep(1500, signal);
    emit({
      type: "tool_call_end",
      callId: "call-1",
      result: [
        "src/",
        "  core/    agent.ts · events.ts · context_manager.ts · plan_store.ts …",
        "  tools/   rag_search.ts · git_tree.ts · run_script.ts · tavily_search.ts …",
        "  mcp/     adapter.ts · policy_matrix.ts · cli_confirmer.ts …",
        "  rag/     ingest.ts · retrieve.ts …",
        "docs/      rag-design.md · roadmap.md",
        "web/       （当前 UI）",
        "tests/     rag_ranking.test.ts …",
      ].join("\n"),
    });

    emit({
      type: "plan_update",
      steps: [
        { content: "摸清仓库结构与检索相关模块", status: "completed" },
        { content: "检索混合检索权重的设计文档", status: "in_progress" },
        { content: "跑 rerank 基线脚本验证当前配置", status: "pending" },
        { content: "汇总结论并给出调参建议", status: "pending" },
      ],
    });

    emit({
      type: "tool_call_start",
      callId: "call-2",
      name: "rag_search",
      arguments: JSON.stringify({ query: "混合检索 rerank 权重 BM25 向量" }),
    });
    await sleep(1600, signal);
    emit({
      type: "tool_call_end",
      callId: "call-2",
      result: [
        "docs/rag-design.md#L112：初版默认权重 向量 0.7 / BM25 0.3",
        "docs/rag-design.md#L140：精排池 rerank.candidates 建议 ≥ 50",
        "tests/rag_ranking.test.ts：nDCG@10 基线 0.62",
      ].join("\n"),
    });

    emit({
      type: "compact",
      action: "fold_summary",
      messages: 8,
      tokens: 3120,
      detail: "旧对话轮已折叠进滚动摘要",
    });
    emit({ type: "retry", attempt: 1, delayMs: 520, reason: "429 rate limited（模拟）" });
    await sleep(800, signal);

    await stream(
      emit,
      "文档确认了两点：初版权重是向量 0.7 / BM25 0.3；另外精排池建议至少 50 个候选——你观察到的「BM25 没贡献」更可能是精排池太小。接下来我想跑一遍基线脚本验证，脚本只读仓库、写 `.sand-box/` 临时目录，需要你确认：",
      signal
    );

    emit({
      type: "approval_request",
      id: "approval-demo-1",
      source: "run_script",
      toolName: "run_script",
      message: "允许执行 scripts/rerank_bench.ts 吗？脚本只读仓库、写入 .sand-box/ 临时目录（宿主机进程执行）。",
      requestedSchema: {
        timeout: { type: "string", title: "超时（秒）", description: "脚本最长运行时间", default: "60" },
      },
    });
    const decision = await awaitApproval("approval-demo-1");

    if (decision.action === "accept") {
      emit({
        type: "tool_call_start",
        callId: "call-3",
        name: "run_script",
        arguments: JSON.stringify({
          script: "scripts/rerank_bench.ts",
          timeout: decision.content?.timeout ?? "60",
        }),
      });
      await sleep(1900, signal);
      emit({
        type: "tool_call_end",
        callId: "call-3",
        result: [
          "基线 nDCG@10 = 0.62",
          "调整 candidates=50 后 nDCG@10 = 0.71",
          "输出已写入 .sand-box/rerank_bench.out",
        ].join("\n"),
      });
      emit({
        type: "plan_update",
        steps: [
          { content: "摸清仓库结构与检索相关模块", status: "completed" },
          { content: "检索混合检索权重的设计文档", status: "completed" },
          { content: "跑 rerank 基线脚本验证当前配置", status: "completed" },
          { content: "汇总结论并给出调参建议", status: "in_progress" },
        ],
      });
      await sleep(400, signal);
      await stream(emit, FINAL_ACCEPT_ANSWER, signal, 3, 14);
      emit({
        type: "plan_update",
        steps: [
          { content: "摸清仓库结构与检索相关模块", status: "completed" },
          { content: "检索混合检索权重的设计文档", status: "completed" },
          { content: "跑 rerank 基线脚本验证当前配置", status: "completed" },
          { content: "汇总结论并给出调参建议", status: "completed" },
        ],
      });
      emit({ type: "session_name", name: "RAG 权重验证" });
      emit({
        type: "run_end",
        success: true,
        finalAnswer: FINAL_ACCEPT_ANSWER,
        totalTokens: 12480,
        toolCallsCount: 3,
        iterations: 5,
        citations: DEMO_CITATIONS,
      });
    } else {
      await stream(emit, FINAL_DECLINE_ANSWER, signal, 3, 14);
      emit({ type: "session_name", name: "RAG 权重讨论" });
      emit({
        type: "run_end",
        success: true,
        finalAnswer: FINAL_DECLINE_ANSWER,
        totalTokens: 9210,
        toolCallsCount: 2,
        iterations: 4,
      });
    }
  } catch (error) {
    if (signal.aborted) {
      emit({ type: "run_end", success: false, totalTokens: 1830, toolCallsCount: 0, iterations: 1 });
    } else {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

export class MockTransport implements Transport {
  readonly kind = "mock" as const;
  private listeners = new Map<string, Set<(event: ServerEvent) => void>>();
  private runs = new Map<string, AbortController>();
  private approvals = new Map<string, (body: ApprovalDecisionBody) => void>();
  /** 忙时消息的会话队列（FIFO），回合结束后自动接续——与真实服务器同语义 */
  private queues = new Map<string, Array<{
    id: string;
    text: string;
    waited: boolean;
    images?: Array<{ name: string; mimeType: string; sizeBytes: number }>;
  }>>();
  private queueSeq = 0;
  private sessions: SessionDetailDTO[];
  private seq = 0;
  /** 会话级配置（内存态）；applySessionConfig 更新并广播 session_config */
  private sessionConfig = new Map<string, { model: string; summaryModel: string; temperature: number; maxIterations: number; thinkingEffort: ThinkingEffort; contextWindow?: number; configRevision: number }>();
  private configRevision = Date.now();
  private disabledTools = new Map<string, Set<string>>();
  private sandboxRoot = "A:/ai_agent/.mcp-sandbox（演示）";
  /** 演示用检查点：按历史里的 user 消息生成（消息下标即 seq 边界） */
  private checkpoints = new Map<string, CheckpointSummaryDTO[]>();

  constructor() {
    this.sessions = fixtureSessions();
  }

  private emit(sessionId: string, event: ServerEvent): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
  }

  async listSessions(): Promise<SessionSummaryDTO[]> {
    return this.sessions.map((s) => s.summary);
  }

  async createSession(): Promise<SessionSummaryDTO> {
    const sessionId = `mock-session-${++this.seq}-${Date.now() % 100_000}`;
    const summary: SessionSummaryDTO = {
      sessionId,
      messageCount: 0,
      lastUpdated: new Date().toISOString(),
      firstUserText: "",
    };
    this.sessions.unshift({ summary, messages: [] });
    return summary;
  }

  async openSession(sessionId: string): Promise<SessionDetailDTO> {
    const found = this.sessions.find((s) => s.summary.sessionId === sessionId);
    if (!found) throw new Error("会话不存在");
    return found;
  }

  async listModels(): Promise<string[]> {
    return [...MOCK_MODELS];
  }

  async listModelStatus(): Promise<ModelProbeStatusResponse> {
    // 演示数据：第二个模型模拟配额耗尽，让过滤与标注逻辑在 mock 下也能看到
    return {
      models: MOCK_MODELS.map((model, index) => ({
        model,
        ok: index !== 1,
        kind: index === 1 ? ("quota" as const) : ("ok" as const),
        ...(index === 1 ? { detail: "Free quota exhausted (mock)" } : {}),
      })),
    };
  }

  async applySessionConfig(
    sessionId: string,
    config: { model?: string; summaryModel?: string; contextWindow?: number | null; temperature?: number; maxIterations?: number; thinkingEffort?: ThinkingEffort }
  ): Promise<Extract<ServerEvent, { type: "session_config" }>> {
    const current: {
      model: string; summaryModel: string; temperature: number; maxIterations: number;
      thinkingEffort: ThinkingEffort; contextWindow?: number;
    } = this.sessionConfig.get(sessionId) ?? {
      model: helloEvent.model,
      summaryModel: helloEvent.summaryModel ?? helloEvent.model,
      temperature: 0.1,
      maxIterations: 0,
      thinkingEffort: "default" as ThinkingEffort,
    };
    // null = 清空覆盖；undefined = 不动
    const contextWindow = config.contextWindow === null
      ? undefined
      : config.contextWindow ?? current.contextWindow;
    const next = {
      configRevision: ++this.configRevision,
      model: config.model?.trim() || current.model,
      summaryModel: config.summaryModel?.trim() || current.summaryModel,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      temperature: config.temperature ?? current.temperature,
      maxIterations: config.maxIterations ?? current.maxIterations,
      thinkingEffort: config.thinkingEffort ?? current.thinkingEffort,
    };
    this.sessionConfig.set(sessionId, next);
    const applied = {
      type: "session_config" as const,
      configRevision: next.configRevision,
      model: next.model,
      contextWindow: contextWindow ?? mockContextWindow(next.model),
      ...(contextWindow !== undefined ? { contextWindowOverride: contextWindow } : {}),
      summaryModel: next.summaryModel,
      temperature: next.temperature,
      maxIterations: next.maxIterations,
      thinkingEffort: next.thinkingEffort,
    };
    // 稍微延迟，走一遍真实的事件路径
    setTimeout(() => {
      this.emit(sessionId, applied);
    }, 200);
    return applied;
  }

  async getSettings(): Promise<{ sandboxRoot: string }> {
    return { sandboxRoot: this.sandboxRoot };
  }

  async setSandboxRoot(dir: string): Promise<void> {
    this.sandboxRoot = dir;
  }

  async listTools(sessionId: string): Promise<{ tools: Array<{ name: string; description: string }>; disabled: string[] }> {
    const tools = [
      { name: "update_plan", description: "维护本回合的任务计划清单" },
      { name: "git_tree", description: "仓库目录树与提交图（只读）" },
      { name: "rag_search", description: "知识库混合检索（BM25 + 向量）" },
      { name: "tavily_search", description: "网页搜索" },
      { name: "run_script", description: "在沙箱中执行脚本（需人工确认）" },
      { name: "filesystem__read_file", description: "[MCP filesystem] 读取文件" },
      { name: "filesystem__write_file", description: "[MCP filesystem] 写入文件" },
    ];
    return { tools, disabled: [...(this.disabledTools.get(sessionId) ?? [])] };
  }

  async setToolState(sessionId: string, disabled: string[]): Promise<void> {
    this.disabledTools.set(sessionId, new Set(disabled));
  }

  // 演示数据：一条已结束的后台任务；真实后端经 JobStore 读取同目录 JSON
  async listJobs(): Promise<JobSummaryDTO[]> {
    const startedAt = Date.now() - 42_000;
    return [{
      id: "job-19700101-000000-demo",
      script: "scripts/collect.py",
      args: ["--pages", "5"],
      backend: "host",
      status: "exited",
      exitCode: 0,
      startedAt,
      deadlineAt: startedAt + 600_000,
      endedAt: startedAt + 38_400,
    }];
  }

  async readJobLog(_jobId: string, stream: "stdout" | "stderr", after?: number): Promise<JobLogChunkDTO> {
    const text = stream === "stdout" ? "[demo] 抓取第 1 页 … 完成\n[demo] 抓取第 2 页 … 完成\n" : "";
    return after === undefined
      ? { stream, text, offset: text.length, size: text.length, reset: true }
      : { stream, text: "", offset: after, size: text.length, reset: false };
  }

  async killJob(_jobId: string): Promise<void> {
    // 演示环境没有真实进程
  }

  private checkpointsFor(sessionId: string): CheckpointSummaryDTO[] {
    const cached = this.checkpoints.get(sessionId);
    if (cached !== undefined) return cached;
    const found = this.sessions.find((s) => s.summary.sessionId === sessionId);
    const base = Date.now() - 90 * 60_000;
    const list = (found?.messages ?? []).flatMap((message, index): CheckpointSummaryDTO[] =>
      message.role === "user"
        ? [{
            seq: index + 1,
            time: new Date(base + index * 7 * 60_000).toISOString(),
            input: message.content,
            records: index,
          }]
        : []);
    this.checkpoints.set(sessionId, list);
    return list;
  }

  async listCheckpoints(sessionId: string): Promise<CheckpointListDTO> {
    // 最新在前（与服务端列表一致）
    return { enabled: true, checkpoints: [...this.checkpointsFor(sessionId)].reverse() };
  }

  async rewindCheckpoint(sessionId: string, seq: number, scope: RewindScope): Promise<RewindResponse> {
    if (this.runs.has(sessionId)) throw new Error("回合进行中，结束后再回滚");
    const picked = this.checkpointsFor(sessionId).find((info) => info.seq === seq);
    if (picked === undefined) throw new Error(`检查点 #${seq} 不存在（可能已被裁剪）`);
    const lines: string[] = [];
    const response: RewindResponse = { ok: true, seq, scope, lines };
    if (scope !== "chat") {
      response.restored = 3;
      response.deleted = 1;
      lines.push(`⏪ 已恢复工作区：写回 3 个文件，删除 1 个该时点之后新增的文件。`);
    }
    if (scope !== "code") {
      const found = this.sessions.find((s) => s.summary.sessionId === sessionId);
      if (found !== undefined) {
        found.messages = found.messages.slice(0, picked.records);
        found.summary = { ...found.summary, messageCount: found.messages.length };
      }
      response.records = picked.records;
      response.refresh = "history";
      lines.push(`⏪ 已恢复对话：会话历史截断到第 ${seq} 号检查点的边界（${picked.records} 条记录），下轮生效。`);
    }
    if (response.refresh === "history") this.emit(sessionId, { type: "history_rewound", seq, scope });
    return response;
  }

  subscribe(
    sessionId: string,
    onEvent: (event: ServerEvent) => void,
    onStatus?: (status: "connected" | "reconnecting") => void
  ): () => void {
    onStatus?.("connected");
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(onEvent);
    queueMicrotask(() => {
      if (!set.has(onEvent)) return;
      const config = this.sessionConfig.get(sessionId);
      onEvent({ ...helloEvent, ...config,
        contextWindow: config?.contextWindow ?? mockContextWindow(config?.model ?? helloEvent.model),
        ...(config?.contextWindow !== undefined ? { contextWindowOverride: config.contextWindow } : {}) });
      // 排队消息快照（刷新/重连恢复），与真实服务器 subscribe 的补发一致
      const queue = this.queues.get(sessionId);
      if (queue && queue.length > 0) {
        onEvent({ type: "queue_changed", items: queue.map(({ id, text }) => ({ id, text })) });
      }
    });
    return () => {
      set.delete(onEvent);
    };
  }

  private publishQueue(sessionId: string): void {
    const queue = this.queues.get(sessionId) ?? [];
    this.emit(sessionId, { type: "queue_changed", items: queue.map(({ id, text }) => ({ id, text })) });
  }

  async sendMessage(
    sessionId: string,
    text: string,
    images?: UserImageUploadBody[]
  ): Promise<{ queued: boolean; queueId: string }> {
    const queue = this.queues.get(sessionId) ?? [];
    this.queues.set(sessionId, queue);
    const meta = images?.map((image, index) => ({
      name: image.name?.trim() || `图片 ${index + 1}`,
      mimeType: image.mimeType ?? "image/png",
      sizeBytes: Math.max(0, Math.floor((image.dataUrl.length - image.dataUrl.indexOf(",") - 1) * 3 / 4)),
    }));
    const item = {
      id: `mock-q-${++this.queueSeq}`,
      text,
      waited: this.runs.has(sessionId),
      ...(meta !== undefined && meta.length > 0 ? { images: meta } : {}),
    };
    queue.push(item);
    this.publishQueue(sessionId);
    if (this.runs.has(sessionId)) return { queued: true, queueId: item.id };
    void this.startRun(sessionId);
    return { queued: false, queueId: item.id };
  }

  private async startRun(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId) ?? [];
    const next = queue.shift();
    this.publishQueue(sessionId);
    if (!next) return;
    const controller = new AbortController();
    this.runs.set(sessionId, controller);
    try {
      await runDemoScript(
        (event) => this.emit(sessionId, event.type === "run_start" && next.waited ? { ...event, queueId: next.id } : event),
        controller.signal,
        next.text,
        (id) =>
          new Promise<ApprovalDecisionBody>((resolve) => {
            this.approvals.set(id, resolve);
          }),
        next.images
      );
    } finally {
      this.runs.delete(sessionId);
      if ((this.queues.get(sessionId) ?? []).length > 0) void this.startRun(sessionId);
    }
  }

  async removeQueuedMessage(sessionId: string, queueId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    const index = queue?.findIndex((item) => item.id === queueId) ?? -1;
    if (index === -1 || !queue) throw new Error("队列中没有这条消息");
    queue.splice(index, 1);
    this.publishQueue(sessionId);
  }

  /** 取消进行中的回合；未决审批一并按 decline 收口（与真实服务器的取消语义一致） */
  async cancel(sessionId: string): Promise<void> {
    this.runs.get(sessionId)?.abort();
    for (const [id, resolve] of this.approvals) {
      resolve({ action: "decline" });
      this.approvals.delete(id);
    }
  }

  async respondApproval(
    _sessionId: string,
    approvalId: string,
    body: ApprovalDecisionBody
  ): Promise<void> {
    const resolve = this.approvals.get(approvalId);
    this.approvals.delete(approvalId);
    resolve?.(body);
  }

  async respondInput(_sessionId: string, _requestId: string, _text: string): Promise<void> {
    // 演示脚本未触发人工输入；接真实后端时由 HttpTransport 实现对应端点
  }
}
