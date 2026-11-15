// src/a2a/client.ts
/**
 * A2A 出站客户端（评估文档路线图阶段 4）。
 *
 * 按评估文档 5.6 的务实判断，JSON-RPC 层很薄——手写 fetch + SSE 解析，不引入
 * @a2a-js/sdk 依赖：超时、重试、取消、URL 校验全部自己控制（这几样恰是本仓库
 * 已经做得很讲究的部分）。
 *
 * 安全纪律：
 * - Agent Card 是不可信输入：描述文本只会以"数据"的形式被上层使用（fence.ts 围栏），
 *   绝不拼进指令；接口地址要过 assertSafeAgentUrl——恶意名片把 url 指向内网是最
 *   直接的 SSRF 路径。
 * - 默认只允许 HTTPS；本地回环的 http 需 AGENT_A2A_ALLOW_HTTP=1 显式放行
 *   （互操作测试用，属于记录在案的偏离）。
 */
import { randomUUID } from "node:crypto";
import { A2aError, type AgentCard, type AgentInterface, type JsonRpcResponse, type Message, type Part, type StreamingResponse, type Task } from "./types";

export const A2A_VERSION = "1.0";

export interface A2aEndpoint {
  /** Agent 根地址（名片所在的 host），如 https://agents.example.com */
  baseUrl: string;
  /** 可选 Bearer（对端启用鉴权时） */
  token?: string;
  /** 请求死线（毫秒）；缺省 120s——阻塞式 SendMessage 可能合法地长，别设太短 */
  timeoutMs?: number;
}

export interface ResolvedAgent {
  card: AgentCard;
  /** 选定的 JSON-RPC 接口（supportedInterfaces 里第一个 JSONRPC 绑定） */
  interface: AgentInterface;
}

// ---------- URL 校验 ----------

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * 出站 URL 校验：HTTPS 是默认；**回环 http 默认放行**（本地联调是 A2A 生态的常态，
 * 官方样例全部跑 http://localhost，真正的门禁是对端白名单）；非回环 http 需
 * AGENT_A2A_ALLOW_HTTP=1 显式放行（内网 http 的互操作偏离，记录在案）。
 * 只挡协议，不做 DNS 级内网检测——v1 的对端来自显式配置（白名单构造），
 * 动态发现引入时再补 resolve+内网段检查（进阶篇 8.2 攻击路径②）。
 */
