// src/config.ts
/**
 * CLI 运行配置：环境变量 → 类型化配置对象，全部带默认值。
 * 换模型、调预算、改迭代数不再需要动源码。
 *
 * 可用环境变量：
 *   AGENT_MODEL                    主模型（默认 glm-5.2）
 *   AGENT_SUMMARY_MODEL            历史压缩摘要用的模型（默认 qwen3.6-plus）
 *   AGENT_MAX_ITERATIONS           单次 run 的最大 ReAct 迭代数，0/负数表示不限（默认 0）
 *   AGENT_TEMPERATURE              采样温度（默认 0.1）
 *   AGENT_THINKING_EFFORT          思考程度：default（跟随厂商默认）/ off / low / medium / high，
 *                                  按当前模型映射成厂商请求字段（qwen=enable_thinking+thinking_budget、
 *                                  glm=thinking.type、deepseek=thinking+reasoning_effort，其余厂商不注入）
 *   AGENT_MAX_HISTORY_TURNS        跨进程续聊保留的完整对话轮数（默认 20）
 *   AGENT_MAX_TOTAL_TOKENS         单次 run 的 token 硬预算，<=0 表示不限（默认 500000）
 *   AGENT_MAX_TOOL_CALLS           单次 run 的工具调用总次数上限，<=0 表示不限（默认 40）
 *   AGENT_MAX_TOOL_CALLS_PER_NAME  单个工具名的调用次数上限，<=0 表示不限（默认 12）
 *   AGENT_STREAM                   是否流式输出，"0"/"false" 关闭（默认开启）
 *   AGENT_REPL                     设为 "1" 时即使 stdin 非终端也进入逐行 REPL（脚本/测试用）
 *   AGENT_TRACE_DIR                运行轨迹（.traces JSONL）落盘目录，缺省为项目根 .traces
 *   AGENT_SESSION_ID / AGENT_SESSION_DIR  会话选择，见 chooseSession
 *   AGENT_SKILLS_DIR               Agent Skill 目录（缺省 .agents/skills，即 skills CLI 的安装位置）
 *   AGENT_SANDBOX                  run_script 执行沙箱：host（宿主机进程）/ docker（一次性容器）/
 *                                  auto（默认，docker 守护进程与镜像都就绪才启用容器，否则显式回退 host）
 *   AGENT_SANDBOX_IMAGE            docker 沙箱镜像（默认 ai-agent-sandbox:latest，构建见 tools/sandbox/Dockerfile）
 *   AGENT_SANDBOX_NET              docker 沙箱网络：none 断网（默认，防外传）/ bridge 显式放开
 *   AGENT_JOB_DIR                  后台脚本任务目录（任务 JSON + stdout/stderr 日志，缺省 .agent-data/jobs）
 *   AGENT_TOOL_SEARCH              按需加载（Tool Search）：auto（默认，工具 schema 超过模型
 *                                  上下文窗口 10% 时自动切换）/ on（强制）/ off（关闭）；
 *                                  切换后每轮只暴露第一方工具 + tool_search + 已激活的 MCP 工具
 *   AGENT_DELEGATE                 主对话内子 Agent 委派工具 delegate_task，"0"/"false"/"off"/"no"
 *                                  关闭（默认开启）；关闭后不注册该工具，scanner 委派随之不可用
 *   AGENT_CHECKPOINTS              是否开启回合级回滚检查点（/rewind），"0"/"false" 关闭（默认开启）
 *   AGENT_TOOL_CONCURRENCY         同批 parallelSafe 工具调用的并发上限（默认 4；非安全工具不进并发池）
 *   AGENT_TOOL_TIMEOUT_MS          单次工具执行死线兜底（毫秒，默认 0=关；超时转 error observation，run 继续）
 *   AGENT_CONTEXT_WINDOW           覆盖模型上下文窗口（token，默认按模型名查表）；小窗口模型或表里没有的模型用
 *   AGENT_VISION                   所选模型能否理解图片，"0"/"false"/"off"/"no" 关闭（默认开启）；
 *                                  关闭后不提供图片通道，read_image 直接返回可读错误
 *   AGENT_MEMORY_DIR               跨会话记忆目录（缺省 .agent-memory；记忆条目 memory.jsonl + MEMORY.md 视图）
 *   AGENT_MODEL_PROBE              对话开始时探测候选模型可用性（微型补全），"0"/"false" 关闭（默认开启）
 */

import path from "node:path";
import type { RunBudgetLimits } from "./core/run_budget";
import { parseThinkingEffort, type ThinkingEffort } from "./utils/thinking_effort";

/** 跨会话记忆目录：AGENT_MEMORY_DIR 可改，缺省落在工作区 .agent-memory（与 .agent-sessions 同级） */
export function resolveMemoryDir(): string {
  return process.env.AGENT_MEMORY_DIR?.trim() || path.join(process.cwd(), ".agent-memory");
}

/** 会话目录：AGENT_SESSION_DIR 可改，缺省 .agent-sessions（与 main.ts/index.ts 原内联逻辑一致） */
export function resolveSessionDir(): string {
  return process.env.AGENT_SESSION_DIR?.trim() || path.join(process.cwd(), ".agent-sessions");
}

/** 后台脚本任务目录：AGENT_JOB_DIR 可改，缺省 .agent-data/jobs（任务记录 JSON + stdout/stderr 日志） */
export function resolveJobDir(): string {
  return process.env.AGENT_JOB_DIR?.trim() || path.join(process.cwd(), ".agent-data", "jobs");
}

/** run_script 执行沙箱模式，语义见 tools/sandbox_docker.ts 的 resolveScriptSandbox */
export type ScriptSandboxMode = "host" | "docker" | "auto";

