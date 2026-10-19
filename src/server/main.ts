// src/server/main.ts
/**
 * Web UI 服务器入口：`bun run src/server/main.ts`
 *
 * - REST + SSE 按协议文件 src/server/protocol.ts 的端点清单实现；
 * - 静态托管 web/dist（先 `cd web && bun run build`）；开发时前端跑 Vite dev server，
 *   由 vite.config.ts 的代理转发到本服务，两者都只监听 127.0.0.1；
 * - 模型选择清单：AGENT_UI_MODELS（逗号分隔）；缺省只给主模型 + 摘要模型；
 * - run_script 的宿主机后端是任意代码执行，**这个服务器 + 审批桥就是安全边界**：
 *   只绑回环地址，未决审批超时自动拒绝，不要把 AGENT_UI_HOST 改成 0.0.0.0 暴露到局域网。
 */
import path from "node:path";
import OpenAI from "openai";
import { UiBridge } from "./bridge";
import { createServerRuntime, rebuildRuntimeWithSandboxRoot, type ServerRuntime } from "./runtime";
import { EventHub, SessionManager } from "./sessions";
import type { ServerEvent } from "./protocol";

const PORT = intEnv("AGENT_UI_PORT", 8787);
const HOST = process.env.AGENT_UI_HOST?.trim() || "127.0.0.1";
const APPROVAL_TIMEOUT_MS = intEnv("AGENT_UI_APPROVAL_TIMEOUT_MS", 120_000);
const SESSION_DIR = process.env.AGENT_SESSION_DIR ?? path.join(process.cwd(), ".agent-sessions");
const TRACE_DIR = process.env.AGENT_TRACE_DIR ?? path.join(process.cwd(), ".traces");
const DIST_DIR = path.resolve(import.meta.dir, "../../web/dist");

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

async function main(): Promise<void> {
  const hub = new EventHub();
  const bridge = new UiBridge(hub.publish, APPROVAL_TIMEOUT_MS);
  console.log(`⚙️  [UI] 审批超时: ${APPROVAL_TIMEOUT_MS}ms（超时自动拒绝）`);
  const runtime = await createServerRuntime({ bridge });
  const sessions = new SessionManager({
    hub,
    bridge,
    runtime,
    sessionDir: SESSION_DIR,
    traceDir: TRACE_DIR,
  });

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch: (req) => route(req, sessions, bridge, hub, runtime),
  });
  console.log(`🌐 [UI] 工作台已就绪: http://${HOST}:${server.port}/`);
  console.log(`📂 [UI] 会话目录: ${SESSION_DIR}`);

  process.on("SIGINT", () => {
    console.log("\n⏹️  [UI] 收到中断信号，正在关停...");
    void sessions.shutdown().finally(() => process.exit(0));
  });
}

