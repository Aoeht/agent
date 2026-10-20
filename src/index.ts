// src/index.ts
import { Agent, PromptTemplateInjection } from "./core/agent";
import { formatPlanCli } from "./core/plan_store";
import type { McpClientManager } from "./mcp/client_manager";
import { MCP_SANDBOX_DIR } from "./mcp/config";
import { createCliConfirmer } from "./mcp/cli_confirmer";
import { McpPromptMessage } from "./mcp/types";
import path from "node:path";
import readline from "node:readline/promises";
import { SessionStore } from "./core/session_store";
import { newSession, pickSession, PickedSession } from "./core/session_picker";
import { loadAgentConfig } from "./config";
import { createAgentStack } from "./bootstrap";
import { buildSystemPrompt } from "./prompts/system";
import { handlePromptCommand } from "./prompts/commands";
import { handleModelCommand } from "./core/model_command";
import { TraceRecorder } from "./core/trace";
import { CheckpointStore } from "./core/checkpoint_store";
import { handleRewindCommand } from "./core/rewind_command";
import { AgentResult, StepInfo, ToolRuntime } from "./core/types";

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

function printStep(step: StepInfo, includeContent: boolean): void {
  console.log(`\n============== [迭代 ${step.iteration}] ==============`);
  console.log(`💰 本步消耗 Token: ${step.tokens.totalTokens}`);
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
function createSessionNamer(store: SessionStore, hasHistory: boolean): SessionNamer {
  let pending = !hasHistory;
  return async (agent, userInput, result, signal) => {
    if (!pending) return;
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
async function runTurn(
  agent: Agent,
  input: string,
  signal: AbortSignal,
  ui: TurnUi,
  requestHuman?: ToolRuntime["requestHuman"],
  askUser?: ToolRuntime["askUser"],
  nameSession?: SessionNamer
): Promise<AgentResult> {
  ui.streamState.active = false;
  const result = await agent.run(input, {
    signal,
    ...(requestHuman ? { requestHuman } : {}),
    ...(askUser ? { askUser } : {}),
  });
  if (ui.streamState.active) process.stdout.write("\n");

  if (result.success) {
    if (!ui.stream) {
      console.log("\n📝 最终回答:");
      console.log(result.finalAnswer);
    }
    if (result.citations.length > 0) {
      console.log("\n📎 引用来源:");
      for (const c of result.citations) {
        console.log(`  [${c.index}] ${c.title}${c.url ? ` — ${c.url}` : ""}`);
      }
    }
    console.log(
      `\n---------------- 💰 ${result.totalTokens} tokens · 🔧 ${result.toolCallsCount} 次工具调用 ----------------`
    );
  } else {
    const reason = result.budgetStopped
      ? `运行预算越线（${result.budgetStopped}）`
      : signal.aborted
        ? "已被中断"
        : "未能得到最终答案";
    console.log(`\n⚠️ 本回合未完成: ${reason}`);
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
    const result = await runTurn(agent, input, controller.signal, ui, undefined, undefined, nameSession);
    // 后台记忆更新等它落地再退：一次性模式没有"下一轮"来收账，摘要写盘必须先于进程退出
    await agent.flushSummary();
    if (!result.success) process.exitCode = 1;
    console.log("🔌 MCP 状态:", mcp.getStatus());
  } finally {
    process.off("SIGINT", onSigint);
  }
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
  checkpoints?: CheckpointStore
): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 行队列必须在任何 await 之前挂上监听：'line' 事件没有监听者即丢，
  // 管道预缓冲的行会在下方 store.load() 的 await 窗口里被打空，REPL 空转退出
  const lines = new LineSource(rl);
  // 空闲时为 null；运行中持有当前回合的 controller，供 SIGINT 取消
  let activeController: AbortController | null = null;
  let exitRequested = false;
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
  // /prompt 选中的模板：保留到手动清除，之后每轮都以独立消息注入（正文不靠历史重放）
  let pendingPrompt: PromptTemplateInjection | undefined;
  // 续聊时把上次选定的模板接回来；落盘记录本来就是 {role, text} 形态，直接还原，不做 content 伪装
  const restored = (await store.load()).promptTemplate;
  if (restored) {
    pendingPrompt = {
      label: restored.label,
      messages: restored.messages as PromptTemplateInjection["messages"],
    };
    agent.setPromptTemplate(pendingPrompt);
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

  console.log("💬 交互模式：每行输入一个任务；/model 切换模型、/prompts 看模板、/prompt <id:name> [JSON] 选用（/prompt 清除）、/rewind 回滚到检查点；exit / quit / Ctrl+C 退出。");
  try {
    while (!exitRequested) {
      atPrompt = true;
      const line = await lines.next("你> ");
      atPrompt = false;
      if (line === null) break; // 流结束（EOF）

      const input = line.trim();
      if (!input) continue;
      if (["exit", "quit", "/exit", "/quit", "q"].includes(input.toLowerCase())) break;

      // 模型命令：/model 查看当前模型、/model <名称> 切换。切换同时落盘，续聊时自动恢复
      const modelCmd = await handleModelCommand(input, {
        currentModel: () => agent.model,
        switchModel: async (model) => {
          agent.setModel(model);
          await store.recordModel(agent.model);
        },
      });
      if (modelCmd.kind === "handled") continue;

      // prompt 命令：/prompts 列表、/prompt 取模板（保留待注入）、/prompt 空清除
      const cmd = await handlePromptCommand(input, mcp);
      if (cmd.kind === "inject") {
        const converted = toTemplateInjection(cmd);
        if (!converted) {
          // 含图片/资源块的模板在本框架里落不了位（注入链只处理文本，落盘也只能存 JSON 文本）；
          // 宁可明说不可用，也不"悄悄少一条 system 约束"或存一份恢复不了的模板
          console.log("⚠️ 该模板含非文本消息块，当前注入链只支持文本，未选用。");
          continue;
        }
        pendingPrompt = converted;
        // 记进会话文件：历史里能查到"哪一轮换了哪个模板"，重启续聊时能读回来
        await store.recordPromptTemplate(pendingPrompt);
        console.log(`📌 模板 ${cmd.label} 已载入，后续每轮都以独立消息注入（正文不靠历史重放）；输入 /prompt 清除。`);
        console.log(`   预览：${previewTemplate(cmd.text)}`);
        continue;
      }
      if (cmd.kind === "handled") {
        // 空 /prompt 是"清除"：立即同步到 agent 与会话文件，避免紧接着那一轮还带着已撤销的模板
        if (input === "/prompt") {
          pendingPrompt = undefined;
          agent.setPromptTemplate(undefined);
          await store.recordPromptTemplate(undefined);
        }
        continue;
      }

      // 回滚命令：/rewind 列出检查点，选一个恢复工作区代码和/或会话对话
      if (
        await handleRewindCommand(input, {
          checkpoints,
          sessionStore: store,
          ask: (question) => lines.next(question),
          settlePending: async () => {
            await agent.flushSummary();
          },
        })
      ) {
        continue;
      }

      // 普通输入：模板走独立注入通道，本轮跑完即止；不再拼进用户输入
      agent.setPromptTemplate(pendingPrompt);
      const controller = new AbortController();
      activeController = controller;
      try {
        await runTurn(agent, input, controller.signal, ui, (prompt, signal) => lines.next(prompt, signal), (prompt, signal) => lines.next(prompt, signal));
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

/** inject 结果 → Agent 的模板注入结构：只取文本内容，role 原样带上；含非文本块时返回 undefined */
function toTemplateInjection(cmd: {
  label: string;
  messages: McpPromptMessage[];
}): PromptTemplateInjection | undefined {
  const messages: PromptTemplateInjection["messages"] = [];
  for (const message of cmd.messages) {
    if (message.content.type !== "text") return undefined; // 图片/资源块进不了模板通道
    messages.push({ role: message.role, text: message.content.text });
  }
  return messages.length > 0 ? { label: cmd.label, messages } : undefined;
}

/** 单行预览：模板可能很长，终端里只给一眼能看清的开头 */
function previewTemplate(text: string, maxChars = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
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

async function main() {
  const config = loadAgentConfig();
  console.log(
    `⚙️  模型: ${config.model} · 摘要模型: ${config.summaryModel} · 迭代上限: ${config.maxIterations} · 流式: ${config.stream ? "开" : "关"}`
  );

  // 0-3. 技能发现 → 沙箱解析 → 工具注册表 → MCP 挂载 → 资源上下文：
  //      与 Web UI 服务器共用同一装配点（src/bootstrap.ts），两条入口的差别只剩
  //      Confirmer（终端逐个询问 vs UI 审批桥）与日志前缀
  const stack = await createAgentStack({ confirmer: createCliConfirmer(), config });
  const { skills, registry: tools, planStore, mcp, untrustedContext } = stack;

  try {
    // 4. 多轮会话：先问续聊哪个（回车默认新会话），历史落盘到 .agent-sessions/<sessionId>.jsonl，重启进程后仍带着上文继续
    const session = await chooseSession(
      process.env.AGENT_SESSION_DIR ?? path.join(process.cwd(), ".agent-sessions")
    );
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

    // 流式增量实时输出由 token 事件驱动；runTurn 依据 streamState 补换行、避免与最终回答重复打印
    const streamState = { active: false };
    const ui: TurnUi = { stream: config.stream, streamState };
    // 5. 工具就绪后再初始化 Agent（模型/预算/迭代数来自配置层，工具集为入口组装的实例）
    const agent = new Agent({
      model: startup.model ?? config.model,
      systemPrompt: buildSystemPrompt(MCP_SANDBOX_DIR, skills),
      maxIterations: config.maxIterations,
      temperature: config.temperature,
      maxHistoryTurns: config.maxHistoryTurns,
      sessionStore: session.store,
      summaryModel: config.summaryModel,
      // 外部资源走「不可信数据」通道；用户在 REPL 里 /prompt 选中的模板走 promptTemplate 通道
      ...(untrustedContext ? { untrustedContext } : {}),
      budget: config.budget,
      tools,
      planStore,
      stream: config.stream,
      ...(checkpoints
        ? {
            onTurnStart: async (userMessage: string) => {
              try {
                await checkpoints.snapshot(userMessage);
              } catch (error) {
                console.warn(`⚠️ [检查点] 快照失败（不影响本回合）: ${error instanceof Error ? error.message : error}`);
              }
            },
          }
        : {}),
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
    if (config.stream) {
      agent.events.on("token", ({ delta }) => {
        streamState.active = true;
        process.stdout.write(delta);
      });
    }

    // 7. 终端进 REPL；管道进单次模式；AGENT_REPL=1 强制逐行 REPL（多回合脚本/测试用）
    //    单次模式不自动套用会话里选定的模板：CI/脚本场景要的是"只按我给的任务跑"
    if (process.stdin.isTTY || process.env.AGENT_REPL === "1") {
      await runRepl(agent, mcp, ui, session.store, nameSession, checkpoints);
    } else {
      await runOneShot(agent, mcp, ui, nameSession);
    }
  } finally {
    // 8. 无论成功、抛错还是被取消，都要回收子进程与长连接
    await mcp.closeAll();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