export function assertSafeAgentUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new A2aError(-32602, "INVALID_PARAMS", `Agent 地址不合法: ${raw}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  const allowHttp = process.env.AGENT_A2A_ALLOW_HTTP?.trim() === "1" || process.env.AGENT_A2A_ALLOW_HTTP?.trim().toLowerCase() === "true";
  if (url.protocol === "http:" && allowHttp) return url;
  throw new A2aError(
    -32602,
    "INVALID_PARAMS",
    `拒绝非 HTTPS 的 Agent 地址: ${raw}（A2A 默认仅允许 HTTPS；内网 http 联调设 AGENT_A2A_ALLOW_HTTP=1）`
  );
}

// ---------- 名片发现 ----------

/**
 * 拉取并校验 Agent Card：先 v0.3.0+ 路径 agent-card.json，回退老路径 agent.json
 * （兼容还没升级的对手方）。校验失败给可读错误——名片格式问题要在"选 Agent"这一步
 * 暴露，不能等到请求发出才发现对端不是 A2A。
 */
export async function fetchAgentCard(endpoint: A2aEndpoint): Promise<ResolvedAgent> {
  const base = assertSafeAgentUrl(endpoint.baseUrl.endsWith("/") ? endpoint.baseUrl : `${endpoint.baseUrl}/`);
  const paths = [".well-known/agent-card.json", ".well-known/agent.json"];
  let lastError: unknown;
  for (const tail of paths) {
    try {
      const response = await request(base, tail, endpoint, { method: "GET", accept: "application/json" });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const card = (await response.json()) as AgentCard;
      return { card, interface: pickJsonRpcInterface(card) };
    } catch (error) {
      lastError = error;
    }
  }
  throw new A2aError(-32602, "INVALID_PARAMS", `无法从 ${endpoint.baseUrl} 获取 Agent Card：${lastError instanceof Error ? lastError.message : lastError}`);
}

function pickJsonRpcInterface(card: AgentCard): AgentInterface {
  const jsonRpc = card.supportedInterfaces?.find((entry) => entry.protocolBinding === "JSONRPC");
  if (jsonRpc === undefined) {
    throw new A2aError(-32602, "INVALID_PARAMS", `Agent「${card.name}」未声明 JSONRPC 绑定`);
  }
  const major = /^(\d+)\./.exec(jsonRpc.protocolVersion)?.[1];
  if (major !== "1") {
    throw new A2aError(-32602, "INVALID_PARAMS", `Agent「${card.name}」的 JSONRPC 接口协议版本是 ${jsonRpc.protocolVersion}，本客户端只支持 1.x`);
  }
  return jsonRpc;
}

// ---------- 消息构造 ----------

export function textMessage(text: string, options?: { contextId?: string; taskId?: string }): Message {
  return {
    role: "ROLE_USER",
    messageId: randomUUID(),
    parts: [{ text }],
    ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
    ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
  };
}

export function partsMessage(parts: Part[], options?: { contextId?: string; taskId?: string }): Message {
  return {
    role: "ROLE_USER",
    messageId: randomUUID(),
    parts,
    ...(options?.contextId !== undefined ? { contextId: options.contextId } : {}),
    ...(options?.taskId !== undefined ? { taskId: options.taskId } : {}),
  };
}

// ---------- 操作 ----------

export interface SendOptions extends A2aEndpoint {
  contextId?: string;
  taskId?: string;
  returnImmediately?: boolean;
  /** 取消信号：触发时中断等待（注意语义是"本地放弃"，远端可能还在跑） */
  signal?: AbortSignal;
}

/** 阻塞发送（v1.0 缺省语义：等到终态）。返回终态 Task 或直返 Message。 */
export async function sendMessage(endpoint: SendOptions, message: Message): Promise<Task | Message> {
  const target = await rpcUrl(endpoint);
  const body = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "SendMessage",
    params: {
      message: { ...message, ...(endpoint.contextId !== undefined && message.contextId === undefined ? { contextId: endpoint.contextId } : {}) },
      ...(endpoint.returnImmediately === true ? { returnImmediately: true } : {}),
    },
  };
  const response = await postJson(target, body, endpoint, endpoint.signal);
  const result = unwrap(response);
  if (isTaskResult(result)) return result.task as Task;
  return (result as { message: Message }).message;
}

/**
 * 流式发送：逐个 yield 解析后的流事件（task / statusUpdate / artifactUpdate / message）。
 * v1.0 的流结束信号是**连接关闭**——reader.read() 返回 done 就是正常收尾，
 * 不存在也不应等待任何 final 字段。
 */
export async function* sendStreamingMessage(
  endpoint: SendOptions,
  message: Message,
  signal?: AbortSignal
): AsyncGenerator<StreamingResponse> {
  const target = await rpcUrl(endpoint);
  const body = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "SendStreamingMessage",
    params: {
      message: { ...message, ...(endpoint.contextId !== undefined && message.contextId === undefined ? { contextId: endpoint.contextId } : {}) },
    },
  };
  const timeout = endpoint.timeoutMs ?? 120_000;
  const controller = new AbortController();
  // watchdog 既是总死线也是空闲死线：每收到一段数据就重置——流式任务的"慢"
  // 是合法的（对端在做长任务），但"没有任何数据"超过死线就是对端挂了
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`A2A 流式请求超时（${ms}ms 无进展）`)), ms);
  };
  const onExternalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onExternalAbort);
  let response: Response;
  try {
    arm(timeout);
    response = await fetch(target, {
      method: "POST",
      headers: rpcHeaders(endpoint),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new A2aError(-32603, "INTERNAL", `流式请求失败: HTTP ${response.status}`);
    }
  } catch (error) {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      arm(timeout);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 只处理完整事件块；SSE 分隔符允许 CRLF 或 LF（对端实现两种都有），最后一段可能
      // 被截断，留到下一轮拼全
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const chunk of events) {
        const parsed = parseSseChunk(chunk);
        if (parsed === undefined) continue;
        const event = unwrap(parsed) as StreamingResponse;
        yield event;
        // 终态事件后不再等待：对端正常会关流，这里提前收尾避免悬挂
        if ("statusUpdate" in event) {
          const state = event.statusUpdate.status.state;
          if (state === "TASK_STATE_COMPLETED" || state === "TASK_STATE_FAILED" || state === "TASK_STATE_CANCELED" || state === "TASK_STATE_REJECTED") {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    reader.releaseLock();
  }
}

export async function cancelTask(endpoint: A2aEndpoint, taskId: string): Promise<Task> {
  const target = await rpcUrl(endpoint);
  const response = await postJson(
    target,
    { jsonrpc: "2.0", id: randomUUID(), method: "CancelTask", params: { id: taskId } },
    endpoint
  );
  const result = unwrap(response);
  if (isTaskResult(result)) return result.task as Task;
  throw new A2aError(-32006, "INVALID_AGENT_RESPONSE", "CancelTask 返回的不是 Task");
}

/** 从终态 Task 提取纯文本（终答优先取 status.message，其次 artifacts） */
export function taskText(task: Task): string {
  const fromMessage = task.status.message?.parts
    .map((part) => ("text" in part ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n");
  if (fromMessage !== undefined && fromMessage !== "") return fromMessage;
  return (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts)
    .map((part) => ("text" in part ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

// ---------- 传输细节 ----------

async function rpcUrl(endpoint: A2aEndpoint): Promise<string> {
  const resolved = await fetchAgentCard(endpoint);
  return resolved.interface.url;
}

function rpcHeaders(endpoint: A2aEndpoint): Record<string, string> {
  return {
    "content-type": "application/a2a+json",
    accept: "application/a2a+json, application/json",
    "a2a-version": A2A_VERSION,
    ...(endpoint.token !== undefined ? { authorization: `Bearer ${endpoint.token}` } : {}),
  };
}

async function postJson(url: string, body: unknown, endpoint: A2aEndpoint, externalSignal?: AbortSignal): Promise<JsonRpcResponse> {
  const timeout = endpoint.timeoutMs ?? 120_000;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = externalSignal !== undefined ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: rpcHeaders(endpoint),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new A2aError(-32603, "INTERNAL", `请求失败（${url}）: ${error instanceof Error ? error.message : error}`);
  }
  let parsed: JsonRpcResponse;
  try {
    parsed = (await response.json()) as JsonRpcResponse;
  } catch {
    throw new A2aError(-32603, "INTERNAL", `响应不是 JSON（HTTP ${response.status}）`);
  }
  return parsed;
}

async function request(
  base: URL,
  path: string,
  endpoint: A2aEndpoint,
  options: { method: "GET"; accept: string }
): Promise<Response> {
  const timeout = endpoint.timeoutMs ?? 30_000;
  return fetch(new URL(path, base).toString(), {
    method: options.method,
    headers: {
      accept: options.accept,
      "a2a-version": A2A_VERSION,
      ...(endpoint.token !== undefined ? { authorization: `Bearer ${endpoint.token}` } : {}),
    },
    signal: AbortSignal.timeout(timeout),
  });
}

function unwrap(response: JsonRpcResponse): unknown {
  if (response.error !== undefined) {
    const detail = Array.isArray(response.error.data)
      ? (response.error.data[0] as { reason?: string } | undefined)?.reason
      : undefined;
    throw new A2aError(
      response.error.code,
      detail ?? "REMOTE_ERROR",
      `对端返回错误 ${response.error.code}: ${response.error.message}`
    );
  }
  if (response.result === undefined || response.result === null) {
    throw new A2aError(-32006, "INVALID_AGENT_RESPONSE", "对端返回缺少 result");
  }
  return response.result;
}

function isTaskResult(result: unknown): result is { task: Task } {
  return typeof result === "object" && result !== null && "task" in result;
}

/** 解析单个 SSE 事件块：只认 data: 行（注释行/空行忽略） */
function parseSseChunk(chunk: string): JsonRpcResponse | undefined {
  const dataLines = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return undefined;
  try {
    return JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
  } catch {
    return undefined;
  }
}
