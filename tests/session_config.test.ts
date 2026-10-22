import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, EventHub } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import { SessionStore } from "../src/core/session_store";
import { ToolRegistry } from "../src/core/registry";
import { loadAgentConfig } from "../src/config";
import type { ServerRuntime } from "../src/server/runtime";
import type { ServerEvent } from "../src/server/protocol";

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-config-"));
  dirs.push(dir);
  if (!process.env.OPENAI_API_KEY) {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-unused-key";
    cleanups.push(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  }
  const hub = new EventHub();
  const bridge = new UiBridge(hub.publish, 5_000);
  const runtime = {
    config: { ...loadAgentConfig(), model: "default-model", stream: false },
    registry: new ToolRegistry(), skills: [], sandbox: { backend: "host", reason: "test" },
    sandboxRoot: dir, mcp: { getStatus: () => [], closeAll: async () => {} },
  } as unknown as ServerRuntime;
  const manager = new SessionManager({ hub, bridge, runtime, sessionDir: dir, traceDir: path.join(dir, "trace") });
  return { manager, dir };
}
function hello(manager: SessionManager, id: string) {
  return new Promise<Extract<ServerEvent, { type: "hello" }>>((resolve, reject) => {
    const off = manager.subscribe(id, event => {
      if (event.type === "hello") resolve(event);
      if (event.type === "error") reject(new Error(event.message));
    });
    cleanups.push(off);
  });
}

test("切换到未初始化的旧会话时读取它自己的模型，不借用另一会话", async () => {
  const { manager, dir } = await fixture();
  await new SessionStore({ dir, sessionId: "a" }).recordModel("model-a");
  await new SessionStore({ dir, sessionId: "b" }).recordModel("model-b");
  expect((await hello(manager, "a")).model).toBe("model-a");
  expect((await hello(manager, "b")).model).toBe("model-b");
  expect((await hello(manager, "fresh")).model).toBe("default-model");
});

test("首次订阅与设置并发时只初始化一次，选择一次即落盘并用于下一次请求", async () => {
  const { manager, dir } = await fixture();
  const store = new SessionStore({ dir, sessionId: "b" });
  await store.recordModel("old-model");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = SessionStore.prototype.load;
  let loads = 0;
  const spy = spyOn(SessionStore.prototype, "load").mockImplementation(async function (this: SessionStore) {
    if (this.filePath === store.filePath) { loads++; await gate; }
    return original.call(this);
  });
  cleanups.push(() => spy.mockRestore());
  const initial = hello(manager, "b");
  const changed = manager.applySessionConfig("b", { model: "chosen-model" });
  release();
  await initial;
  const applied = await changed;
  expect(loads).toBe(1);
  expect(applied.model).toBe("chosen-model");
  spy.mockRestore();
  expect((await store.load()).model).toBe("chosen-model");
  expect((await hello(manager, "b")).model).toBe("chosen-model");
  // 真正进入 Agent.run，替换网络客户端以检查请求模型，不消耗外部额度。
  const agent = (manager as any).entries.get("b").agent;
  const requests: any[] = [];
  agent.client = { chat: { completions: { create: async (request: any) => {
    requests.push(request);
    return { choices: [{ finish_reason: "stop", message: { content: "回答" } }] };
  } } } };
  await agent.run("测试");
  expect(requests[0].model).toBe("chosen-model");
});

test("取消订阅后，迟到的 hello 不发送给旧页面或其他订阅者", async () => {
  const { manager } = await fixture();
  const events: ServerEvent[] = [];
  const off = manager.subscribe("a", event => events.push(event));
  off();
  await hello(manager, "a");
  expect(events).toHaveLength(0);
});

test("配置保存失败时保留原生效模型，并允许重新应用", async () => {
  const { manager } = await fixture();
  await hello(manager, "a");
  const spy = spyOn(SessionStore.prototype, "recordModel").mockRejectedValueOnce(new Error("无法保存"));
  cleanups.push(() => spy.mockRestore());
  await expect(manager.applySessionConfig("a", { model: "new-model" })).rejects.toThrow("无法保存");
  expect((await hello(manager, "a")).model).toBe("default-model");
  expect((await manager.applySessionConfig("a", { model: "new-model" })).model).toBe("new-model");
});

test("任务事件每个只转发一次，右栏不会收到重复更新", async () => {
  const { manager } = await fixture();
  await hello(manager, "a");
  const agent = (manager as any).entries.get("a").agent;
  expect(agent.events.listenerCount("task_update")).toBe(1);
});
