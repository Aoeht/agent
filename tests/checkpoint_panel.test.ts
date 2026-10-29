// tests/checkpoint_panel.test.ts
/**
 * Web 检查点面板的服务端接口：listCheckpoints / rewindCheckpoint。
 * 检查点用独立的 CheckpointStore 在同一个影子仓库上"预置"（等价于之前跑过几轮），
 * 不启动 Agent、不消耗任何模型额度。
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, EventHub } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import { SessionStore } from "../src/core/session_store";
import { ToolRegistry } from "../src/core/registry";
import { CheckpointStore } from "../src/core/checkpoint_store";
import { loadAgentConfig } from "../src/config";
import type { ServerRuntime } from "../src/server/runtime";
import type { ServerEvent } from "../src/server/protocol";

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function fixture(checkpointsEnabled = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-panel-"));
  dirs.push(dir);
  if (!process.env.OPENAI_API_KEY) {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-unused-key";
    cleanups.push(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  }
  // 会话目录与工作区必须分开：影子仓库在会话目录下，生产里也在 .mcp-sandbox 之外
  const sessionDir = path.join(dir, "sessions");
  const sandboxRoot = path.join(dir, "sandbox");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(sandboxRoot, { recursive: true });
  const hub = new EventHub();
  const bridge = new UiBridge(hub.publish, 5_000);
  const runtime = {
    config: { ...loadAgentConfig(), model: "default-model", stream: false, checkpointsEnabled },
    registry: new ToolRegistry(), skills: [], sandbox: { backend: "host", reason: "test" },
    sandboxRoot,
    mcp: { getStatus: () => [], closeAll: async () => {} },
  } as unknown as ServerRuntime;
  const make = () => new SessionManager({ hub, bridge, runtime, sessionDir, traceDir: path.join(dir, "trace") });
  return { manager: make(), make, hub, sessionDir, sandboxRoot };
}

/**
 * 预置两个检查点（等价于之前跑过两轮）：
 *   #1「第一轮：建 a.txt」边界 = 0 条记录，工作区 {a.txt:v1}
 *   #2「第二轮：改 a.txt 并建 b.txt」边界 = 2 条记录，工作区 {a.txt:v2, b.txt:new}
 * 之后又追加了第二轮问答，当前文件共 4 条记录、工作区还多出 b.txt。
 */
async function seedChecks(dir: string, sandboxRoot: string, sessionId: string) {
  const store = new SessionStore({ dir, sessionId });
  const checkpoints = new CheckpointStore({
    shadowRoot: path.join(dir, "checkpoints", sessionId),
    sandboxRoot,
    sessionRecordCount: () => store.recordCount(),
  });
  await fs.writeFile(path.join(sandboxRoot, "a.txt"), "v1");
  await checkpoints.snapshot("第一轮：建 a.txt");
  await store.append({ role: "user", content: "第一轮" });
  await store.append({ role: "assistant", content: "答 1" });

  await fs.writeFile(path.join(sandboxRoot, "a.txt"), "v2");
  await fs.writeFile(path.join(sandboxRoot, "b.txt"), "new");
  await checkpoints.snapshot("第二轮：改 a.txt 并建 b.txt");
  await store.append({ role: "user", content: "第二轮" });
  await store.append({ role: "assistant", content: "答 2" });
}

const read = (file: string) => fs.readFile(file, "utf-8");
const exists = async (file: string) => fs.access(file).then(() => true, () => false);

test("检查点清单最新在前，seq/input/records 与快照一致", async () => {
  const { manager, sessionDir, sandboxRoot } = await fixture();
  expect(await manager.listCheckpoints("a")).toEqual({ enabled: true, checkpoints: [] });

  await seedChecks(sessionDir, sandboxRoot, "a");
  const listed = await manager.listCheckpoints("a");
  expect(listed.enabled).toBe(true);
  expect(listed.checkpoints.map((info) => info.seq)).toEqual([2, 1]);
  expect(listed.checkpoints.map((info) => info.input)).toEqual(["第二轮：改 a.txt 并建 b.txt", "第一轮：建 a.txt"]);
  expect(listed.checkpoints.map((info) => info.records)).toEqual([2, 0]);
  expect(Number.isNaN(Date.parse(listed.checkpoints[0]!.time))).toBe(false);
});

test("进程重启后仍能列出磁盘上的检查点", async () => {
  const { manager, make, sessionDir, sandboxRoot } = await fixture();
  await seedChecks(sessionDir, sandboxRoot, "a");
  expect((await manager.listCheckpoints("a")).checkpoints).toHaveLength(2);
  // 新实例 = 重启后的服务器：regentry 全空，影子仓库对象还没建
  const restarted = make();
  expect((await restarted.listCheckpoints("a")).checkpoints.map((info) => info.seq)).toEqual([2, 1]);
});