async function route(
  req: Request,
  sessions: SessionManager,
  bridge: UiBridge,
  hub: EventHub,
  runtime: ServerRuntime
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // ---- 会话集合 ----
    if (pathname === "/sessions") {
      if (method === "GET") return json(await sessions.list());
      if (method === "POST") return json(await sessions.create());
    }

    // ---- 单个会话 ----
    const messagesMatch = /^\/sessions\/([^/]+)\/messages$/.exec(pathname);
    if (messagesMatch && method === "POST") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text === "") return json({ error: "text 不能为空" }, 400);
      const sessionId = decodeURIComponent(messagesMatch[1]!);
      if (sessions.isBusy(sessionId)) return json({ error: "当前会话已有任务在运行" }, 409);
      // 202：回合在后台跑，过程与结果经 SSE 推送；逃逸的异常兜底成 error 事件
      void sessions.sendMessage(sessionId, text).catch((error: unknown) => {
        hub.publish(sessionId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return json({ ok: true }, 202);
    }

    const historyMatch = /^\/sessions\/([^/]+)\/history$/.exec(pathname);
    if (historyMatch && method === "GET") {
      return json(await sessions.history(decodeURIComponent(historyMatch[1]!)));
    }

    const eventsMatch = /^\/sessions\/([^/]+)\/events$/.exec(pathname);
    if (eventsMatch && method === "GET") {
      return sseResponse(req, decodeURIComponent(eventsMatch[1]!), sessions);
    }

    const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(pathname);
    if (cancelMatch && method === "POST") {
      sessions.cancel(decodeURIComponent(cancelMatch[1]!));
      return new Response(null, { status: 204 });
    }

    // ---- 审批与人工输入 ----
    const approvalMatch = /^\/approvals\/([^/]+)$/.exec(pathname);
    if (approvalMatch && method === "POST") {
      const body = await readJson(req);
      if (body.action !== "accept" && body.action !== "decline") {
        return json({ error: "action 必须是 accept 或 decline" }, 400);
      }
      const content = body.content;
      const decided = bridge.resolveApproval(decodeURIComponent(approvalMatch[1]!), {
        action: body.action,
        ...(typeof content === "object" && content !== null
          ? { content: content as Record<string, string | number | boolean | string[]> }
          : {}),
      });
      if (!decided) return json({ error: "请求不存在或已过期" }, 404);
      return new Response(null, { status: 204 });
    }

    const inputMatch = /^\/inputs\/([^/]+)$/.exec(pathname);
    if (inputMatch && method === "POST") {
      const body = await readJson(req);
      if (typeof body.text !== "string") return json({ error: "text 必须是字符串" }, 400);
      if (!bridge.resolveInput(decodeURIComponent(inputMatch[1]!), body.text as string)) {
        return json({ error: "请求不存在或已过期" }, 404);
      }
      return new Response(null, { status: 204 });
    }

    // ---- 状态与设置 ----
    if (pathname === "/status" && method === "GET") {
      return json(await sessions.status());
    }

    // 可选模型清单：live 查询 LLM 服务商的 /models（OpenAI 兼容端点），
    // AGENT_UI_MODELS 的清单前置合并；查询失败兜底到主模型 + 摘要模型。缓存 5 分钟。
    if (pathname === "/models" && method === "GET") {
      return json(await resolveModels(runtime));
    }

    // 会话级配置（模型/温度/迭代上限）
    const configMatch = /^\/sessions\/([^/]+)\/config$/.exec(pathname);
    if (configMatch && method === "POST") {
      const body = await readJson(req);
      const patch: { model?: string; temperature?: number; maxIterations?: number } = {};
      if (typeof body.model === "string") patch.model = body.model;
      if (typeof body.temperature === "number") patch.temperature = body.temperature;
      if (typeof body.maxIterations === "number") patch.maxIterations = body.maxIterations;
      if (Object.keys(patch).length === 0) return json({ error: "没有可应用的配置" }, 400);
      try {
        await sessions.applySessionConfig(decodeURIComponent(configMatch[1]!), patch);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, message.includes("已有任务") ? 409 : 400);
      }
      return new Response(null, { status: 204 });
    }

    // 工具开关：读取清单 + 本会话关闭集合
    const toolsMatch = /^\/sessions\/([^/]+)\/tools$/.exec(pathname);
    if (toolsMatch && method === "GET") {
      return json(await sessions.listTools(decodeURIComponent(toolsMatch[1]!)));
    }
    if (toolsMatch && method === "POST") {
      const body = await readJson(req);
      const disabled = Array.isArray(body.disabled) ? body.disabled.filter((d): d is string => typeof d === "string") : null;
      if (disabled === null) return json({ error: "disabled 必须是字符串数组" }, 400);
      try {
        await sessions.setDisabledTools(decodeURIComponent(toolsMatch[1]!), disabled);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      return new Response(null, { status: 204 });
    }

    // 沙箱根目录：读取 / 切换（切换 = 整栈重建，须无在飞回合）
    if (pathname === "/settings" && method === "GET") {
      return json({ sandboxRoot: runtime.sandboxRoot });
    }
    if (pathname === "/settings/sandbox" && method === "POST") {
      const body = await readJson(req);
      const dir = typeof body.dir === "string" ? body.dir.trim() : "";
      if (dir === "") return json({ error: "dir 不能为空" }, 400);
      if (sessions.anyBusy()) {
        return json({ error: "有会话正在运行，等回合结束后再切换沙箱目录" }, 409);
      }
      try {
        await rebuildRuntimeWithSandboxRoot(runtime, bridge, dir);
      } catch (error) {
        return json(
          { error: `切换沙箱目录失败: ${error instanceof Error ? error.message : String(error)}` },
          400
        );
      }
      sessions.resetAgents();
      console.log(`📦 [UI] 沙箱目录已切换: ${runtime.sandboxRoot}`);
      return json({ sandboxRoot: runtime.sandboxRoot });
    }

    // ---- 静态资源（非 API 的 GET 一律回 SPA）----
    if (method === "GET") return serveStatic(pathname);
    return json({ error: "Not Found" }, 404);
  } catch (error) {
    console.error("[UI] 请求处理失败:", error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ---- helpers ----

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------- 模型清单 ----------

let modelsCache: { at: number; models: string[] } = { at: 0, models: [] };

function dedupeKeepOrder(models: string[]): string[] {
  return [...new Set(models.filter((model) => model !== ""))];
}

async function resolveModels(runtime: ServerRuntime): Promise<string[]> {
  const configured = (process.env.AGENT_UI_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const current = dedupeKeepOrder([runtime.config.model, runtime.config.summaryModel]);

  const now = Date.now();
  if (now - modelsCache.at < 5 * 60_000) {
    return dedupeKeepOrder([...current, ...configured, ...modelsCache.models]);
  }

  try {
    // 与 Agent 相同的 OpenAI 兼容端点（OPENAI_BASE_URL/KEY）：live 拉服务商可用清单，
    // 过滤掉嵌入/重排/语音等非对话模型
    const client = new OpenAI({ maxRetries: 0, timeout: 5_000 });
    const page = await client.models.list();
    const ids: string[] = [];
    for await (const model of page) {
      if (!/embed|rerank|tts|asr|whisper|moderation/i.test(model.id)) ids.push(model.id);
    }
    ids.sort((a, b) => a.localeCompare(b));
    modelsCache = { at: now, models: ids };
    return dedupeKeepOrder([...current, ...configured, ...ids]);
  } catch (error) {
    console.warn(
      "[UI] 服务商模型清单查询失败，回退到配置模型:",
      error instanceof Error ? error.message : error
    );
    // 失败也计入缓存：避免每次刷新都白等一次超时
    modelsCache = { at: now, models: [] };
    return dedupeKeepOrder([...current, ...configured]);
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sseResponse(req: Request, sessionId: string, sessions: SessionManager): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ServerEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      unsubscribe = sessions.subscribe(sessionId, send);
      // 心跳注释行：防止代理/空闲超时掐断长连接
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // 流已被关闭
        }
      }, 15_000);
      req.signal.addEventListener("abort", () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
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

async function serveStatic(pathname: string): Promise<Response> {
  const indexFile = Bun.file(path.join(DIST_DIR, "index.html"));
  if (!(await indexFile.exists())) {
    return new Response(
      "web/dist 不存在：生产访问请先 `cd web && bun run build`；开发时用 `cd web && bun run dev`（Vite 代理已指向本服务）",
      { status: 503 }
    );
  }
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(DIST_DIR, rel);
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }
  const file = Bun.file(resolved);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream" },
    });
  }
  return new Response(Bun.file(path.join(DIST_DIR, "index.html")), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
