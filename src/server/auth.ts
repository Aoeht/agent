// src/server/auth.ts
/**
 * Web UI 的访问门禁。它只回答"谁可以进来"这一件事，不替代能力收紧：
 * run_script 是任意代码执行，公网入口下要靠 AGENT_UI_REMOTE_HARDENING 关掉它，
 * 不能指望这道门挡住拿到口令的人。
 *
 * 两条凭据通道：
 * - `Authorization: Bearer <AGENT_UI_TOKEN>`：脚本调用与未来的 A2A 客户端；
 * - HttpOnly cookie：浏览器里的 SPA 与 EventSource（后者发不出自定义请求头）。
 * cookie 存的是 token 的派生值而不是 token 本身：浏览器侧泄露 cookie
 * 不等于泄露那条长期有效的原始口令。
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "agent_ui_token";
/** 短于这个长度的口令可以被暴力猜，比不设更危险 */
export const MIN_TOKEN_LENGTH = 32;
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function normalizeToken(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/** 启动期校验：设了但太短的 token 直接拒绝启动，不静默降级成"看起来有门禁" */
export function assertUsableToken(raw: string | undefined): string | undefined {
  const token = normalizeToken(raw);
  if (token === undefined) return undefined;
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `AGENT_UI_TOKEN 至少需要 ${MIN_TOKEN_LENGTH} 个字符（当前 ${token.length} 个）。` +
        ` 用随机串：bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`
    );
  }
  return token;
}

/** 反代终结 TLS 时 Bun 只看到 http，凭 X-Forwarded-Proto 决定 cookie 的 Secure 位 */
export function forwardedProto(request: Request): "https" | "http" {
  const raw = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (raw === "https" || raw === "http") return raw;
  return new URL(request.url).protocol === "https:" ? "https" : "http";
}

export function isLoopbackBind(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value.startsWith("127.");
}

/**
 * 绑定与门禁的组合是否必须拒绝启动。回环 + 无口令是原本的开发形态，放行；
 * 非回环或开了远程收紧却没有口令，等于把工作区与模型 Key 交给整条网络。
 */
export function bindRefusal(options: {
  host: string;
  token: string | undefined;
  hardening: boolean;
}): string | undefined {
  if (options.token !== undefined) return undefined;
  if (!isLoopbackBind(options.host)) {
    return `AGENT_UI_HOST=${options.host} 不是回环地址，但没设 AGENT_UI_TOKEN：拒绝启动。` +
      " 要么保持 127.0.0.1 并用 Tailscale / Cloudflare Tunnel 暴露，要么设 AGENT_UI_TOKEN（≥32 位随机串）。";
  }
  if (options.hardening) {
    return "AGENT_UI_REMOTE_HARDENING 需要配套 AGENT_UI_TOKEN：收紧只是砍能力，身份还是得有人验。";
  }
  return undefined;
}

/** 远程收紧不接受宿主机进程沙箱：那样关掉 run_script 之后仍有 MCP 写文件面，容器才谈得上边界 */
export function sandboxRefusal(options: { hardening: boolean; backend: "docker" | "host" }): string | undefined {
  if (!options.hardening || options.backend === "docker") return undefined;
  return "远程收紧模式要求容器沙箱，实际解析到宿主机进程：拒绝启动。" +
    " 起 Docker 桌面/引擎并设 AGENT_SANDBOX=docker（镜像缺失时启动会直接报错，不静默降级）。";
}

/** token 的定长散列比较：长度不同也不通过时间差泄漏 */
function equals(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export function cookieValue(token: string): string {
  return createHash("sha256").update(`agent-ui-cookie:${token}`).digest("hex");
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

async function readSubmittedToken(request: Request): Promise<string | undefined> {
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await request.json().catch(() => undefined)) as { token?: unknown } | undefined;
    return typeof body?.token === "string" ? normalizeToken(body.token) : undefined;
  }
  const form = await request.formData().catch(() => undefined);
  const value = form?.get("token");
  return typeof value === "string" ? normalizeToken(value) : undefined;
}

const LOGIN_STYLE = "font:14px/1.6 system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#faf6ef";

export class AuthGate {
  /** token 为 undefined 时门禁关闭：本地回环开发的现有行为，一个请求都不拦 */
  constructor(private readonly token: string | undefined) {}

  get enabled(): boolean {
    return this.token !== undefined;
  }

  authorize(request: Request): boolean {
    if (this.token === undefined) return true;
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (bearer !== undefined && bearer !== "" && equals(bearer, this.token)) return true;
    const cookie = readCookie(request, AUTH_COOKIE);
    return cookie !== undefined && equals(cookie, cookieValue(this.token));
  }

  /** 浏览器导航回登录页，其余回 401 JSON（SPA 据此跳登录） */
  challenge(request: Request): Response {
    if (this.token === undefined) return new Response(null, { status: 404 });
    const wantsPage = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
    if (wantsPage) return this.loginPage("需要口令才能进入", 401);
    return new Response(JSON.stringify({ error: "未授权：请登录后再试，或携带 Authorization: Bearer <token>" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", vary: "Cookie", "www-authenticate": "Bearer" },
    });
  }

  async handleLogin(request: Request): Promise<Response> {
    if (this.token === undefined) return this.loginPage("当前实例没设 AGENT_UI_TOKEN，不需要登录");
    if (request.method === "GET") return this.loginPage();
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const submitted = await readSubmittedToken(request);
    if (submitted === undefined || !equals(submitted, this.token)) {
      console.warn("[UI] 登录被拒：凭据不匹配");
      return this.loginPage("口令不对", 401);
    }
    return new Response(null, {
      status: 302,
      headers: { location: "/", "set-cookie": this.cookieHeader(request), vary: "Cookie" },
    });
  }

  private cookieHeader(request: Request): string {
    return [
      `${AUTH_COOKIE}=${cookieValue(this.token ?? "")}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      ...(forwardedProto(request) === "https" ? ["Secure"] : []),
    ].join("; ");
  }

  private loginPage(message?: string, status = 200): Response {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>agent 工作台</title>` +
        `<style>${LOGIN_STYLE}</style><form method="post" action="/login" style="display:grid;gap:10px">` +
        `<h1 style="font-size:16px">agent 工作台</h1>` +
        `<input name="token" type="password" placeholder="访问口令" autofocus style="padding:8px;border:1px solid #d8cbb2;border-radius:6px">` +
        `<button type="submit" style="padding:8px;border:0;border-radius:6px;background:#2f6f4e;color:#fff">进入</button>` +
        (message !== undefined ? `<p style="color:#9c4a2f">${message}</p>` : "") +
        `</form>`,
      {
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // 登录页是自包含的一坨 HTML：不放行任何外部资源，内联样式之外什么都别执行
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
          "cache-control": "no-store",
          vary: "Cookie",
        },
      }
    );
  }
}
