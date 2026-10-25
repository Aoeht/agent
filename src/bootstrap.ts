// src/bootstrap.ts
/**
 * Agent 运行栈的统一组装点：CLI（src/index.ts）与 Web UI 服务器（src/server/main.ts）
 * 共用同一套「技能发现 → 沙箱解析 → 工具注册表 → MCP 挂载 → 资源上下文」装配流程。
 * 两条入口只各自提供不同的 Confirmer（终端逐个询问 vs UI 审批桥）与日志前缀，
 * 换入口不换装配逻辑——工具、策略、沙箱语义永远一致。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ToolRegistry, ToolCallMiddleware } from "./core/registry";
import { PlanStore } from "./core/plan_store";
import { MemoryStore } from "./core/memory_store";
import { MemoryRecall } from "./core/memory_recall";
import { MemoryWriter } from "./core/memory_writer";
import { createMemoryTool } from "./tools/memory";
import { createToolTelemetry } from "./tools/telemetry";
import { createSearchWebTool } from "./tools/tavily_search";
import { createRagSearchTool } from "./tools/rag_search";
import { createInspectLinkTool } from "./tools/inspect_link";
import { createIngestFindingsTool } from "./tools/ingest_findings";
import { createBiliCollectTool } from "./tools/bili_collect";
import { createGitTreeTool } from "./tools/git_tree";
import { createUpdatePlanTool } from "./tools/update_plan";
import { createSetAcceptanceCriteriaTool, createReadTaskStateTool } from "./tools/set_acceptance_criteria";
import { createAskUserTool } from "./tools/ask_user";
import { createLoadSkillTool } from "./tools/load_skill";
import { createRunScriptTool } from "./tools/run_script";
import { createReadImageTool } from "./tools/read_image";
import { createToolSearchTool } from "./core/tool_search";
import { createDelegateTaskTool } from "./tools/delegate_task";
import { resolveScriptSandbox, ScriptSandboxResolution } from "./tools/sandbox_docker";
import { loadSkills, SkillManifest } from "./skills/loader";
import { McpAdapter } from "./mcp/adapter";
import { McpClientManager } from "./mcp/client_manager";
import { MCP_SANDBOX_DIR, McpServers } from "./mcp/config";
import { McpConfigWatcher, resolveMcpServers } from "./mcp/hot_reload";
import { createPolicyMatrix } from "./mcp/policy_matrix";
import type { Confirmer, McpResourceInfo } from "./mcp/types";
import { loadAgentConfig, AgentRunConfig, resolveMemoryDir, resolveSessionDir } from "./config";
import { createEmbeddingClientFromEnv, EmbeddingClient } from "./rag/embeddings";

export interface AgentStackOptions {
  /** 人工确认器：CLI 用终端版（createCliConfirmer），Web UI 用审批桥。缺省时策略 ask 直接拒绝 */
  confirmer?: Confirmer;
  /** 额外的注册表级中间件（如 UI 服务器的工具事件桥），加在遥测之后 */
  extraMiddleware?: ToolCallMiddleware[];
  /** 启动日志前缀：CLI 为空，UI 服务器用 "[UI] " 区分日志来源 */
  logPrefix?: string;
  /** 已加载的配置；缺省内部 loadAgentConfig()。CLI 先打配置横幅再组装，把它透传进来避免读两遍 */
  config?: AgentRunConfig;
  /**
   * 沙箱根目录（filesystem server 的白名单根 + 路径守卫 + run_script 的工作区）。
   * 缺省 MCP_SANDBOX_DIR（env 可改）。UI 服务器的「切换沙箱目录」用不同的值重建整栈。
   */
  sandboxRoot?: string;
  /**
   * 远程收紧：不注册 run_script。公网入口下的 Web UI 要用它——审批桥拦不住拿到口令的人
   * （批准执行只是一个同源 POST），所以得把任意代码执行这个能力本身摘掉。
   */
  disableRunScript?: boolean;
}

