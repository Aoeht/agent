// src/core/command_router.ts
/**
 * 斜杠命令共享路由器：REPL 与 Web 服务器走同一条认领链，三入口行为一致。
 * 纯认领-转发设计——各命令的解析与提示仍在各自的独立模块（model_command /
 * prompts/commands / rewind_command），本文件只做：认领顺序、Agent/会话文件的
 * 副作用胶水（切换落盘、模板注入）、忙时门控、统一输出收集。
 *
 * 关键语义：
 * - `/task*` 不在这里认领：它们由 Agent.runManaged 内部拦截（合成回复、零 LLM
 *   token、与正常回合一样产生 run_start/run_end 事件），路由器原样交回主循环；
 * - 未知 `/xxx` 在这里认领并提示（不再当普通文本喂给 LLM——错字命令悄悄进模型
 *   是真实发生过的浪费）；普通消息返回 not-a-command；
 * - 命令输出是一次性 UI 态：不落会话文件、不发 run 事件，与 REPL 终端打印同权。
 */
import type { Agent, PromptTemplateInjection } from "./agent";
import type { SessionStore } from "./session_store";
import type { CheckpointStore } from "./checkpoint_store";
import type { StopReason } from "./run_outcome";
import { STOP_REASON_LABELS } from "./run_outcome";
import { handleModelCommand } from "./model_command";
import { handleRewindCommand, isRewindCommand } from "./rewind_command";
import {
  handlePromptCommand,
  previewTemplate,
  toTemplateInjection,
  type PromptSource,
} from "../prompts/commands";

/** /tokens 展示的上一回合用量摘要（调用方从 AgentResult/run_end 里摘） */
export interface RunStatsSummary {
  totalTokens: number;
  cachedPromptTokens?: number;
  toolCallsCount: number;
  iterations: number;
  model: string;
  stopReason: StopReason;
}

export interface CommandRouterDeps {
  agent: Agent;
  store: SessionStore;
  /** 提示模板来源（McpClientManager 天然满足该接口） */
  mcp: PromptSource;
  /** 检查点未启用（AGENT_CHECKPOINTS=0 或初始化失败）时为 undefined */
  checkpoints?: CheckpointStore | undefined;
  /** REPL 交互通道（裸 /rewind 两步问答用）；Web 不传 → 只列清单并提示序号式用法 */
  ask?: (prompt: string) => Promise<string | null>;
  /** 上一回合用量摘要（/tokens 用）；无记录或调用方未提供时提示 */
  lastRunStats?: () => RunStatsSummary | undefined;
  /** 会话是否正忙（回合在跑或队列非空）：变更类命令忙时拒绝执行只回提示 */
  isBusy?: () => boolean;
  /** REPL 持有的模板状态（每轮 run 前重设、run 后清）；/prompt 载入与清除同步更新它 */
  templateRef?: { current: PromptTemplateInjection | undefined };
  /** 输出通道；缺省 console.log（REPL 行为不变） */
  out?: (line: string) => void;
}

export type CommandOutcome =
  | { kind: "not-a-command" }
  | { kind: "handled"; lines: string[]; /** 执行了回滚时提示调用方刷新历史显示 */ refresh?: "history" };

/** 命令通道是否认领该输入（一切以 / 开头的文本）。供会话命名跳过等处共用。 */
export function isCommandText(text: string): boolean {
  return text.trimStart().startsWith("/");
}

const HELP_LINES = [
  "可用命令：",
  "  /model [名称]           查看/切换模型（写入本会话，续聊自动恢复）",
  "  /prompts                列出 MCP 提示模板",
  "  /prompt <serverId:name> [JSON参数]   选用模板；空 /prompt 清除",
  "  /rewind [编号] [c|t|a]  列出/回滚检查点（c=只代码 t=只对话 a=全部，缺省 a）",
  "  /task [status]          查看当前任务",
  "  /task new <目标>         开始独立任务",
  "  /task resolve <id|all> <applied|not_applied> <说明>   核对中断的操作",
  "  /tokens                 上一回合用量",
  "  /image <路径...>        附加本地图片到下一轮（仅 CLI；Web 用输入框的 📎 上传）",
  "  /help                   本清单",
  "普通消息直接输入即可。",
];

