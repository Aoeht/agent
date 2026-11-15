// src/a2a/jsonrpc.ts
/**
 * A2A 的 JSON-RPC over HTTP 绑定（第 3 层，规范第 9 章）。业务语义在 operations.ts，
 * 这里只做四件事：信封解析、版本协商、方法分发、错误翻译。
 *
 * 传输细节（进阶篇 2.4 / 4.2 / 5.7）：
 * - Content-Type 优先 `application/a2a+json`（v1.0 新 MIME），同时接受 `application/json`
 *   （本地/过渡环境常见；中间层 MIME 白名单问题见评估文档 5.7）；
 * - `A2A-Version` 头：客户端必须带（Major.Minor）。**缺失按规范应视为 0.3**——0.3 的
 *   报文格式（message/send、kind 判别）与 v1.0 不兼容，最省事且不误导对端的做法是
 *   明确拒绝 -32009，而不是静默按 1.0 处理；老客户端可用
 *   AGENT_A2A_ALLOW_MISSING_VERSION=1 显式放行（互操作偏离，记录在实现说明里）；
 * - 流式：每个 SSE `data:` 是一条完整 JSON-RPC 响应，终态后**关闭连接**表示流结束
 *   （v1.0 删除了 final 字段，EOF 就是结束信号）。
 */
import { A2aError, type JsonRpcErrorObject, type JsonRpcRequest, type JsonRpcResponse, type StreamingResponse } from "./types";

const SUPPORTED_VERSION = "1.0";
/** 宽松接受 1.0.x 的 patch 声明（patch 不影响兼容性），但 Major 必须匹配 */
const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.\d+)?$/;

export const A2A_CONTENT_TYPE = "application/a2a+json";

export interface A2aTransport {
  /** 各抽象操作；推送通知四方法由 handleA2aPost 直接路由到 rejectPushNotification */
  sendMessage(params: unknown): Promise<unknown>;
  sendStreamingMessage(params: unknown, emit: (response: StreamingResponse) => void): Promise<void>;
  getTask(params: unknown): unknown;
  cancelTask(params: unknown): unknown;
  listTasks(params: unknown): unknown;
  rejectPushNotification(): never;
}

export interface HandleA2aPostOptions {
  transport: A2aTransport;
  /** 显式注入便于测试；缺省读环境变量 */
  allowMissingVersion?: boolean;
}

/**
 * 处理一次 A2A JSON-RPC POST。返回非流式 Response；流式方法返回 SSE Response
 * （终态后自动关闭）。JSON-RPC 解析错误回 -32700，未知方法回 -32601。
 */
export async function handleA2aPost(req: Request, options: HandleA2aPostOptions): Promise<Response> {
  // ---- 版本协商 ----
  const versionHeader = req.headers.get("a2a-version")?.trim();
  if (versionHeader !== undefined && versionHeader !== "") {
    const match = VERSION_PATTERN.exec(versionHeader);
    if (match === null || match[1] !== "1") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: null,
        error: new A2aError(-32009, "VERSION_NOT_SUPPORTED", `不支持的 A2A-Version: ${versionHeader}（本端实现 ${SUPPORTED_VERSION}）`).toJsonObject(),
      });
    }
  } else {
    const allow = options.allowMissingVersion ?? boolEnv("AGENT_A2A_ALLOW_MISSING_VERSION", false);
    if (!allow) {
      // 缺头按规范视为 0.3；0.3 与 v1.0 报文不兼容，明确拒绝优于错误格式的"成功"
      return jsonResponse({
        jsonrpc: "2.0",
        id: null,
        error: new A2aError(
          -32009,
          "VERSION_NOT_SUPPORTED",
          "缺少 A2A-Version 头（视为 0.3，本端仅支持 1.0）。请在每个请求携带 A2A-Version: 1.0"
        ).toJsonObject(),
      });
    }
  }

  // ---- 信封解析 ----
  let envelope: JsonRpcRequest;
  try {
    const body = (await req.json()) as unknown;
    envelope = body as JsonRpcRequest;
    if (typeof envelope !== "object" || envelope === null || envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
      throw new Error("bad envelope");
    }
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败或信封不合规范" } });
  }
  const { id, method, params } = envelope;
  // respond 只补信封的 jsonrpc/id 两个键；业务结果或错误二选一
  const respond = (body: { result?: unknown; error?: JsonRpcErrorObject }): Response =>
    jsonResponse({ jsonrpc: "2.0", id, ...body });

  // ---- 方法分发（v1.0 的 PascalCase 方法名） ----
  try {
    switch (method) {
      case "SendMessage":
        return respond({ result: await options.transport.sendMessage(params) });
      case "SendStreamingMessage":
        return streamResponse(req, id, options.transport, params);
      case "GetTask":
        return respond({ result: options.transport.getTask(params) });
      case "CancelTask":
        return respond({ result: await options.transport.cancelTask(params) });
      case "ListTasks":
        return respond({ result: options.transport.listTasks(params) });
      case "CreateTaskPushNotificationConfig":
      case "GetTaskPushNotificationConfig":
      case "ListTaskPushNotificationConfigs":
      case "DeleteTaskPushNotificationConfig":
        options.transport.rejectPushNotification();
        break; // rejectPushNotification 恒抛出，仅满足类型收窄
      default:
        return respond({ error: { code: -32601, message: `未知方法: ${method}` } });
    }
  } catch (error) {
    if (error instanceof A2aError) {
      return respond({ error: error.toJsonObject() });
    }
    // 未分类异常：不给对端异常栈，给一句可读的内部错误
    return respond({ error: { code: -32603, message: `内部错误: ${error instanceof Error ? error.message : String(error)}` } });
  }
}

// ---------- 流式 ----------

function streamResponse(req: Request, id: JsonRpcRequest["id"], transport: A2aTransport, params: unknown): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (response: JsonRpcResponse): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(response)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // 客户端断开 ≠ 取消任务（规范 10.x：断开只是停止观察，显式取消走 CancelTask）
      req.signal.addEventListener("abort", () => {
        closed = true;
      });
      try {
        await transport.sendStreamingMessage(params, (response) => send({ jsonrpc: "2.0", id, result: response }));
      } catch (error) {
        if (error instanceof A2aError) {
          send({ jsonrpc: "2.0", id, error: error.toJsonObject() });
        } else {
          send({ jsonrpc: "2.0", id, error: { code: -32603, message: `内部错误: ${error instanceof Error ? error.message : String(error)}` } });
        }
      } finally {
        // 终态事件已发出（或出错）→ 关流。v1.0 客户端靠 EOF 判断流结束
        closed = true;
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------- helpers ----------

function jsonResponse(payload: JsonRpcResponse): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": `${A2A_CONTENT_TYPE}; charset=utf-8` },
  });
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}