export interface AgentStack {
  config: AgentRunConfig;
  skills: SkillManifest[];
  sandbox: ScriptSandboxResolution;
  /** 实际生效的沙箱根（绝对路径） */
  sandboxRoot: string;
  registry: ToolRegistry;
  planStore: PlanStore;
  /** 跨会话核心记忆仓：全局一份，注入 Agent 上下文并绑定 memory 工具 */
  memoryStore: MemoryStore;
  /** 跨会话情景检索：按当前问题召回历史会话摘要（embedding 未配置时内部停用） */
  memoryRecall: MemoryRecall;
  /** 跨会话记忆写入管线：run 尾提取事实入仓（与记忆仓/检索共用 embedding 客户端） */
  memoryWriter: MemoryWriter;
  mcp: McpClientManager;
  /** MCP 配置热载入 watcher（关停要随 mcp 一起收口，用 dispose()） */
  mcpWatcher: McpConfigWatcher;
  /** MCP 资源注入的不可信上下文（没有可用资源时为空串） */
  untrustedContext: string;
  /** 关停配置 watcher 并断开全部 MCP 连接（取代直接调 mcp.closeAll） */
  dispose: () => Promise<void>;
}

/**
 * 把内置工具注册进一个注册表。供 createAgentStack（CLI/服务器的共享栈）与
 * UI 服务器的每会话注册表共用——工具清单只有这一份事实来源。
 * update_plan 绑定调用方给的计划仓：并行 run 各持各的 PlanStore，互不踩。
 */
export function registerSessionTools(
  registry: ToolRegistry,
  options: {
    skills: SkillManifest[];
    planStore: PlanStore;
    sandboxRoot?: string;
    /** run_script 执行后端（bootstrap 解析好的结果原样传入） */
    sandbox: ScriptSandboxResolution;
    /** 远程收紧：跳过 run_script 注册（工具清单的唯一事实来源，会话与共享栈一致） */
    disableRunScript?: boolean;
    /** 模型参数（delegate_task 组装子代理用；缺省时不注册委派工具 */
    config?: {
      model: string;
      summaryModel?: string;
      temperature?: number;
      maxIterations?: number;
      /** 子代理委派总开关（AGENT_DELEGATE 解析结果）：false 时不注册 delegate_task */
      delegateEnabled?: boolean;
    };
    /** 委派子代理的轨迹目录；缺省 .agent-sessions/delegates */
    delegateTraceDir?: string;
    /** 跨会话记忆仓；传入才注册 memory 工具（与 Agent 注入共用同一实例） */
    memoryStore?: MemoryStore;
  }
): void {
  const sandboxRoot = options.sandboxRoot ?? MCP_SANDBOX_DIR;
  // 按需加载元工具：默认每轮请求都会被 Agent 的暴露计算剔除（未触发阈值时无意义），
  // 工具 schema 超过上下文水位后才对模型可见——注册表里常驻，暴露与否由 Agent 决定
  registry.register(createToolSearchTool({ registry }));
  registry.register(createUpdatePlanTool(options.planStore));
  registry.register(createSetAcceptanceCriteriaTool());
  registry.register(createReadTaskStateTool());
  // 跨会话记忆：模型自管的 user/feedback/project/reference 四类事实，宿主注入同一 MemoryStore 实例
  if (options.memoryStore) registry.register(createMemoryTool(options.memoryStore));
  // 主动澄清：信息缺失且查不到时向用户征询自由文本回答，通道由入口注入（CLI readline / UI human_input_request）
  registry.register(createAskUserTool());
  registry.register(createSearchWebTool());
  registry.register(createRagSearchTool());
  registry.register(createInspectLinkTool());
  registry.register(createIngestFindingsTool());
  // B 站视频快照读数：读取 dataset/<BV>.json（独立采集流程产物）做证据预处理，
  // 供 scanner 子代理与主对话直接调用；快照缺失时报错并指引，不影响其它工具
  registry.register(createBiliCollectTool());
  // 仓库结构只读工具：目录树 + 提交图，回答"项目长什么样"类问题，免确认、可并发
  registry.register(createGitTreeTool());
  // 本地图片进视觉通道的入口：图片直接附加到下一轮模型输入，
  // 不让多模态模型绕道 read_media_file 的 base64 文本或外部视觉服务
  registry.register(createReadImageTool({ sandboxRoot }));
  if (options.skills.length > 0) registry.register(createLoadSkillTool(options.skills, { sandboxRoot }));
  // 主对话内的子 Agent 委派：只读白名单子代理跑独立调研/复核，报告经围栏回注本对话。
  // 子代理注册表在委派发生时从本注册表按白名单拷贝（不含 delegate_task 自身，无递归）；
  // AGENT_DELEGATE=off（config.delegateEnabled=false）时整体不注册，scanner 委派随之不可用。
  if (options.config && options.config.delegateEnabled !== false) {
    registry.register(createDelegateTaskTool({
      sourceRegistry: registry,
      config: options.config,
      sandboxRoot,
      ...(options.delegateTraceDir ? { traceDir: options.delegateTraceDir } : {}),
    }));
  }
  // 沙箱脚本执行器：技能脚本（load_skill 物化到 .skills/）与模型自写脚本共用的唯一执行面；
  // 执行后端由 AGENT_SANDBOX 解析结果决定（宿主机进程或一次性容器），
  // 两种后端每次执行都经 requestHuman 人工确认，不依赖技能是否安装。
  // 远程收紧时这条整块不注册：摘掉能力，比指望审批拦住拿到口令的人可靠
  if (!options.disableRunScript) {
    registry.register(
      createRunScriptTool({
        sandboxRoot,
        backend:
          options.sandbox.backend === "docker"
            ? { kind: "docker", image: options.sandbox.image, network: options.sandbox.network }
            : { kind: "host" },
      })
    );
  }
}

