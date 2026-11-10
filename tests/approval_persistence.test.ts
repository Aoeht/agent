// tests/approval_persistence.test.ts
// 审批持久化链路测试（知识框架 #20）：
//   - 工具内部发起等审批/等输入时，账本 waiting 记下"卡在等谁"（调用 ID/工具/参数/runId/开始时间）
//   - 审批返回后等待标记清除
//   - 进程重启恢复：属主已死 + waiting.call 残留 → clearStaleWaiting 清标记、保留 interrupted 态
//   - SessionManager.subscribe：残留 → approval_recovered 事件 + task_update 无 waiting；二次订阅不重复
// 运行: bun test ./tests/approval_persistence.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import { Agent } from "../src/core/agent";
import { SessionStore } from "../src/core/session_store";
import { TaskStore } from "../src/core/task_store";
import { ToolRegistry } from "../src/core/registry";
import type { ToolRuntime } from "../src/core/types";
import { EventHub, SessionManager } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import type { ServerEvent } from "../src/server/protocol";

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
  const client = { chat: { completions: { create: async () => {
    const item = script[count++];
    if (item === undefined) throw new Error("unexpected request");
    return item;
  } } } };
  const agent = new Agent({ model: "test", systemPrompt: "test", maxRetries: 0, ...config, client: client as any });
  return { agent };
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

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("审批持久化", () => {
  test("工具内等审批：账本记下调用上下文，审批返回后清除", async () => {
    const taskStore = new TaskStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "gate", description: "gated tool", timeoutMs: 0,
      execute: async (_args, runtime) => {
        const answer = await runtime!.requestHuman!("确认执行受限操作？", runtime!.signal!);
        return { answer };
      },
    });
    const { agent } = setup([call("gate", { target: "a.txt" }), reply("完成")], { tools, taskStore });
    let observed: unknown;
    const result = await agent.run("执行受限操作", {
      signal: new AbortController().signal,
      requestHuman: async () => {
        observed = taskStore.current()?.waiting;
        return "y";
      },
    } satisfies ToolRuntime);
    // 用原始值断言而不是 toMatchObject+expect.any()：后者的匹配器标记会污染 received，再读就是脏值
    const recorded = observed as {
      kind: string; prompt: string;
      call: { tool: string; arguments: string; actionId: string; callId: string; runId: string; startedAt: string };
    };
    expect(recorded.kind).toBe("approval");
    expect(recorded.prompt).toBe("确认执行受限操作？");
    expect(recorded.call.tool).toBe("gate");
    expect(recorded.call.arguments).toBe(JSON.stringify({ target: "a.txt" }));
    expect(recorded.call.callId).toBe("call-1");
    expect(typeof recorded.call.actionId).toBe("string");
    expect(typeof recorded.call.startedAt).toBe("string");
    expect(recorded.call.runId).toBe(result.task!.runs[0]!.id);
    expect(taskStore.current()?.waiting).toBeUndefined();
  });

  test("工具内等澄清输入：同样记下调用上下文（kind=input）", async () => {
    const taskStore = new TaskStore();
    const tools = new ToolRegistry();
    tools.register({
      name: "clarify", description: "asks user", timeoutMs: 0,
      execute: async (_args, runtime) => {
        const answer = await runtime!.askUser!("部署到哪个环境？", runtime!.signal!);
        return { answer };
      },
    });
    const { agent } = setup([call("clarify"), reply("完成")], { tools, taskStore });
    let observed: unknown;
    await agent.run("部署", {
      signal: new AbortController().signal,
      askUser: async () => {
        observed = taskStore.current()?.waiting;
        return "生产";
      },
    } satisfies ToolRuntime);
    expect(observed).toMatchObject({
      kind: "input", prompt: "部署到哪个环境？",
      call: { tool: "clarify", actionId: expect.any(String) },
    });
  });

  test("进程重启恢复：属主死后 clearStaleWaiting 清掉遗留标记、保留 interrupted 态", async () => {
    const root = await tempDir("approval-persist-");
    const file = path.join(root, "task.sqlite");
    const store = new TaskStore(file);
    store.begin("原任务");
    store.setWaiting({ kind: "approval", prompt: "确认执行脚本？", call: {
      actionId: "a1", callId: "c1", tool: "run_script", arguments: "{\"script\":\"ls\"}",
      runId: store.current()!.runs[0]!.id, startedAt: new Date().toISOString(),
    } });
    seedRecoveredWithoutOwner(file);

    const revived = new TaskStore(file).current()!;
    expect(revived.state).toBe("interrupted");
    expect(revived.waiting?.call?.tool).toBe("run_script");

    const cleared = new TaskStore(file).clearStaleWaiting()!;
    expect(cleared.waiting).toBeUndefined();
    expect(cleared.state).toBe("interrupted");
  });

  test("属主还活着（审批在飞）：clearStaleWaiting 不清", async () => {
    const root = await tempDir("approval-persist-live-");
    const file = path.join(root, "task.sqlite");
    const live = new TaskStore(file);
    live.begin("进行中的任务");
    live.setWaiting({ kind: "approval", prompt: "确认执行？" });
    const untouched = new TaskStore(file).clearStaleWaiting()!;
    expect(untouched.waiting?.prompt).toBe("确认执行？");
    live.release();
  });

  test("Web 重连恢复：subscribe 发 approval_recovered 并清标记，二次订阅不重复", async () => {
    const dir = await tempDir("approval-recover-web-");
    const sessionStore = new SessionStore({ dir, sessionId: "s1" });
    await sessionStore.append({ role: "user", content: "hi" });
    const taskFile = path.join(dir, "tasks", "s1.sqlite");
    const store = new TaskStore(taskFile);
    store.begin("原任务");
    store.setWaiting({ kind: "approval", prompt: "确认执行脚本？", call: {
      actionId: "a1", callId: "c1", tool: "run_script", arguments: "echo hi",
      runId: store.current()!.runs[0]!.id, startedAt: new Date().toISOString(),
    } });
    seedRecoveredWithoutOwner(taskFile);

    const hub = new EventHub();
    const bridge = new UiBridge(hub.publish, 5_000);
    const runtime = {
      config: { model: "default-model", stream: false },
      registry: new ToolRegistry(), skills: [], sandbox: { backend: "host", reason: "test" },
      sandboxRoot: dir, mcp: { getStatus: () => [], closeAll: async () => {} },
    } as unknown as ConstructorParameters<typeof SessionManager>[0]["runtime"];
    const manager = new SessionManager({ hub, bridge, runtime, sessionDir: dir, traceDir: path.join(dir, "trace") });

    const events: ServerEvent[] = [];
    const off = manager.subscribe("s1", (event) => events.push(event));
    await waitFor(() => events.some((e) => e.type === "task_update"), "task_update");
    const recovered = events.find((e) => e.type === "approval_recovered") as
      | Extract<ServerEvent, { type: "approval_recovered" }>
      | undefined;
    expect(recovered).toMatchObject({ kind: "approval", message: "确认执行脚本？",
      toolName: "run_script", arguments: "echo hi", goal: "原任务" });
    const update = events.find((e) => e.type === "task_update") as Extract<ServerEvent, { type: "task_update" }>;
    expect(update.task.waiting).toBeUndefined();
    expect(new TaskStore(taskFile).current()?.waiting).toBeUndefined();
    off();

    const events2: ServerEvent[] = [];
    const off2 = manager.subscribe("s1", (event) => events2.push(event));
    await waitFor(() => events2.some((e) => e.type === "task_update"), "task_update(2)");
    expect(events2.some((e) => e.type === "approval_recovered")).toBe(false);
    off2();
  });
});