/** 处理斜杠命令；返回 not-a-command 时调用方按普通消息继续主流程 */
export async function handleSlashCommand(text: string, deps: CommandRouterDeps): Promise<CommandOutcome> {
  if (!isCommandText(text)) return { kind: "not-a-command" };
  const input = text.trim();
  const lines: string[] = [];
  const collect = (line: string) => { lines.push(line); };

  // /task* 由 Agent.runManaged 内部拦截（合成回复 + 事件齐全），路由器放行
  if (
    input === "/task" ||
    input === "/task status" ||
    input.startsWith("/task resolve") ||
    input.startsWith("/task new")
  ) {
    return { kind: "not-a-command" };
  }

  try {
    // /model：查看随时可用；切换是变更操作，忙时拒绝
    if (input === "/model" || input.startsWith("/model ")) {
      if (deps.isBusy?.() && input !== "/model") {
        return { kind: "handled", lines: ["⏳ 回合进行中，等当前回合结束后再切换模型。"] };
      }
      const result = await handleModelCommand(
        input,
        {
          currentModel: () => deps.agent.model,
          switchModel: async (model) => {
            deps.agent.setModel(model);
            await deps.store.recordModel(deps.agent.model);
          },
        },
        collect,
      );
      if (result.kind === "handled") return { kind: "handled", lines };
    }

    // /prompts 列表只读随时可用；/prompt 载入/清除改写会话文件，忙时拒绝
    if (input.startsWith("/prompt")) {
      const readOnly = input === "/prompts" || input.startsWith("/prompts ");
      if (deps.isBusy?.() && !readOnly) {
        return { kind: "handled", lines: ["⏳ 回合进行中，结束后再更换模板。"] };
      }
      const cmd = await handlePromptCommand(input, deps.mcp, collect);
      if (cmd.kind === "inject") {
        const converted = toTemplateInjection(cmd);
        if (!converted) {
          // 含图片/资源块的模板在本框架里落不了位（注入链只处理文本，落盘也只能存 JSON 文本）；
          // 宁可明说不可用，也不"悄悄少一条 system 约束"或存一份恢复不了的模板
          lines.push("⚠️ 该模板含非文本消息块，当前注入链只支持文本，未选用。");
          return { kind: "handled", lines };
        }
        if (deps.templateRef) deps.templateRef.current = converted;
        // 记进会话文件：历史里能查到"哪一轮换了哪个模板"，重启/重开时能读回来
        deps.agent.setPromptTemplate(converted);
        await deps.store.recordPromptTemplate(converted);
        lines.push(`📌 模板 ${cmd.label} 已载入，后续每轮都以独立消息注入（正文不靠历史重放）；输入 /prompt 清除。`);
        lines.push(`   预览：${previewTemplate(cmd.text)}`);
        return { kind: "handled", lines };
      }
      if (cmd.kind === "handled") {
        // 空 /prompt 是"清除"：立即同步到 agent 与会话文件，避免紧接着那一轮还带着已撤销的模板
        if (input === "/prompt") {
          if (deps.templateRef) deps.templateRef.current = undefined;
          deps.agent.setPromptTemplate(undefined);
          await deps.store.recordPromptTemplate(undefined);
        }
        return { kind: "handled", lines };
      }
      // 形如 /promptfoo 的未知斜杠命令：落到底部统一提示
    }

    // /rewind：变更操作（截断会话文件 + 覆写工作区），忙时绝对拒绝
    if (isRewindCommand(input)) {
      if (deps.isBusy?.()) {
        return { kind: "handled", lines: ["⏳ 回合进行中，结束后再回滚。"] };
      }
      const result = await handleRewindCommand(input, {
        checkpoints: deps.checkpoints,
        sessionStore: deps.store,
        ...(deps.ask ? { ask: deps.ask } : {}),
        settlePending: async () => { await deps.agent.flushSummary(); },
        out: collect,
      });
      if (result.consumed) {
        return { kind: "handled", lines, ...(result.executed ? { refresh: "history" as const } : {}) };
      }
    }

    if (input === "/help" || input === "/?") {
      return { kind: "handled", lines: [...HELP_LINES] };
    }

    if (input === "/tokens" || input.startsWith("/tokens ")) {
      const stats = deps.lastRunStats?.();
      if (!stats) {
        lines.push("（本会话还没有已完成的回合：跑完一轮再来，或等当前回合结束）");
        return { kind: "handled", lines };
      }
      lines.push(`💰 上一回合（${stats.model} · ${STOP_REASON_LABELS[stats.stopReason]}）：`);
      lines.push(`  ${stats.totalTokens} tokens · 🔧 ${stats.toolCallsCount} 次工具调用 · ${stats.iterations} 轮迭代`);
      if (stats.cachedPromptTokens !== undefined) {
        lines.push(`  ⚡ 前缀缓存命中 ${stats.cachedPromptTokens} tokens`);
      }
      return { kind: "handled", lines };
    }

    // 未知斜杠命令：拦截并提示，不再当普通文本喂给 LLM
    const firstToken = input.split(/\s+/)[0] ?? input;
    lines.push(`⌨️ 未知命令 ${firstToken}`);
    // /image 只在 REPL 认领（要读本机文件）；Web 端走附件按钮，这里给一句明确指引
    lines.push(firstToken === "/image"
      ? "Web 端请用输入框左侧的 📎 按钮上传图片（支持粘贴与拖入）。"
      : "输入 /help 查看可用命令。");
    return { kind: "handled", lines };
  } catch (error) {
    lines.push(`❌ 命令执行失败: ${error instanceof Error ? error.message : String(error)}`);
    return { kind: "handled", lines };
  }
}