/**
 * 把 MCP 工具定义从共享注册表拷贝到目标注册表（UI 服务器每会话并行用）。
 * adapter 构建的 MCP 定义是无状态闭包——绑定的是 server 连接与中间件链，
 * 不绑定注册表本身，所以按定义拷贝是安全的；拷贝后策略/路径守卫原样生效。
 * 注意：共享注册表上的工具热更新（ToolListChanged）不会自动传播到已拷贝的会话，
 * 会话在下一次 ensureAgent 时才重新拷贝——对长驻 UI 可接受，暂不做得更复杂。
 */
export function copyMcpTools(source: ToolRegistry, target: ToolRegistry): void {
  for (const definition of source.list()) {
    // MCP 工具的注册名固定为 `serverId__toolName`（adapter 的 namespacedName），
    // 内置工具不含双下划线，以此区分
    if (definition.name.includes("__")) {
      target.register(definition, { replace: true });
    }
  }
}

export async function createAgentStack(options: AgentStackOptions = {}): Promise<AgentStack> {
  const prefix = options.logPrefix ?? "";
  const config = options.config ?? loadAgentConfig();
  const sandboxRoot = path.resolve(options.sandboxRoot ?? MCP_SANDBOX_DIR);

  // 0. 技能发现：读 .agents/skills（AGENT_SKILLS_DIR 可改）。只取清单，正文由模型按需 load_skill 读取；
  //    解析失败的目录告警但不阻塞启动。清单为空时行为与未开启技能完全一致（不注册工具、提示词不变）
  const { skills, issues } = await loadSkills({ dir: config.skillsDir });
  for (const issue of issues) {
    console.warn(`⚠️  ${prefix}跳过技能目录 ${issue.dir}: ${issue.error}`);
  }
  if (skills.length > 0) {
    console.log(`🧩 ${prefix}已加载 ${skills.length} 个技能：${skills.map((s) => s.name).join(", ")}`);
  }

  // 1. 准备沙箱目录（server-filesystem 与路径守卫共用同一个根）
  await fs.mkdir(sandboxRoot, { recursive: true });

  // 1.5 解析 run_script 执行沙箱：auto 在 docker/镜像不可用时显式回退（原因打进启动日志）；
  //     AGENT_SANDBOX=docker 是强承诺，daemon/镜像缺失直接抛错终止启动，不静默降级
  const sandbox = await resolveScriptSandbox(config.sandbox.mode, {
    image: config.sandbox.image,
    network: config.sandbox.network,
  });
  if (sandbox.backend === "docker") {
    console.log(
      `📦 ${prefix}脚本沙箱: docker 容器（${sandbox.image} · 网络${sandbox.network === "none" ? "断开" : "bridge"} · rootfs 只读 · 资源硬顶）`
    );
  } else {
    console.log(`📦 ${prefix}脚本沙箱: 宿主机进程（${sandbox.reason}）`);
  }

  // 2. 工具注册表：入口显式组装（内置工厂 + 统一遥测中间件），Agent 与 MCP adapter 共用同一实例；
  //    不再依赖 import 副作用，同一进程内可以再组装出别的工具集跑别的 agent
  const registry = new ToolRegistry();
  registry.use(createToolTelemetry());
  for (const middleware of options.extraMiddleware ?? []) registry.use(middleware);
  // 计划状态仓与工具分开各持一半：仓由 Agent 消费（pin 上下文 + 事件），工具只做校验写入
  const planStore = new PlanStore();
  // 跨会话记忆仓：全局一份（CLI 与 Web 服务器各自创建，同一工作区共目录）；
  // 读取失败只降级为「无记忆」，不阻塞启动
  const memoryStore = new MemoryStore({ dir: resolveMemoryDir() });
  const memoryCount = await memoryStore.active().then((entries) => entries.length, () => 0);
  console.log(`🧠 ${prefix}跨会话记忆: ${memoryCount} 条（${memoryStore.dir}）`);
  // 情景检索的 embedding 客户端在此解析一次：未配置 EMBEDDING_MODEL 静默停用，
  // 配置错误（缺地址/Key）当面告警但不阻塞启动
  let recallEmbeddings: EmbeddingClient | undefined;
  try {
    recallEmbeddings = createEmbeddingClientFromEnv();
  } catch (error) {
    console.warn(`⚠️ ${prefix}跨会话情景检索停用: ${error instanceof Error ? error.message : error}`);
  }
  const memoryRecall = new MemoryRecall({
    sessionDir: resolveSessionDir(),
    cacheDir: memoryStore.dir,
    embeddings: recallEmbeddings ?? null,
  });
  // 写入管线与检索共用 embedding 客户端（无状态），但查重向量缓存独立成文件
  const memoryWriter = new MemoryWriter({
    store: memoryStore,
    model: config.model,
    summaryModel: config.summaryModel,
    embeddings: recallEmbeddings ?? null,
    cacheDir: memoryStore.dir,
  });
  console.log(
    `🔍 ${prefix}跨会话情景检索: ${recallEmbeddings ? `已启用（${recallEmbeddings.model}）` : "停用（未配置 EMBEDDING_MODEL）"}`
  );
  console.log(
    `🤝 ${prefix}子代理委派: ${config.delegateEnabled ? "已启用（delegate_task）" : "已关闭（AGENT_DELEGATE）"}`
  );
  registerSessionTools(registry, {
    skills,
    planStore,
    sandbox,
    sandboxRoot,
    memoryStore,
    disableRunScript: options.disableRunScript === true,
    config,
  });

  // 3. MCP：白名单根目录 + 请求超时都在 adapter 上统一声明
  const adapter = new McpAdapter({
    registry,
    allowedRoots: [sandboxRoot],
    requestTimeoutMs: 60_000,
    maxResultChars: 20_000,
    // 风险策略矩阵：只读/本地非破坏写入放行，破坏性或外部可写询问，外部破坏性拒绝，
    // 未声明 annotations 的工具走保守默认（询问）。
    toolPolicy: createPolicyMatrix({
      toolOverrides: {
        // filesystem 写文件靠路径守卫兜底，矩阵按 moderate 放行即可；
        // 如需更严可在此按注册名收紧，例如 "fake__purge_all": "deny"
      },
    }),
    ...(options.confirmer !== undefined ? { confirmer: options.confirmer } : {}),

    onProgress: ({ registeredName, progress, total, message }) => {
      const suffix = total === undefined ? `${progress}` : `${progress}/${total}`;
      console.log(`[MCP] Progress ${registeredName}: ${suffix}${message ? ` (${message})` : ""}`);
    },
    onAudit: ({ phase, registeredName, args, durationMs, resultChars, errorName }) => {
      const details = [
        `args=${JSON.stringify(args)}`,
        durationMs === undefined ? undefined : `duration=${durationMs}ms`,
        resultChars === undefined ? undefined : `result=${resultChars}chars`,
        errorName === undefined ? undefined : `error=${errorName}`,
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`[MCP] Audit ${phase} ${registeredName} ${details}`);
    },
  });
  const mcp = new McpClientManager(
    adapter,
    ({ serverId, level, logger, data }) => {
      console.log(`[MCP] Server log ${serverId} ${level}${logger ? ` ${logger}` : ""}:`, data);
    },
    options.confirmer
  );

  console.log(`⏳ ${prefix}正在挂载 MCP 服务...`);
  // 配置来源：内置默认 ⊕ .mcp.json（AGENT_MCP_CONFIG 可改路径）；文件变更无需重启，
  // McpConfigWatcher 防抖监听并增量应用（增/删/改=重连）。文件缺失时与纯内置行为一致。
  const { servers: initialServers, fileIssues } = await resolveMcpServers();
  for (const issue of fileIssues) console.warn(`⚠️  ${prefix}.mcp.json: ${issue}`);
  const reports = await mcp.loadFromConfig(initialServers);
  for (const report of reports) {
    console.log(report.ok ? `✅ ${report.id}: ${report.tools?.length ?? 0} 个工具` : `❌ ${report.id}: ${report.error}`);
  }
  const mcpWatcher = new McpConfigWatcher(mcp);
  // 水位与实际加载结果对齐：启动失败的 server 下次文件变更时会作为"新增"重试
  mcpWatcher.useApplied(reports.filter((report) => report.ok).map((report) => initialServers.find((s) => s.id === report.id)!));
  mcpWatcher.start();

  // 4. 挑资源注入上下文：只是原始文本，不进 systemPrompt；Agent 会统一套上"不可信数据"围栏
  const untrustedContext = await collectCapabilitiesContext(mcp);

  return {
    config,
    skills,
    sandbox,
    sandboxRoot,
    registry,
    planStore,
    memoryStore,
    memoryRecall,
    memoryWriter,
    mcp,
    mcpWatcher,
    untrustedContext,
    dispose: async () => {
      mcpWatcher.close();
      await mcp.closeAll();
    },
  };
}

