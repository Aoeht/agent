// src/prompts/commands.ts
// REPL 的 prompt 消费入口（接法 A）：把「/prompts 列表」与「/prompt 取模板」解析成一个纯 dispatcher。
// 不持有 REPL 循环、不碰 Agent —— src/index.ts 的 runRepl 只需几行 glue 调用它。
//
// 设计要点：
// - PromptSource 是结构化接口，真实 McpClientManager 天然满足（见文件末尾编译期断言），
//   所以换/加 server 模板无需改这里：清单来自 listPrompts()，动态发现。
// - 返回三态：not-a-command（交回主循环）/ handled（已打印，不跑回合）/
//   inject（取到模板：text 供预览，messages 保留 role 交调用方分层注入，label 是出处）。
import type { McpGetPromptResult, McpPromptInfo, McpPromptMessage } from "../mcp/types";
import type { McpClientManager } from "../mcp/client_manager";
import type { PromptTemplateInjection } from "../core/agent";

/** handlePromptCommand 依赖的最小能力面；McpClientManager 已实现 */
export interface PromptSource {
  listPrompts(serverId?: string): Promise<McpPromptInfo[]>;
  getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>
  ): Promise<McpGetPromptResult>;
}

export type PromptCommandResult =
  | { kind: "not-a-command" }
  | { kind: "handled" }
  | {
      kind: "inject";
      /** 压平后的纯文本，供预览与确认提示使用 */
      text: string;
      /** 保留原始 role 的消息序列：system 角色的模板约束必须留在 System 层 */
      messages: McpPromptMessage[];
      /** 出处，如 "local_prompts:anti_fraud_review"，用于审计与围栏标注 */
      label: string;
    };

const LIST_CMD = "/prompts";
const GET_CMD = "/prompt";

export async function handlePromptCommand(
  line: string,
  mcp: PromptSource,
  out: (s: string) => void = (s) => console.log(s)
): Promise<PromptCommandResult> {
  const input = line.trim();
  // 只认领 /prompt 前缀；其它（含 /exit、普通问题）原样交回主循环
  if (!input.startsWith(GET_CMD)) return { kind: "not-a-command" };

  if (input === LIST_CMD || input.startsWith(LIST_CMD + " ")) return listPrompts(mcp, out);
  if (input === GET_CMD || input.startsWith(GET_CMD + " ")) {
    return selectPrompt(input.slice(GET_CMD.length).trim(), mcp, out);
  }
  // 形如 /promptfoo 的未知斜杠命令，交回主循环
  return { kind: "not-a-command" };
}

async function listPrompts(
  mcp: PromptSource,
  out: (s: string) => void
): Promise<PromptCommandResult> {
  let prompts: McpPromptInfo[];
  try {
    prompts = await mcp.listPrompts();
  } catch (error) {
    out(`❌ 列出模板失败: ${errMsg(error)}`);
    return { kind: "handled" };
  }

  if (prompts.length === 0) {
    out("（当前没有 server 暴露 prompts 模板）");
    return { kind: "handled" };
  }

  out("可用提示模板（* 为必填参数）：");
  for (const p of prompts) {
    const args = (p.arguments ?? []).map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ");
    const desc = p.description ? ` — ${p.description}` : "";
    const argHint = args ? ` [参数: ${args}]` : "";
    out(`  - ${p.serverId}:${p.name}${desc}${argHint}`);
  }
  out(`用法: ${GET_CMD} <serverId:name> [JSON参数]   例: ${GET_CMD} local_prompts:review {"text":"..."}`);
  return { kind: "handled" };
}

async function selectPrompt(
  rest: string,
  mcp: PromptSource,
  out: (s: string) => void
): Promise<PromptCommandResult> {
  if (rest === "") {
    out("已清除待注入模板。");
    return { kind: "handled" };
  }

  // 第一个空格前是 <serverId>:<name>，其后整体是 JSON 参数
  const space = rest.indexOf(" ");
  const ref = space === -1 ? rest : rest.slice(0, space);
  const argsStr = space === -1 ? "" : rest.slice(space + 1).trim();

  const colon = ref.indexOf(":");
  if (colon <= 0 || colon === ref.length - 1) {
    out(`❌ 模板标识格式应为 <serverId>:<name>，收到: "${ref}"`);
    return { kind: "handled" };
  }
  const serverId = ref.slice(0, colon);
  const name = ref.slice(colon + 1);

  let args: Record<string, string> | undefined;
  if (argsStr !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsStr);
    } catch (error) {
      out(`❌ 参数不是合法 JSON: ${errMsg(error)}`);
      return { kind: "handled" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      out(`❌ 参数 JSON 必须是对象，如 {"text":"..."}，收到: ${argsStr}`);
      return { kind: "handled" };
    }
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") {
        out(`❌ 参数 "${key}" 必须是字符串（prompts/get 只接受 string 值）`);
        return { kind: "handled" };
      }
      record[key] = value;
    }
    args = record;
  }

  let result: McpGetPromptResult;
  try {
    result = args ? await mcp.getPrompt(serverId, name, args) : await mcp.getPrompt(serverId, name);
  } catch (error) {
    out(`❌ 取模板失败: ${errMsg(error)}`);
    return { kind: "handled" };
  }

  const text = formatPromptMessages(result.messages);
  if (text.trim() === "") {
    out("⚠️ 模板渲染结果为空，未注入。");
    return { kind: "handled" };
  }
  // role 原样带上：注入方按 role 分层，而不是把所有消息压成一条 user 文本
  return { kind: "inject", text, messages: result.messages, label: `${serverId}:${name}` };
}

/**
 * 模板消息 → 纯文本。只用于预览与确认提示；真正注入上下文时要用原始 messages，
 * 否则 system 角色的模板约束会被压平成 user 文本、丢掉层级语义。
 */
export function formatPromptMessages(messages: McpPromptMessage[]): string {
  const lines = messages.map((message) => {
    const body =
      message.content.type === "text"
        ? message.content.text
        : nonTextPlaceholder(message.content.type);
    // 多消息模板带上角色标记，人读预览时能看出哪条是 system 约束
    return messages.length > 1 ? `[${message.role}] ${body}` : body;
  });
  return lines.join("\n");
}

/** 非文本块（图片/资源）留占位，避免 base64 灌进上下文 */
function nonTextPlaceholder(type: string): string {
  return `[非文本内容: ${type}]`;
}

/**
 * inject 结果 → Agent 的模板注入结构：只取文本内容，role 原样带上；含非文本块时返回 undefined。
 * 共享给命令路由器（REPL 与 Web 同一条语义），不再留在入口文件里。
 */
export function toTemplateInjection(cmd: {
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

/** 单行预览：模板可能很长，终端/聊天里只给一眼能看清的开头 */
export function previewTemplate(text: string, maxChars = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 编译期断言：真实 McpClientManager 可赋给 PromptSource —— 证明 index.ts 里 handlePromptCommand(line, mcp) 类型通过。
// 若不兼容，下面这行会因 never 而编译失败。
type McpSatisfiesPromptSource = McpClientManager extends PromptSource ? true : never;
export const _assertMcpCompatible: McpSatisfiesPromptSource = true;
