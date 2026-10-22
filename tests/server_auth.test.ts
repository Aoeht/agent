import { afterEach, expect, test } from "bun:test";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { registerSessionTools } from "../src/bootstrap";
import {
  AUTH_COOKIE,
  AuthGate,
  assertUsableToken,
  bindRefusal,
  cookieValue,
  isLoopbackBind,
  sandboxRefusal,
} from "../src/server/auth";

const TOKEN = "0123456789abcdef0123456789abcdef";
const warns: string[] = [];
const originalWarn = console.warn;
afterEach(() => {
  console.warn = originalWarn;
  warns.length = 0;
});
function quiet(): void {
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
}
const request = (url: string, init: RequestInit = {}) => new Request(url, init);

test("没设口令时一个请求都不拦（本地回环开发的现有形态）", () => {
  const gate = new AuthGate(assertUsableToken(undefined));
  expect(gate.enabled).toBe(false);
  expect(gate.authorize(request("http://127.0.0.1:8787/sessions"))).toBe(true);
});

test("Bearer 与 cookie 都算凭据；原始口令当 cookie 值不算", () => {
  const gate = new AuthGate(assertUsableToken(TOKEN));
  expect(gate.authorize(request("http://127.0.0.1/sessions", { headers: { authorization: `Bearer ${TOKEN}` } }))).toBe(true);
  expect(gate.authorize(request("http://127.0.0.1/sessions", { headers: { cookie: `${AUTH_COOKIE}=${cookieValue(TOKEN)}` } }))).toBe(true);
  expect(gate.authorize(request("http://127.0.0.1/sessions", { headers: { cookie: `${AUTH_COOKIE}=${TOKEN}` } }))).toBe(false);
  expect(gate.authorize(request("http://127.0.0.1/sessions", { headers: { authorization: `Bearer ${TOKEN.slice(0, 31)}0` } }))).toBe(false);
  expect(gate.authorize(request("http://127.0.0.1/sessions"))).toBe(false);
});

test("短于 32 位的口令直接拒绝启动，不静默当成门禁", () => {
  expect(() => assertUsableToken("guessme")).toThrow("32");
  expect(assertUsableToken(`  ${TOKEN}  `)).toBe(TOKEN);
});

test("非回环绑定或开了收紧却没口令，一律拒绝启动", () => {
  expect(bindRefusal({ host: "127.0.0.1", token: undefined, hardening: false })).toBeUndefined();
  expect(bindRefusal({ host: "0.0.0.0", token: undefined, hardening: false })).toContain("AGENT_UI_TOKEN");
  expect(bindRefusal({ host: "0.0.0.0", token: TOKEN, hardening: true })).toBeUndefined();
  expect(bindRefusal({ host: "localhost", token: undefined, hardening: true })).toContain("AGENT_UI_REMOTE_HARDENING");
  expect(isLoopbackBind("[::1]")).toBe(true);
  expect(isLoopbackBind("192.168.1.20")).toBe(false);
});

test("远程收紧不接受解析到宿主机进程的沙箱", () => {
  expect(sandboxRefusal({ hardening: true, backend: "host" })).toContain("容器沙箱");
  expect(sandboxRefusal({ hardening: true, backend: "docker" })).toBeUndefined();
  expect(sandboxRefusal({ hardening: false, backend: "host" })).toBeUndefined();
});

test("登录成功只发派生值 cookie；Secure 位跟着 X-Forwarded-Proto", async () => {
  quiet();
  const gate = new AuthGate(TOKEN);
  const plain = await gate.handleLogin(request("http://127.0.0.1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  }));
  expect(plain.status).toBe(302);
  expect(plain.headers.get("location")).toBe("/");
  const cookie = plain.headers.get("set-cookie") ?? "";
  expect(cookie).toContain(`${AUTH_COOKIE}=${cookieValue(TOKEN)}`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).not.toContain("Secure");
  const tls = await gate.handleLogin(request("https://agent.example.test/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
    body: `token=${TOKEN}`,
  }));
  expect(tls.headers.get("set-cookie") ?? "").toContain("Secure");
  const wrong = await gate.handleLogin(request("http://127.0.0.1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "猜的" }),
  }));
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get("set-cookie")).toBeNull();
  expect(warns.join(" ")).toContain("登录被拒");
});

test("未验凭据时浏览器导航回登录页，API 回 401 JSON", () => {
  quiet();
  const gate = new AuthGate(TOKEN);
  const page = gate.challenge(request("http://127.0.0.1/", { headers: { accept: "text/html" } }));
  expect(page.status).toBe(401);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  const api = gate.challenge(request("http://127.0.0.1/sessions/x/history"));
  expect(api.status).toBe(401);
  expect(api.headers.get("www-authenticate")).toBe("Bearer");
  expect(api.headers.get("content-type")).toContain("json");
});

test("远程收紧时 run_script 不在工具清单里，其余内置工具照常", () => {
  const build = (disableRunScript: boolean): ToolRegistry => {
    const registry = new ToolRegistry();
    registerSessionTools(registry, {
      skills: [],
      planStore: new PlanStore(),
      sandbox: { backend: "host", reason: "test" },
      disableRunScript,
    });
    return registry;
  };
  expect(build(false).has("run_script")).toBe(true);
  expect(build(true).has("run_script")).toBe(false);
  expect(build(true).has("update_plan")).toBe(true);
  expect(build(true).has("rag_search")).toBe(true);
});
