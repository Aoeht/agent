// src/index.ts
import { Agent, PromptTemplateInjection } from "./core/agent";
import { formatPlanCli } from "./core/plan_store";
import type { McpClientManager } from "./mcp/client_manager";
import { MCP_SANDBOX_DIR } from "./mcp/config";
import { createCliConfirmer } from "./mcp/cli_confirmer";
import path from "node:path";
import readline from "node:readline/promises";
import { SessionStore } from "./core/session_store";
import { newSession, pickSession, PickedSession } from "./core/session_picker";
import { loadAgentConfig, resolveSessionDir } from "./config";
import { createAgentStack } from "./bootstrap";
import { buildSystemPrompt } from "./prompts/system";
import { snapshotEnv } from "./prompts/env_block";
import { handleSlashCommand, isCommandText, type RunStatsSummary } from "./core/command_router";
import { candidateModels, fetchZhipuAccountQuota, formatModelProbeLine, probeModels } from "./core/model_probe";
import { TraceRecorder } from "./core/trace";
import { CheckpointStore, createCheckpointSnapshotHook } from "./core/checkpoint_store";
import { AgentResult, StepInfo, ToolRuntime } from "./core/types";
import { STOP_REASON_LABELS } from "./core/run_outcome";
import { acceptedBudgetExtension, formatBudgetExtensionPrompt } from "./core/budget_prompt";
import { formatHistoryReplay } from "./core/session_replay";
import {
  MAX_IMAGES_PER_REQUEST,
  formatImageSize,
  prepareUserImages,
  readLocalImageFiles,
  type PreparedUserImage,
} from "./core/user_images";

/**
 * 会话选择：AGENT_SESSION_ID 显式指定时直接用（跳过询问，适合脚本/定时任务）；
 * 非交互环境（管道/CI）默认开新会话；终端里列出已有会话让用户续聊或新建。
 */
async function chooseSession(dir: string): Promise<PickedSession> {
  const pinned = process.env.AGENT_SESSION_ID;
  if (pinned) {
    return { store: new SessionStore({ dir, sessionId: pinned }), sessionId: pinned, isNew: false };
  }
  if (!process.stdin.isTTY) {
    return newSession(dir);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await pickSession({ dir, ask: (question) => rl.question(question) });
  } finally {
    rl.close();
  }
}

/** 一次回合的输出配置：是否流式，以及「本回合是否已经流出过增量」的共享标记 */
interface TurnUi {
  stream: boolean;
  streamState: { active: boolean };
}

/**
 * 行队列输入源：'line' 事件持续把行收进队列，next() 逐行取用。
 * 直接用 rl.question 的缺陷是：管道喂入时回合运行期间到达 EOF，readline 会关闭接口
 * 并丢掉已缓冲的行。队列模式保证 EOF 前送入的每一行都会被处理。
 */
class LineSource {
  private queue: string[] = [];
  private ended = false;
  private pending: ((line: string | null) => void) | null = null;