/**
 * 把各 Server 声明的 resources/prompts 拉一份清单，并挑一条文本资源当背景资料塞进上下文。
 * 读取只走 listResources/readResource，不注册成工具 —— 模型看不到也调不动，
 * 由 host 显式决定注入哪一段内容，避免资源文本变成可被提示注入诱导的"可执行入口"。
 */
async function collectCapabilitiesContext(
  mcp: McpClientManager,
  maxContextChars = 8_000
): Promise<string> {
  const resources = await mcp.listResources().catch((error) => {
    console.warn("[MCP] listResources 失败:", error instanceof Error ? error.message : error);
    return [] as McpResourceInfo[];
  });
  const prompts = await mcp.listPrompts().catch(() => []);

  if (resources.length === 0 && prompts.length === 0) return "";

  console.log("[MCP] 可用资源:", resources.map((r) => `${r.serverId}:${r.name}`).join(", ") || "（无）");
  console.log("[MCP] 可用提示模板:", prompts.map((p) => `${p.serverId}:${p.name}`).join(", ") || "（无）");

  // 只挑 Server 自己标了 text/* 或 markdown 的资源读进上下文，图片/二进制不适合直接塞
  const sections: string[] = [];
  let usedChars = 0;
  for (const resource of resources) {
    const mimeType = resource.mimeType ?? "";
    if (mimeType && !/^text\//.test(mimeType) && mimeType !== "application/json" && mimeType !== "text/markdown") {
      continue;
    }
    try {
      const contents = await mcp.readResource(resource.serverId, resource.uri);
      const text = contents
        .map((content) => ("text" in content ? content.text : `[二进制内容 ${content.blob.length} chars，未注入]`))
        .join("\n");
      if (usedChars + text.length > maxContextChars) break;
      sections.push(`### ${resource.serverId}:${resource.name}\n${text}`);
      usedChars += text.length;
    } catch (error) {
      console.warn(
        `[MCP] 资源 ${resource.serverId}:${resource.name} 读取被拦截或失败:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  // 只交出原始文本：不可信数据的围栏由 Agent 统一套（wrapUntrustedData 单点收口），
  // 这里再包一层会变成双重围栏。
  return sections.join("\n\n");
}
