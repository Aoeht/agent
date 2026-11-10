// tests/progress_snapshot.test.ts
// 进度快照（崩溃续跑，知识框架 #21）链路测试：
//   - 每完成一轮工具，账本覆盖写入紧凑进度（轮次/模型最后输出/该轮工具）
//   - 正常收尾 finish() 清除——账本里还有 progress 就意味着上次进程死在半路
//   - 崩溃恢复后继续任务：任务块渲染 interruptedProgress，模型知道"上次跑到第几轮"
// 运行: bun test ./tests/progress_snapshot.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import { Agent } from "../src/core/agent";
import { TaskStore } from "../src/core/task_store";
import { ToolRegistry } from "../src/core/registry";

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(root);
  return root;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

const reply = (content = "已完成") => ({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const call = (name: string, args: unknown = {}) => ({ choices: [{ finish_reason: "tool_calls", message: {
  content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
type Config = ConstructorParameters<typeof Agent>[0];
function setup(script: unknown[], config: Partial<Config> = {}) {
  let count = 0;
  const payloads: any[] = [];
  const client = { chat: { completions: { create: async (params: unknown) => {
    payloads.push(params);
    const item = script[count++];
    if (item === undefined) throw new Error("unexpected request");
    return item;
  } } } };
  const agent = new Agent({ model: "test", systemPrompt: "test", maxRetries: 0, ...config, client: client as any });
  return { agent, payloads };
}

/** 种一条"recover() 已跑过"的账本：属主清空、状态 interrupted——不依赖平台级 pid 探测 */
function seedRecoveredWithoutOwner(file: string): void {
  const db = new Database(file);
  const row = db.query("SELECT id, data FROM tasks ORDER BY seq DESC LIMIT 1").get() as { id: string; data: string };
  const record = JSON.parse(row.data);
  record.owner = undefined;
  record.state = "interrupted";
  db.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(record), row.id);
  db.close();
}

describe("进度快照（崩溃续跑）", () => {
  test("每轮工具后覆盖写入进度，正常收尾清除且下轮请求不再出现", async () => {
    const taskStore = new TaskStore();
    const tools = new ToolRegistry();
    const seen: Array<Record<string, unknown> | undefined> = [];
    tools.register({ name: "probe", description: "probe", execute: async () => {
      const task = taskStore.current();
      seen.push(task?.progress ? { ...task.progress } : undefined);
      return "ok";
    } });
    const round1 = { choices: [{ finish_reason: "tool_calls", message: {
      content: "我先探测环境", tool_calls: [{ id: "c1", type: "function", function: { name: "probe", arguments: "{}" } }],
    } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    const { agent, payloads } = setup([round1, call("probe"), reply("完成")], { tools, taskStore });
    await agent.run("探测任务");
    // 第一轮执行时还没有进度（快照写在轮末）；第二轮执行时能看到第一轮的快照
    expect(seen[0]).toBeUndefined();
    const first = seen[1] as { iteration: number; note: string; tools: Array<{ tool: string; arguments: string }> };
    expect(first.iteration).toBe(1);
    expect(first.note).toBe("我先探测环境");
    expect(first.tools[0]?.tool).toBe("probe");
    expect(first.tools[0]?.arguments).toBe("{}");
    // 正常收尾清除
    expect(taskStore.current()?.progress).toBeUndefined();
    // 第二次 run 的请求里不再出现旧进度
    await agent.run("继续");
    expect(JSON.stringify(payloads[1]?.messages ?? [])).not.toContain("interruptedProgress");
  });

  test("崩溃恢复后继续：任务块渲染 interruptedProgress，收尾后清除", async () => {
    const root = await tempDir("progress-snapshot-");
    const file = path.join(root, "task.sqlite");
    const store = new TaskStore(file);
    store.begin("原任务");
    store.recordProgress({ iteration: 3, note: "正在写报告第三章",
      tools: [{ tool: "write_once", arguments: "{\"path\":\"r.md\"}" }], tokens: 1234, at: new Date().toISOString() });
    seedRecoveredWithoutOwner(file);

    const { agent, payloads } = setup([reply("继续完成")], { taskStore: new TaskStore(file) });
    await agent.run("接着做");
    // 任务块是围栏包裹的 JSON：解析出来断言，避免双重转义干扰
    const block = ((payloads[0]!.messages as Array<{ role: string; content: string }>)
      .find((m) => m.content.includes("interruptedProgress"))!);
    const payload = JSON.parse(block.content.split("<UNTRUSTED_MCP_DATA>")[1]!.split("</UNTRUSTED_MCP_DATA>")[0]!.trim());
    expect(payload.interruptedProgress.iteration).toBe(3);
    expect(payload.interruptedProgress.note).toBe("正在写报告第三章");
    expect(payload.interruptedProgress.tools[0]?.tool).toBe("write_once");
    // 恢复轮正常收尾后，旧进度清除
    expect(new TaskStore(file).current()?.progress).toBeUndefined();
  });
});