  constructor(private readonly rl: readline.Interface) {
    this.rl.on("line", (line) => {
      const resolve = this.pending;
      if (resolve) {
        this.pending = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });
    this.rl.on("close", () => {
      this.ended = true;
      const resolve = this.pending;
      if (resolve) {
        this.pending = null;
        resolve(null);
      }
    });
  }

  /** 取下一行；缓冲为空时先打印提示符等待输入，流结束且无缓冲行时返回 null */
  async next(prompt: string, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    if (this.queue.length > 0) {
      process.stdout.write(prompt);
      return this.queue.shift()!;
    }
    if (this.ended) return null;
    return new Promise<string | null>((resolve, reject) => {
      const onAbort = () => {
        this.pending = null;
        reject(signal?.reason ?? new Error("已取消"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = line => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }
}

/**
 * 异步事件（如后台长期摘要完成）的打印钩子。默认直出；REPL 注入"清行→打印→重绘提示符"
 * 版本，避免后台输出糊在 "你> " 提示行上——只在空闲等输入且真终端时才重绘，回合内直出。
 */
let printAsyncEvent: (msg: string) => void = (msg) => console.log(msg);

/** 工具事件走滚动日志：参数压成一行、超长截断，别把整段 JSON 铺满终端 */
function clipConsole(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function printStep(step: StepInfo, includeContent: boolean): void {
  console.log(`\n============== [迭代 ${step.iteration}] ==============`);
  const cached = step.tokens.cachedPromptTokens;
  console.log(`💰 本步消耗 Token: ${step.tokens.totalTokens}` +
    (cached && step.tokens.promptTokens > 0
      ? `（prompt ${step.tokens.promptTokens} · 前缀缓存命中 ${cached}，占 ${Math.round((cached / step.tokens.promptTokens) * 100)}%）`
      : ""));
  if (includeContent && step.llmContent) {
    console.log(`🧠 LLM 输出/思考:\n${step.llmContent}`);
  }
  if (step.toolCalls.length > 0) {
    console.log(`🛠️ 触发工具调用 (${step.toolCalls.length} 个):`);
    for (const t of step.toolCalls) {
      console.log(`  - [${t.name}] 参数: ${t.arguments}`);
    }
  }
}

/**
 * 第一轮问答结束后给会话起名的一次性回调；已经起过名的会话不会再收到调用。
 * signal 透传进去，用户在起名期间按 Ctrl+C 能立刻中断，不必等这一次小调用跑完。
 */
type SessionNamer = (
  agent: Agent,
  userInput: string,
  result: AgentResult,
  signal: AbortSignal
) => Promise<void>;

/**
 * 会话命名器：只在"这个会话还没有任何对话"时生成一次会话名并落盘（用摘要模型）。
 * 失败（模型报错 / 空标题）就什么都不写 —— 菜单会回退到首条用户消息预览，
 * 不留一个半成品的名字，也不让起名失败影响本回合的结果。
 */
function createSessionNamer(store: SessionStore, isFirstTurn: boolean): SessionNamer {
  let pending = isFirstTurn;
  return async (agent, userInput, result, signal) => {
    if (!pending || isCommandText(userInput)) return;
    const answer = result.finalAnswer?.trim();
    if (!answer) return; // 本回合没拿到最终回答（取消/预算越线）：留给下一个成功的回合
    pending = false; // 只尝试一次，避免每轮都追问模型要标题
    const name = await agent.summarizeSessionName(userInput, answer, { signal });
    if (name === undefined) return;
    const saved = await store.recordSessionName(name);
    if (saved !== undefined) console.log(`🏷️  会话名: ${saved}`);
  };
}

/** 跑一个回合并打印结果；返回 AgentResult 供调用方决定退出码/继续循环。 */
type TurnChannels = Pick<ToolRuntime, "requestHuman" | "askUser" | "requestBudgetExtension"> & {
  nameSession?: SessionNamer;
};

async function runTurn(
  agent: Agent,
  input: string,
  signal: AbortSignal,
  ui: TurnUi,
  channels: TurnChannels = {},
  images: readonly PreparedUserImage[] = []
): Promise<AgentResult> {
  const { requestHuman, askUser, requestBudgetExtension, nameSession } = channels;
  ui.streamState.active = false;
  const result = await agent.run(input, {
    signal,
    ...(requestHuman ? { requestHuman } : {}),
    ...(askUser ? { askUser } : {}),
    ...(requestBudgetExtension ? { requestBudgetExtension } : {}),
  }, images.length > 0 ? [...images] : undefined);
  if (ui.streamState.active) process.stdout.write("\n");

  if (result.finalAnswer && (!ui.stream || !ui.streamState.active ||
      result.finalAnswer === result.refusal)) {
    console.log(result.success ? "\n📝 最终回答:" : "\n📝 已返回的内容:");
    console.log(result.finalAnswer);
  }
  if (result.citations.length > 0) {
    console.log("\n📎 引用来源:");
    for (const c of result.citations) {
      console.log(`  [${c.index}] ${c.title}${c.url ? ` — ${c.url}` : ""}`);
    }
  }
  const promptTotal = result.steps.reduce((sum, step) => sum + step.tokens.promptTokens, 0);
  const cacheNote = result.cachedPromptTokens && promptTotal > 0
    ? ` · ⚡缓存命中 ${Math.round((result.cachedPromptTokens / promptTotal) * 100)}%`
    : "";
  console.log(
    `\n---------------- 💰 ${result.totalTokens} tokens${cacheNote} · 🔧 ${result.toolCallsCount} 次工具调用 ----------------`
  );
  console.log(`\n${result.success ? "📝" : "⚠️"} ${STOP_REASON_LABELS[result.stopReason]}${result.budgetStopped ? `（${result.budgetStopped}）` : ""}`);
  if (result.errorMessage) console.log(`详情：${result.errorMessage}`);
  if (result.task) console.log(`任务 ${result.task.id} · 已保存 ${result.task.runs.length} 次运行`);
  if (result.task?.criteria.length) {
    console.log(`  验收条件来源：${result.task.criteriaSource === "host" ? "宿主设定" : "模型自设（标准由模型提出）"}`);
  }
  for (const check of result.verification?.checks ?? []) {
    console.log(`  ${check.passed ? "✓" : "✗"} ${check.description}（${check.path}）：${check.detail}`);
  }
  const pendingActions = result.task?.actions.filter(action => action.state === "unknown") ?? [];
  for (const action of pendingActions) {
    console.log(`待核对操作 ${action.id}: ${action.tool}(${action.arguments})`);
  }
  if (pendingActions.length > 0) {
    console.log("核对后输入 /task resolve 操作ID applied 核对说明（未执行则用 not_applied）；逐条确认麻烦时用 /task resolve all applied 同一句说明一次收口。");
  }
  if (nameSession) await nameSession(agent, input, result, signal);
  return result;
}

/** 非交互单次模式：整段 stdin 作为一条任务，跑完退出（适合脚本/CI）。 */
async function runOneShot(
  agent: Agent,
  mcp: McpClientManager,
  ui: TurnUi,
  nameSession: SessionNamer
): Promise<void> {
  const input = (await readStdin()).trim();
  if (!input) {
    console.error('stdin 为空：请通过管道传入任务，例如 echo "任务描述" | bun run src/index.ts');
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const onSigint = () => {
    console.log("\n⏹️  收到中断信号，正在取消...");
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    const result = await runTurn(agent, input, controller.signal, ui, { nameSession });
    // 后台记忆更新等它落地再退：一次性模式没有"下一轮"来收账，摘要写盘必须先于进程退出
    await agent.flushSummary();
    if (!result.success) process.exitCode = 1;
    console.log("🔌 MCP 状态:", mcp.getStatus());
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/** REPL 专属命令：/image 把本地图片挂到下一轮消息（Web 端用输入框的附件按钮） */
function isImageCommand(input: string): boolean {
  return /^\/image(?:\s|$)/.test(input);
}

/** 拆参数：支持 "带 空格 的路径"——Windows 路径经常带空格 */
function splitCommandArgs(raw: string): string[] {
  const args: string[] = [];
  for (const match of raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value !== "") args.push(value);
  }
  return args;
}

function formatPendingImages(images: readonly PreparedUserImage[]): string {
  return images.map(image => `${image.name}（${formatImageSize(image.sizeBytes)}）`).join("、");
}

/**
 * 交互 REPL：一行一个任务，跑完回到提示符继续输入。
 * Ctrl+C 取消进行中的回合（回到提示符），空闲时 Ctrl+C / exit / quit 退出。
 * 单回合失败只终结本回合，不退出会话。
 */
async function runRepl(
  agent: Agent,
  mcp: McpClientManager,
  ui: TurnUi,
  store: SessionStore,
  nameSession: SessionNamer,
  checkpoints?: CheckpointStore,
  visionCapable = true
): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 行队列必须在任何 await 之前挂上监听：'line' 事件没有监听者即丢，
  // 管道预缓冲的行会在下方 store.load() 的 await 窗口里被打空，REPL 空转退出
  const lines = new LineSource(rl);
  // 空闲时为 null；运行中持有当前回合的 controller，供 SIGINT 取消
  let activeController: AbortController | null = null;
  let exitRequested = false;
  // 上一回合用量摘要（/tokens 用）：回合结束后更新
  let lastStats: RunStatsSummary | undefined;
  // /image 挂上的本地图片：下一轮普通消息带走即清空；不算进历史，只活在这一轮请求里
  let pendingImages: PreparedUserImage[] = [];
  // 主循环是否正停在提示符上等输入：后台事件（长期摘要 fold 完成等）此时打印，
  // 先清掉提示行再输出、最后重绘提示符，避免糊成 "你> 🗜️ ..."
  let atPrompt = false;
  printAsyncEvent = (msg) => {
    if (!atPrompt || !process.stdout.isTTY) {
      console.log(msg);
      return;
    }
    process.stdout.write("\r\x1b[K");
    console.log(msg);
    rl.prompt();
  };
  // /prompt 选中的模板：保留到手动清除，之后每轮都以独立消息注入（正文不靠历史重放）；
  // 命令路由器经 templateRef 同步载入/清除，每轮 run 前由这里重设到 agent
  const templateRef: { current: PromptTemplateInjection | undefined } = { current: undefined };
  // 续聊时把历史打到终端：内容一直在文件里也进了模型上下文，不回放会让人以为对话丢了；
  // 空回答（取消/上游过滤）也要占位并写明原因
  const loaded = await store.load();
  const replay = formatHistoryReplay(loaded.messages);
  if (replay.length > 0) {
    console.log("📜 续聊上下文（已载入模型）：");
    for (const line of replay) console.log(`  ${line}`);
  }
  // 续聊时把上次选定的模板接回来；落盘记录本来就是 {role, text} 形态，直接还原，不做 content 伪装
  const restored = loaded.promptTemplate;
  if (restored) {
    templateRef.current = {
      label: restored.label,
      messages: restored.messages as PromptTemplateInjection["messages"],
    };
    agent.setPromptTemplate(templateRef.current);
    console.log(`📌 接着用上次选定的模板 ${restored.label}（输入 /prompt 清除）`);
  }

  // readline 处于 raw 模式时 Ctrl+C 不产生进程信号，只在接口上发 SIGINT 事件，
  // 所以取消逻辑要同时挂接口事件与进程信号两处
  const onSigint = () => {
    if (activeController) {
      console.log("\n⏹️  正在取消当前任务...");
      activeController.abort();
    } else {
      exitRequested = true;
      rl.close(); // 让挂起的 rl.question 以异常结束，主循环据此退出
    }
  };
  rl.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);

  console.log("💬 交互模式：每行输入一个任务；/help 查看全部命令（/model /prompts /prompt /rewind /task* /tokens /image）；exit / quit / Ctrl+C 退出。");
  try {
    while (!exitRequested) {
      atPrompt = true;
      const line = await lines.next(pendingImages.length > 0 ? `你[+${pendingImages.length}图]> ` : "你> ");
      atPrompt = false;
      if (line === null) break; // 流结束（EOF）

      const input = line.trim();
      if (!input) continue;
      if (["exit", "quit", "/exit", "/quit", "q"].includes(input.toLowerCase())) break;

      // /image：REPL 专属，把本地图片挂到下一轮消息。斜杠命令走不了图片，所以在这里拦。
      if (isImageCommand(input)) {
        const arg = input.replace(/^\/image\b/, "").trim();
        if (arg === "" || arg === "list") {
          console.log(pendingImages.length === 0
            ? `📎 还没有待发送的图片。用法：/image <图片路径> [更多路径...]（一次最多 ${MAX_IMAGES_PER_REQUEST} 张），下一轮输入时随消息发送。`
            : `📎 待发送 ${pendingImages.length} 张：${formatPendingImages(pendingImages)}。直接输入问题即可带走；/image clear 清空。`);
          continue;
        }
        if (arg === "clear") {
          pendingImages = [];
          console.log("📎 已清空待发送图片。");
          continue;
        }
        try {
          const uploads = await readLocalImageFiles(splitCommandArgs(arg));
          if (uploads.length === 0) {
            console.log("⚠️ 没有有效的图片路径。用法：/image <图片路径> [更多路径...]");
            continue;
          }
          // 与已有待发送图片合并后整体校验（张数/单张/总量）
          pendingImages = prepareUserImages([...pendingImages, ...uploads]);
          console.log(`📎 已加入 ${uploads.length} 张（共 ${pendingImages.length} 张待发送）：${formatPendingImages(pendingImages)}。`);
          if (!visionCapable) console.log("⚠️ 当前模型的图片通道已关闭（AGENT_VISION=0），这轮不会发送像素。");
          else console.log("直接输入问题即可带上这些图片。");
        } catch (error) {
          console.log(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      // 斜杠命令：REPL 与 Web 走同一条路由（命令不进 LLM、不落会话文件、
      // /task* 仍交回主循环走 Agent 内部拦截）
      const cmdOutcome = await handleSlashCommand(input, {
        agent,
        store,
        mcp,
        checkpoints,
        ask: (question) => lines.next(question),
        lastRunStats: () => lastStats,
        templateRef,
      });
      if (cmdOutcome.kind === "handled") {
        for (const line of cmdOutcome.lines) console.log(line);
        continue;
      }

      // 普通输入：模板走独立注入通道，本轮跑完即止；不再拼进用户输入
      agent.setPromptTemplate(templateRef.current);
      // 图片随这一轮带走：即使回合失败也不留着，误发旧图的代价比重新 /image 高
      const turnImages = pendingImages;
      pendingImages = [];
      const controller = new AbortController();
      activeController = controller;
      try {
        const result = await runTurn(agent, input, controller.signal, ui, {
          requestHuman: (prompt, signal) => lines.next(prompt, signal),
          askUser: (prompt, signal) => lines.next(prompt, signal),
          nameSession,
          requestBudgetExtension: async (request) => {
            const answer = await lines.next(
              `\n⚠️ ${formatBudgetExtensionPrompt(request)} [y/N] `,
              controller.signal
            );
            const approved = acceptedBudgetExtension(answer);
            console.log(approved
              ? "💰 已追加运行预算，本轮继续。"
              : "⏹️  未追加预算，本轮按预算上限收尾。");
            return approved;
          },
        }, turnImages);
        // 上一回合用量摘要（/tokens 用）：模型取当前值（回合中途没切过就是本回合模型）
        lastStats = {
          totalTokens: result.totalTokens,
          ...(result.cachedPromptTokens ? { cachedPromptTokens: result.cachedPromptTokens } : {}),
          toolCallsCount: result.toolCallsCount,
          iterations: result.steps.length,
          model: agent.model,
          stopReason: result.stopReason,
        };
      } catch (error) {
        console.error(`\n❌ 本回合失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        activeController = null;
        agent.setPromptTemplate(undefined);
      }
    }
    console.log("👋 再见。");
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
    // 中止并等在飞的后台记忆更新收尾：quit 立即退出，进程不吊在未完成的请求上
    if (await agent.shutdown()) {
      console.log("⏹️ 长期摘要更新未完成即退出，已跳过（对话轮已落盘，续聊不受影响）。");
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** AGENT_MODEL_PROBE=0/false/off/no 关闭对话开始的模型可用性探测（默认开启） */
function modelProbeEnabled(): boolean {
  return !["0", "false", "off", "no"].includes((process.env.AGENT_MODEL_PROBE ?? "").trim().toLowerCase());
}

async function main() {
  const config = loadAgentConfig();
  console.log(
    `⚙️  模型: ${config.model} · 摘要模型: ${config.summaryModel} · 迭代上限: ${config.maxIterations > 0 ? config.maxIterations : "不限"} · 流式: ${config.stream ? "开" : "关"}`
  );

  // 0-3. 技能发现 → 沙箱解析 → 工具注册表 → MCP 挂载 → 资源上下文：
  //      与 Web UI 服务器共用同一装配点（src/bootstrap.ts），两条入口的差别只剩
  //      Confirmer（终端逐个询问 vs UI 审批桥）与日志前缀
  const stack = await createAgentStack({ confirmer: createCliConfirmer(), config });
  const { skills, registry: tools, planStore, memoryStore, memoryRecall, memoryWriter, mcp, untrustedContext } = stack;
  // 提示词里的文件操作分工按实际挂载情况生成：server 下线时不再提不存在的工具
  const filesystemTools = tools.list().map((def) => def.name).filter((name) => name.startsWith("filesystem__"));

  try {
    // 4. 多轮会话：先问续聊哪个（回车默认新会话），历史落盘到 .agent-sessions/<sessionId>.jsonl，重启进程后仍带着上文继续
    const session = await chooseSession(resolveSessionDir());
    console.log(`📂 会话历史: ${session.store.filePath}`);

    // 启动快照（只读一次，供三处使用）：
    // - 模型按会话记录恢复（/model 切过就沿用，新会话没有记录则用配置默认值）
    // - 会话名续聊时直接显示
    // - messages 为空说明这是"第一轮"，本轮问答结束后生成会话名
    const startup = await session.store.load();
    if (startup.model !== undefined && startup.model !== config.model) {
      console.log(`🧠 会话模型: ${startup.model}（来自本会话记录，可用 /model 切换）`);
    }
    if (startup.sessionName !== undefined) {
      console.log(`🏷️  会话名: ${startup.sessionName}`);
    }
    const nameSession = createSessionNamer(session.store, startup.messages.length === 0);

    // 回合级检查点（/rewind）：影子 git 仓库随会话目录存放（.agent-sessions 已 gitignore），
    // agent 的 onTurnStart 钩子在每轮 user 消息落盘之前拍快照；快照失败只告警，不阻塞回合
    const checkpoints = config.checkpointsEnabled
      ? new CheckpointStore({
          shadowRoot: path.join(path.dirname(session.store.filePath), "checkpoints", session.sessionId),
          sandboxRoot: MCP_SANDBOX_DIR,
          sessionRecordCount: () => session.store.recordCount(),
        })
      : undefined;
    if (checkpoints) {
      console.log("⏪ 回滚检查点: 开启（每轮开始前自动快照工作区；/rewind 回滚）");
    }
    if (config.requireHostAcceptanceCriteria) {
      console.log("🔒 验收口径: 只采信宿主设定的条件；模型自设条件即使实测全部通过，也只记「已回答，未验收」");
    }
    if (config.thinkingEffort !== "default") {
      console.log(`🧠 思考程度: ${config.thinkingEffort}（AGENT_THINKING_EFFORT，按当前模型映射厂商参数）`);
    }
    if (!config.visionCapable) {
      console.log("视觉输入: 关（AGENT_VISION）——read_image 不提供图片通道");
    }

    // 流式增量实时输出由 token 事件驱动；runTurn 依据 streamState 补换行、避免与最终回答重复打印
    const streamState = { active: false };
    const ui: TurnUi = { stream: config.stream, streamState };
    // 5. 工具就绪后再初始化 Agent（模型/预算/迭代数来自配置层，工具集为入口组装的实例）
    const agent = new Agent({
      model: startup.model ?? config.model,
      systemPrompt: buildSystemPrompt(MCP_SANDBOX_DIR, skills, {
        filesystemTools,
        visionCapable: config.visionCapable,
        // 会话创建时快照一次，之后随 systemPrompt 固定——会话内稳定，不破坏前缀缓存
        env: snapshotEnv(MCP_SANDBOX_DIR),
      }),
      maxIterations: config.maxIterations,
      temperature: config.temperature,
      thinkingEffort: config.thinkingEffort,
      toolSearch: config.toolSearch,
      visionCapable: config.visionCapable,
      maxHistoryTurns: config.maxHistoryTurns,
      sessionStore: session.store,
      verificationRoot: stack.sandboxRoot,
      requireHostAcceptanceCriteria: config.requireHostAcceptanceCriteria,
      summaryModel: config.summaryModel,
      // 外部资源走「不可信数据」通道；用户在 REPL 里 /prompt 选中的模板走 promptTemplate 通道
      ...(untrustedContext ? { untrustedContext } : {}),
      budget: config.budget,
      tools,
      planStore,
      memoryStore,
      memoryRecall,
      memoryWriter,
      stream: config.stream,
      // 回合级检查点快照钩子与 Web 服务器共用同一份工厂（checkpoint_store.ts）
      ...(checkpoints ? { onTurnStart: createCheckpointSnapshotHook(checkpoints) } : {}),
    });

    // 6. 事件订阅：CLI 渲染与 trace 落盘是同一事件流的两个独立消费者
    const trace = new TraceRecorder(
      process.env.AGENT_TRACE_DIR ?? path.join(process.cwd(), ".traces"),
      session.sessionId
    );
    trace.attach(agent.events);
    console.log(`🧾 运行轨迹: ${trace.filePath}`);
    // 提示词指纹：行为变了先看这条，能立刻分清是改了规则还是换了模型/数据
    console.log(`🧬 system prompt 指纹: ${agent.systemPromptHash}`);

    agent.events.on("step", ({ step }) => printStep(step, !config.stream));
    agent.events.on("plan_update", ({ steps }) => {
      printAsyncEvent(formatPlanCli(steps));
    });
    agent.events.on("compact", (info) => {
      const parts: string[] = [info.action];
      if (info.messages !== undefined) parts.push(`${info.messages} 条`);
      if (info.tokens !== undefined) parts.push(`~${info.tokens} tokens`);
      if (info.detail) parts.push(info.detail);
      printAsyncEvent(`🗜️ [压缩] ${parts.join(" · ")}`);
    });
    agent.events.on("retry", (info) => {
      console.warn(`⚠️ [LLM] 第 ${info.attempt} 次重试（${info.delayMs}ms 后）: ${info.reason}`);
    });
    // 工具级实时状态：step 事件要等整轮工具结束才来，长脚本执行期间只有这里能看出进度
    agent.events.on("tool_start", ({ name, arguments: args }) => {
      printAsyncEvent(`🛠️ ▶ ${name} 开始执行: ${clipConsole(args, 160)}`);
    });
    agent.events.on("tool_progress", ({ name, elapsedMs }) => {
      printAsyncEvent(`⏳ ${name} 执行中… ${formatElapsed(elapsedMs)}`);
    });
    agent.events.on("tool_end", ({ name, durationMs, ok }) => {
      printAsyncEvent(`${ok ? "✅" : "❌"} ${name} ${ok ? "完成" : "失败"}，耗时 ${formatElapsed(durationMs)}`);
    });
    if (config.stream) {
      agent.events.on("token", ({ delta }) => {
        streamState.active = true;
        process.stdout.write(delta);
      });
    }

    // 每次对话开始探一次模型可用性：清单里有 ≠ 能用（免费配额按模型计，403 到对话中途才炸）。
    // 探测失败或关闭（AGENT_MODEL_PROBE=0）只降级为不打横幅，不影响会话
    if (modelProbeEnabled()) {
      try {
        const probes = await probeModels({ models: candidateModels(config) });
        // 账户级配额（智谱直连才有）：函数内部按 base URL host 门控，其它服务商零开销
        const accountQuota = await fetchZhipuAccountQuota(
          process.env.OPENAI_BASE_URL?.trim() ?? "",
          process.env.OPENAI_API_KEY?.trim() ?? ""
        );
        const line = [formatModelProbeLine(probes), accountQuota ? `💰 ${accountQuota}` : undefined]
          .filter(Boolean)
          .join(" ｜ ");
        if (line) console.log(`🩺 ${line}`);
      } catch (error) {
        console.warn(`⚠️ 模型可用性探测失败（不影响会话）: ${error instanceof Error ? error.message : error}`);
      }
    }

    // 7. 终端进 REPL；管道进单次模式；AGENT_REPL=1 强制逐行 REPL（多回合脚本/测试用）
    //    单次模式不自动套用会话里选定的模板：CI/脚本场景要的是"只按我给的任务跑"
    if (process.stdin.isTTY || process.env.AGENT_REPL === "1") {
      await runRepl(agent, mcp, ui, session.store, nameSession, checkpoints, config.visionCapable);
    } else {
      await runOneShot(agent, mcp, ui, nameSession);
    }
  } finally {
    // 8. 无论成功、抛错还是被取消，都要收口 watcher 并回收子进程与长连接
    await stack.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
