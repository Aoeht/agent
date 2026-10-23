// src/core/session_replay.ts
/**
 * 续聊回放：CLI 重启后把会话文件里的完整记录打到终端。
 *
 * 历史一直都在会话文件里、也一直会装进模型上下文；但终端不回放的话，
 * 用户看到的就是一个空屏，容易以为对话丢了。空回答（取消/上游内容过滤）
 * 同样要占一行并写明结束原因——那正是"对话为什么停在这里"的答案。
 *
 * 这里做的是"完整记录"：不按轮数截断、不截内容，连 ReAct 的工具调用过程
 * （随终答记录落盘的 process）一起显示，让人能看清这一轮到底干了什么。
 */
import type { Message, PersistedProcessStep } from "./types";
import { STOP_REASON_LABELS, type StopReason } from "./run_outcome";

interface PersistedOutcome {
  stopReason?: StopReason;
  errorMessage?: string;
}

type ReplayAssistantMessage = Message & {
  outcome?: PersistedOutcome;
  process?: PersistedProcessStep[];
};

function formatToolCall(call: { name: string; arguments: string }): string {
  const args = call.arguments.trim();
  return `[工具调用] ${call.name}(${args})`;
}

/** 返回可直接逐行打印的终端文本；没有可回放的对话时返回空数组 */
export function formatHistoryReplay(messages: Message[]): string[] {
  const lines: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string" && message.content.trim() !== "") {
        lines.push(`你> ${message.content}`);
      }
      continue;
    }
    if (message.role !== "assistant") continue;

    const assistant = message as ReplayAssistantMessage;
    for (const step of assistant.process ?? []) {
      const thought = typeof step.llmContent === "string" ? step.llmContent.trim() : "";
      if (thought !== "") lines.push(`助手> ${thought}`);
      for (const call of step.toolCalls) lines.push(`助手> ${formatToolCall(call)}`);
    }

    // 兼容直接落盘的 assistant(tool_calls) 记录（旧会话文件或未来的逐条写入）
    if (!assistant.process?.length && message.tool_calls?.length) {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (content !== "") lines.push(`助手> ${content}`);
      for (const call of message.tool_calls) {
        if ("function" in call) lines.push(`助手> ${formatToolCall(call.function)}`);
      }
      continue;
    }

    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (content !== "") {
      lines.push(`助手> ${content}`);
      continue;
    }
    const outcome = assistant.outcome;
    const label = outcome?.stopReason !== undefined && outcome.stopReason in STOP_REASON_LABELS
      ? STOP_REASON_LABELS[outcome.stopReason]
      : "没有保存回答";
    const detail = typeof outcome?.errorMessage === "string" && outcome.errorMessage !== ""
      ? `：${outcome.errorMessage}`
      : "";
    lines.push(`助手> （没有生成内容 · ${label}${detail}）`);
  }

  return lines;
}