test("只恢复代码：写回快照并删除之后新增的文件，对话历史不动", async () => {
  const { manager, hub, sessionDir, sandboxRoot } = await fixture();
  await seedChecks(sessionDir, sandboxRoot, "a");
  const events: ServerEvent[] = [];
  cleanups.push(hub.subscribe("a", (event) => events.push(event)));

  const result = await manager.rewindCheckpoint("a", 1, "code");
  expect(result).toMatchObject({ ok: true, seq: 1, scope: "code", restored: 1, deleted: 1 });
  expect(result.refresh).toBeUndefined();
  expect(result.records).toBeUndefined();
  expect(result.lines.some((line) => line.includes("已恢复工作区"))).toBe(true);
  expect(await read(path.join(sandboxRoot, "a.txt"))).toBe("v1");
  expect(await exists(path.join(sandboxRoot, "b.txt"))).toBe(false);
  // 对话文件原样保留（4 条）
  expect((await new SessionStore({ dir: sessionDir, sessionId: "a" }).load()).messages).toHaveLength(4);
  // 只回滚代码不广播 history_rewound：历史没变，其它标签页无需重拉
  expect(events.some((event) => event.type === "history_rewound")).toBe(false);
});

test("只恢复对话：截断会话文件并广播 history_rewound，工作区不动", async () => {
  const { manager, hub, sessionDir, sandboxRoot } = await fixture();
  await seedChecks(sessionDir, sandboxRoot, "a");
  const events: ServerEvent[] = [];
  cleanups.push(hub.subscribe("a", (event) => events.push(event)));

  const result = await manager.rewindCheckpoint("a", 2, "chat");
  expect(result).toMatchObject({ ok: true, seq: 2, scope: "chat", records: 2, refresh: "history" });
  expect(result.restored).toBeUndefined();
  expect(result.lines.some((line) => line.includes("已恢复对话"))).toBe(true);
  expect((await new SessionStore({ dir: sessionDir, sessionId: "a" }).load()).messages).toHaveLength(2);
  expect(await read(path.join(sandboxRoot, "a.txt"))).toBe("v2");
  expect(await exists(path.join(sandboxRoot, "b.txt"))).toBe(true);
  expect(events).toContainEqual({ type: "history_rewound", seq: 2, scope: "chat" });
});

test("全部恢复：文件与对话同时回到该检查点", async () => {
  const { manager, sessionDir, sandboxRoot } = await fixture();
  await seedChecks(sessionDir, sandboxRoot, "a");
  const result = await manager.rewindCheckpoint("a", 1, "all");
  expect(result).toMatchObject({ ok: true, restored: 1, deleted: 1, records: 0, refresh: "history" });
  expect(await read(path.join(sandboxRoot, "a.txt"))).toBe("v1");
  expect(await exists(path.join(sandboxRoot, "b.txt"))).toBe(false);
  expect((await new SessionStore({ dir: sessionDir, sessionId: "a" }).load()).messages).toHaveLength(0);
});

test("未知检查点号拒绝执行，工作区与会话都不动", async () => {
  const { manager, sessionDir, sandboxRoot } = await fixture();
  await seedChecks(sessionDir, sandboxRoot, "a");
  await expect(manager.rewindCheckpoint("a", 99, "all")).rejects.toThrow("不存在");
  expect(await read(path.join(sandboxRoot, "a.txt"))).toBe("v2");
  expect((await new SessionStore({ dir: sessionDir, sessionId: "a" }).load()).messages).toHaveLength(4);
});

test("回合进行中拒绝回滚", async () => {
  const { manager, sessionDir, sandboxRoot } = await fixture();
  await seedChecks(sessionDir, sandboxRoot, "a");
  await manager.listCheckpoints("a"); // 建立 entry
  const entry = (manager as any).entries.get("a");
  entry.controller = new AbortController();
  try {
    await expect(manager.rewindCheckpoint("a", 1, "all")).rejects.toThrow("回合进行中");
  } finally {
    entry.controller = undefined;
  }
  expect(await read(path.join(sandboxRoot, "a.txt"))).toBe("v2");
});

test("回滚前先等在途的长期摘要落盘", async () => {
  const { manager, sessionDir, sandboxRoot } = await fixture();
  await seedChecks(sessionDir, sandboxRoot, "a");
  await manager.listCheckpoints("a"); // 建立 entry
  const entry = (manager as any).entries.get("a");
  let settled = 0;
  entry.agent = { flushSummary: async () => { settled++; return 0; } };
  await manager.rewindCheckpoint("a", 2, "chat");
  expect(settled).toBe(1);
});

test("检查点关闭时面板显示 enabled=false，回滚被拒绝", async () => {
  const { manager } = await fixture(false);
  expect(await manager.listCheckpoints("a")).toEqual({ enabled: false, checkpoints: [] });
  await expect(manager.rewindCheckpoint("a", 1, "all")).rejects.toThrow("未启用");
});
