// src/mcp/resource_commands.ts
// resources 的消费入口：把「/resources 列表」与「/resource 读取」解析成一个纯 dispatcher，
// 与 prompts/commands.ts 同一模式——不持有 REPL 循环、不碰 Agent。
//
// 设计要点：
// - 启动时 collectCapabilitiesContext 只挑一段文本塞进上下文，模型和人都不能按需浏览；
//   这里补的是按需入口：先看清单，再挑一条读到预览，钉进下一轮作为不可信参考资料。
// - 资源是数据不是指令，钉住后走 untrustedContext 同一围栏（wrapUntrustedData），
//   与 /prompt 选定的模板（指令通道）严格分开。
// - 读取前仍走 McpClientManager.readResource → adapter 的 file:// 路径守卫，
//   这里不重复实现白名单。
import type { McpResourceContent, McpResourceInfo } from "./types";
import type { McpClientManager } from "./client_manager";

/** handleResourceCommand 依赖的最小能力面；McpClientManager 已实现 */
export interface ResourceSource {
  listResources(serverId?: string): Promise<McpResourceInfo[]>;
  readResource(serverId: string, uri: string): Promise<McpResourceContent[]>;
}

export type ResourceCommandResult =
  | { kind: "not-a-command" }
  | { kind: "handled" }
  | {
      kind: "inject";
      /** 已拼好出处的正文，交给 Agent 套不可信数据围栏 */
      text: string;
      /** 出处，如 "local:notes（file:///...）" */
      label: string;
      /** 单行预览，供确认提示使用 */
      preview: string;
      /** 实际注入的字符数（截断后） */
      chars: number;
    };

const LIST_CMD = "/resources";
const READ_CMD = "/resource";
/** 单次注入上限：与启动注入的 8k 一致，避免一条大资源把上下文吃掉 */
const MAX_INJECT_CHARS = 8_000;
const PREVIEW_CHARS = 160;

/** 命令通道是否认领该输入（/resources 与 /resource 是两条语义） */
export function isResourceCommand(input: string): boolean {
  return (
    input === LIST_CMD ||
    input.startsWith(LIST_CMD + " ") ||
    input === READ_CMD ||
    input.startsWith(READ_CMD + " ")
  );
}

export async function handleResourceCommand(
  line: string,
  mcp: ResourceSource,
  out: (s: string) => void = (s) => console.log(s)
): Promise<ResourceCommandResult> {
  const input = line.trim();
  // 先认 /resources（列表），再认 /resource（读取/清除）；其余原样交回
  if (input === LIST_CMD || input.startsWith(LIST_CMD + " ")) {
    return listResources(input.slice(LIST_CMD.length).trim(), mcp, out);
  }
  if (input === READ_CMD || input.startsWith(READ_CMD + " ")) {
    return selectResource(input.slice(READ_CMD.length).trim(), mcp, out);
  }
  return { kind: "not-a-command" };
}

async function listResources(
  serverId: string,
  mcp: ResourceSource,
  out: (s: string) => void
): Promise<ResourceCommandResult> {
  let resources: McpResourceInfo[];
  try {
    resources = await mcp.listResources(serverId === "" ? undefined : serverId);
  } catch (error) {
    out(`❌ 列出资源失败: ${errMsg(error)}`);
    return { kind: "handled" };
  }

  if (resources.length === 0) {
    out(serverId === "" ? "（当前没有 server 暴露 resources）" : `（Server "${serverId}" 没有资源）`);
    return { kind: "handled" };
  }

  out("可用资源：");
  for (const resource of resources) {
    const mime = resource.mimeType ? ` [${resource.mimeType}]` : "";
    const desc = resource.description ? ` — ${resource.description}` : "";
    out(`  - ${resource.serverId}:${resource.name} · ${resource.uri}${mime}${desc}`);
  }
  out(`用法: ${READ_CMD} <serverId:name|uri>   读取并钉到下一轮；${READ_CMD} 清除`);
  return { kind: "handled" };
}

async function selectResource(
  rest: string,
  mcp: ResourceSource,
  out: (s: string) => void
): Promise<ResourceCommandResult> {
  if (rest === "") {
    out("已清除待注入资源。");
    return { kind: "handled" };
  }

  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) {
    out(`❌ 资源标识格式应为 <serverId:name|uri>，收到: "${rest}"`);
    return { kind: "handled" };
  }
  const serverId = rest.slice(0, colon);
  const ref = rest.slice(colon + 1);

  let resources: McpResourceInfo[];
  try {
    resources = await mcp.listResources(serverId);
  } catch (error) {
    out(`❌ 列出资源失败: ${errMsg(error)}`);
    return { kind: "handled" };
  }

  const picked = resources.find((resource) => resource.uri === ref || resource.name === ref);
  if (picked === undefined) {
    out(`❌ Server "${serverId}" 下没有名为 "${ref}" 的资源或该 uri。可用资源：`);
    for (const resource of resources) out(`  - ${resource.name} · ${resource.uri}`);
    return { kind: "handled" };
  }

  let contents: McpResourceContent[];
  try {
    contents = await mcp.readResource(serverId, picked.uri);
  } catch (error) {
    out(`❌ 读取资源失败: ${errMsg(error)}`);
    return { kind: "handled" };
  }

  // 只注入文本块：二进制/base64 灌进上下文既烧 token 也没用
  const textParts: string[] = [];
  let binaryBytes = 0;
  let truncated = false;
  let used = 0;
  for (const content of contents) {
    if (!("text" in content)) {
      binaryBytes += Buffer.from(content.blob, "base64").byteLength;
      continue;
    }
    let text = content.text;
    if (used + text.length > MAX_INJECT_CHARS) {
      text = text.slice(0, Math.max(0, MAX_INJECT_CHARS - used));
      truncated = true;
    }
    if (text !== "") {
      textParts.push(text);
      used += text.length;
    }
    if (truncated) break;
  }

  if (textParts.length === 0) {
    out(binaryBytes > 0
      ? `⚠️ 该资源只有二进制内容（${formatBytes(binaryBytes)}），无法注入为文本。`
      : "⚠️ 资源读取结果为空，未注入。");
    return { kind: "handled" };
  }

  const header = `### ${picked.serverId}:${picked.name}（${picked.uri}）`;
  const notes: string[] = [];
  if (truncated) notes.push(`内容超过 ${MAX_INJECT_CHARS} 字符，已截断`);
  if (binaryBytes > 0) notes.push(`另有二进制内容 ${formatBytes(binaryBytes)} 未注入`);
  const suffix = notes.length > 0 ? `\n\n（${notes.join("；")}）` : "";
  const text = `${header}\n${textParts.join("\n")}${suffix}`;

  return {
    kind: "inject",
    text,
    label: `${picked.serverId}:${picked.name}（${picked.uri}）`,
    preview: previewText(textParts.join(" ")),
    chars: text.length,
  };
}

function previewText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS)}…` : collapsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 编译期断言：真实 McpClientManager 可赋给 ResourceSource
type McpSatisfiesResourceSource = McpClientManager extends ResourceSource ? true : never;
export const _assertMcpCompatible: McpSatisfiesResourceSource = true;
