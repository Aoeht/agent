// tests/session_mcp_sync.test.ts
// MCP 工具变更向长驻会话注册表的传播：
//   - 共享注册表新增 MCP 工具 → 会话下一回合开始时对齐（含 tools_changed 事件）
//   - 共享注册表移除 → 会话下一回合摘除
//   - 工具开关的禁用集合在对齐后仍然生效
// 运行: bun test ./tests/session_mcp_sync.test.ts
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SessionManager, EventHub } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import { ToolRegistry } from "../src/core/registry";
import { defineTool } from "../src/core/types";
import { loadAgentConfig } from "../src/config";
import type { ServerRuntime } from "../src/server/runtime";
import type { ServerEvent } from "../src/server/protocol";

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Windows 下 sqlite 句柄晚一拍释放时容忍残留（tmp 目录，系统会清理）
    }
  }
});

/** 轮询等待谓词成立：回合收尾在负载下可能超过固定 sleep，轮询消掉竞态假阴性 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-sync-"));
  dirs.push(dir);
  if (!process.env.OPENAI_API_KEY) {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-unused-key";
    cleanups.push(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  }
  const hub = new EventHub();
  const bridge = new UiBridge(hub.publish, 5_000);
  const shared = new ToolRegistry();
  const runtime = {
    // checkpointsEnabled=false：本文件不测检查点，快照钩子的 git 子进程会拖慢回合时序
    config: { ...loadAgentConfig(), model: "default-model", stream: false, checkpointsEnabled: false },
    registry: shared, skills: [], sandbox: { backend: "host", reason: "test" },
    sandboxRoot: dir, mcp: { getStatus: () => [], closeAll: async () => {} },
    dispose: async () => {},
  } as unknown as ServerRuntime;
  const manager = new SessionManager({ hub, bridge, runtime, sessionDir: dir, traceDir: path.join(dir, "trace") });
  return { manager, shared, dir };
}

function fakeClient() {
  const client: any = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "好的" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    },
  };
  return client;
}

function hello(manager: SessionManager, id: string) {
  return new Promise<void>((resolve, reject) => {
    const off = manager.subscribe(id, event => {
      if (event.type === "hello") resolve();
      if (event.type === "error") reject(new Error(event.message));
    });
    cleanups.push(off);
  });
}

const probeDef = (name: string) => defineTool({
  name, description: `探针 ${name}`, schema: z.object({}), parallelSafe: true,
  execute: async () => "probe",
});

test("共享注册表的 MCP 工具增删在下一回合对齐进会话注册表，并广播 tools_changed", async () => {
  const { manager, shared } = await fixture();
  await hello(manager, "s1");
  (manager as any).entries.get("s1").agent.client = fakeClient();
  const events: ServerEvent[] = [];
  cleanups.push(manager.subscribe("s1", event => events.push(event)));
  const sessionRegistry = () => (manager as any).entries.get("s1").registry as ToolRegistry;
  const idle = () => (manager as any).entries.get("s1").controller === undefined;

  await manager.sendMessage("s1", "第一句");
  await waitFor(idle);
  expect(sessionRegistry().has("fake__probe")).toBe(false);

  // 热载入：共享注册表出现新 MCP 工具（模拟 .mcp.json 加了 server）
  shared.register(probeDef("fake__probe"));
  await manager.sendMessage("s1", "第二句");
  await waitFor(() => sessionRegistry().has("fake__probe"));
  expect(events.some(event => event.type === "tools_changed")).toBe(true);

  // 下线：共享注册表移除 → 下一回合从会话注册表摘掉
  shared.unregister("fake__probe");
  await manager.sendMessage("s1", "第三句");
  await waitFor(() => idle() && !sessionRegistry().has("fake__probe"));

  // 定义快照（工具开关的恢复源）与共享侧一致
  const toolDefs = (manager as any).entries.get("s1").toolDefs as Map<string, unknown>;
  expect(toolDefs.has("fake__probe")).toBe(false);
});

test("对齐后本会话的禁用集合仍然生效（同步不复活被关的工具）", async () => {
  const { manager, shared } = await fixture();
  shared.register(probeDef("fake__keep"));
  shared.register(probeDef("fake__off"));
  await hello(manager, "s2");
  (manager as any).entries.get("s2").agent.client = fakeClient();
  const sessionRegistry = () => (manager as any).entries.get("s2").registry as ToolRegistry;
  const idle = () => (manager as any).entries.get("s2").controller === undefined;

  await manager.sendMessage("s2", "第一句");
  await waitFor(idle);
  await manager.setDisabledTools("s2", ["fake__off"]);
  expect(sessionRegistry().has("fake__off")).toBe(false);

  // 触发一次同步（无实际差异）后再确认禁用未被复活
  shared.register(probeDef("fake__new"));
  await manager.sendMessage("s2", "第二句");
  await waitFor(() => sessionRegistry().has("fake__new"));
  expect(sessionRegistry().has("fake__off")).toBe(false); // 仍被禁用
  expect(sessionRegistry().has("fake__keep")).toBe(true);
});