export interface SandboxConfig {
  mode: ScriptSandboxMode;
  /** docker 沙箱镜像：镜像即解释器白名单（python3/bun/bash），host 模式忽略 */
  image: string;
  /** 容器网络档位：none 断网（默认）/ bridge 放开，host 模式忽略 */
  network: "none" | "bridge";
}

export interface AgentRunConfig {
  model: string;
  summaryModel: string;
  maxIterations: number;
  temperature: number;
  /** 思考程度档位：default 跟随厂商默认，off/low/medium/high 按厂商映射（见 utils/thinking_effort.ts） */
  thinkingEffort: ThinkingEffort;
  /** 按需加载模式：auto 按上下文 10% 阈值自动切换，on 强制，off 关闭（见 core/agent.ts computeToolExposure） */
  toolSearch: "auto" | "on" | "off";
  /** 主对话内子 Agent 委派（delegate_task）：false 时整体不注册该工具 */
  delegateEnabled: boolean;
  /** 同批 parallelSafe 工具调用的并发上限（信号量宽度），≥1；默认 4 */
  toolConcurrencyLimit: number;
  /** 单次工具执行死线兜底（毫秒），0 = 关；只对未声明自有 timeoutMs 的工具生效 */
  toolTimeoutMs: number;
  /** 覆盖上下文窗口（token）；缺省按模型名查表（见 utils/model_registry.ts） */
  contextWindow?: number;
  /** 所选模型能否理解图片；false 时不提供图片通道（read_image 返回可读错误） */
  visionCapable: boolean;
  maxHistoryTurns: number;
  stream: boolean;
  /** Agent Skill 目录：目录不存在视为没有技能，运行时行为与未开启技能完全一致 */
  skillsDir: string;
  /** run_script 执行沙箱：决定脚本是宿主机进程还是容器内一次性执行 */
  sandbox: SandboxConfig;
  /** 回合级回滚检查点（/rewind）：开启后每轮对话开始前快照工作区与会话边界 */
  checkpointsEnabled: boolean;
  /** 验收绿灯只认宿主设定的条件：模型自设条件实测全部通过也只记「已回答，未验收」 */
  requireHostAcceptanceCriteria: boolean;
  budget: RunBudgetLimits;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** 数值型预算：<=0 视为不设限（映射成缺省，交给 RunBudget 的「缺省即不限」语义） */
function limitEnv(name: string, fallback: number): number | undefined {
  const value = intEnv(name, fallback);
  return value > 0 ? value : undefined;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export function loadAgentConfig(): AgentRunConfig {
  const maxTotalTokens = limitEnv("AGENT_MAX_TOTAL_TOKENS", 500_000);
  const maxToolCalls = limitEnv("AGENT_MAX_TOOL_CALLS", 40);
  const maxToolCallsPerName = limitEnv("AGENT_MAX_TOOL_CALLS_PER_NAME", 12);
  // 0/负数/非法值都视为未设置：缺省由模型名查表决定窗口
  const contextWindow = limitEnv("AGENT_CONTEXT_WINDOW", 0);
  // 枚举型环境变量只认列出的字面量，其余一律落回默认值（不猜测、不告警刷屏）
  const sandboxModeRaw = process.env.AGENT_SANDBOX?.trim().toLowerCase();
  const toolSearchRaw = process.env.AGENT_TOOL_SEARCH?.trim().toLowerCase();

  return {
    model: process.env.AGENT_MODEL ?? "glm-5.2",
    summaryModel: process.env.AGENT_SUMMARY_MODEL ?? "qwen3.6-plus",
    // 默认不设轮数上限：长任务的完成度优先，花费由 token / 工具次数预算兜底
    maxIterations: Math.max(0, intEnv("AGENT_MAX_ITERATIONS", 0)),
    temperature: floatEnv("AGENT_TEMPERATURE", 0.1),
    thinkingEffort: parseThinkingEffort(process.env.AGENT_THINKING_EFFORT),
    toolSearch: toolSearchRaw === "on" || toolSearchRaw === "off" ? toolSearchRaw : "auto",
    delegateEnabled: boolEnv("AGENT_DELEGATE", true),
    // 并发上限至少 1：0/负数没有意义，落回 1（等价于串行）
    toolConcurrencyLimit: Math.max(1, intEnv("AGENT_TOOL_CONCURRENCY", 4)),
    toolTimeoutMs: Math.max(0, intEnv("AGENT_TOOL_TIMEOUT_MS", 0)),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    // 默认开：厂商真拒收 image_url 时 Agent 会运行期闩锁关闭，猜错模型名的代价比误关小
    visionCapable: boolEnv("AGENT_VISION", true),
    maxHistoryTurns: intEnv("AGENT_MAX_HISTORY_TURNS", 20),
    stream: boolEnv("AGENT_STREAM", true),
    skillsDir: process.env.AGENT_SKILLS_DIR?.trim() || ".agents/skills",
    sandbox: {
      mode: sandboxModeRaw === "host" || sandboxModeRaw === "docker" || sandboxModeRaw === "auto" ? sandboxModeRaw : "auto",
      image: process.env.AGENT_SANDBOX_IMAGE?.trim() || "ai-agent-sandbox:latest",
      network: process.env.AGENT_SANDBOX_NET?.trim().toLowerCase() === "bridge" ? "bridge" : "none",
    },
    checkpointsEnabled: boolEnv("AGENT_CHECKPOINTS", true),
    requireHostAcceptanceCriteria: boolEnv("AGENT_REQUIRE_HOST_CRITERIA", false),
    budget: {
      ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
      ...(maxToolCallsPerName !== undefined ? { maxToolCallsPerName } : {}),
    },
  };
}
