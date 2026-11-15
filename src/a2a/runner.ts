// src/a2a/runner.ts
/**
 * A2A 服务端的任务执行器：把入站消息交给本地 Agent 栈跑完，返回可投影的运行结果。
 *
 * 装配与 SessionManager.createAgent 同构（registerSessionTools + copyMcpTools + 遥测），
 * 但有三处刻意的不同：
 * 1. **全自主**：不注入 requestHuman/askUser/审批桥——调用方是远端 Agent，没有"人"在场。
 *    这正是授权前移（进阶篇 8.3）：run_script 这类需要人工确认的工具会拿不到批准而失败，
 *    属于预期行为；远端调用方拿到的能力在装配时就定死，不靠运行时拦截。
 * 2. **每 contextId 一个 Agent**：同一上下文的后续消息续聊同一实例（A2A 的 contextId 语义），
 *    同上下文的并发请求用 promise 链串行——单个 Agent 实例不支持交错 run。
 * 3. **上下文数量有上限**：A2A 的 contextId 是对端随手带的字符串，不设上限等于给攻击者
 *    一个内存泄漏开关；超上限按插入顺序淘汰最旧的（其后续消息自然开新上下文）。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Agent } from "../core/agent";
import type { StepEvent } from "../core/events";
import { PlanStore } from "../core/plan_store";
import { ToolRegistry } from "../core/registry";
import { TraceRecorder } from "../core/trace";
import { createToolTelemetry } from "../tools/telemetry";
import { copyMcpTools, registerSessionTools } from "../bootstrap";
import { buildSystemPrompt } from "../prompts/system";
import { snapshotEnv } from "../prompts/env_block";
import type { ServerRuntime } from "../server/runtime";

/** 流式进度：只给轮次与工具名，不转发模型内部文本/工具返回原文（公开进度摘要） */
export interface A2aRunProgress {
  iteration: number;
  toolNames: string[];
}

/** 运行结果只暴露投影层需要的字段——runner 类型上就封锁了 messages/steps 的外流路径 */
export type A2aRunResult = Pick<import("../core/types").AgentResult, "finalAnswer" | "stopReason" | "errorMessage">;

export interface A2aRunInput {
  contextId: string;
  /** 入站文本（已从 parts 提取）；作为 user 消息进入 Agent 历史 */
  text: string;
  signal: AbortSignal;
  onProgress?: (progress: A2aRunProgress) => void;
}

export interface A2aTaskRunner {
  run(input: A2aRunInput): Promise<A2aRunResult>;
}

/** 上下文数量上限：超过即淘汰最旧的上下文（其下次消息自动开新上下文） */
const MAX_CONTEXTS = 64;

export function createA2aTaskRunner(
  runtime: ServerRuntime,
  options?: { traceDir?: string }
): A2aTaskRunner {
  const resolvedTraceDir =
    options?.traceDir ??
    (process.env.AGENT_TRACE_DIR?.trim()
      ? path.join(process.env.AGENT_TRACE_DIR, "a2a")
      : path.join(process.cwd(), ".agent-a2a", "traces"));

  const contexts = new Map<string, { agent: Agent; chain: Promise<void> }>();

  async function buildAgent(contextId: string): Promise<Agent> {
    const { config, registry: sharedRegistry, skills, sandbox, sandboxRoot, disableRunScript, memoryStore, memoryRecall, memoryWriter, jobs, untrustedContext } = runtime;
    const registry = new ToolRegistry();
    registry.use(createToolTelemetry());
    const planStore = new PlanStore();
    registerSessionTools(registry, {
      skills,
      planStore,
      sandbox,
      sandboxRoot,
      disableRunScript,
      config,
      memoryStore,
      jobs,
      // 会话 id 标注来源：后台任务记录能区分这是 A2A 入站的调用
      sessionId: `a2a:${contextId.slice(0, 8)}`,
    });
    copyMcpTools(sharedRegistry, registry);
    const filesystemTools = registry.list().map((def) => def.name).filter((name) => name.startsWith("filesystem__"));
    const agent = new Agent({
      model: config.model,
      systemPrompt: buildSystemPrompt(sandboxRoot, skills, {
        filesystemTools,
        visionCapable: config.visionCapable,
        env: snapshotEnv(sandboxRoot),
      }),
      maxIterations: config.maxIterations,
      temperature: config.temperature,
      thinkingEffort: config.thinkingEffort,
      toolSearch: config.toolSearch,
      toolConcurrencyLimit: config.toolConcurrencyLimit,
      toolTimeoutMs: config.toolTimeoutMs,
      ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
      visionCapable: config.visionCapable,
      maxHistoryTurns: config.maxHistoryTurns,
      budget: config.budget,
      summaryModel: config.summaryModel,
      ...(untrustedContext !== undefined && untrustedContext !== "" ? { untrustedContext } : {}),
      tools: registry,
      planStore,
      memoryStore,
      memoryRecall,
      memoryWriter,
      verificationRoot: sandboxRoot,
      requireHostAcceptanceCriteria: config.requireHostAcceptanceCriteria,
      stream: config.stream,
    });
    try {
      new TraceRecorder(resolvedTraceDir, `a2a-${contextId.slice(0, 12)}-${randomUUID().slice(0, 8)}`).attach(agent.events);
    } catch {
      // 轨迹不可写不影响任务
    }
    return agent;
  }

  return {
    async run(input: A2aRunInput): Promise<A2aRunResult> {
      let context = contexts.get(input.contextId);
      if (context === undefined) {
        context = { agent: await buildAgent(input.contextId), chain: Promise.resolve() };
        contexts.set(input.contextId, context);
        if (contexts.size > MAX_CONTEXTS) {
          const oldest = contexts.keys().next().value;
          if (oldest !== undefined) contexts.delete(oldest);
        }
      }
      const agent = context.agent;
      const run = async (): Promise<A2aRunResult> => {
        // 进度事件订阅要复用同一函数引用（off 必须传注册时的同一个）
        const onStep = (event: StepEvent): void => {
          const step = event.step;
          input.onProgress?.({ iteration: step.iteration, toolNames: step.toolCalls.map((call) => call.name) });
        };
        agent.events.on("step", onStep);
        try {
          const result = await agent.run(input.text, { signal: input.signal });
          return { finalAnswer: result.finalAnswer, stopReason: result.stopReason, errorMessage: result.errorMessage };
        } finally {
          agent.events.off("step", onStep);
        }
      };
      // 串行化同上下文的并发请求：后到的排在当前 run 之后
      const chained = context.chain.then(run, run);
      context.chain = chained.then(
        () => undefined,
        () => undefined
      );
      return chained;
    },
  };
}
