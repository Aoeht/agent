// tests/session_queue.test.ts
// 会话消息队列（Web 服务器侧）：
//   - 忙时发送不再 409：入队等待，当前回合结束后自动按序接续；run_start 对等待过的消息带 queueId
//   - 撤单：只撤排队中的，不影响正在跑的回合；撤不存在的返回 false
//   - 队列上限：第 9 条拒绝
//   - cancel 只停当前回合：排队消息保留并随后接续
// 运行: bun test ./tests/session_queue.test.ts
import { afterEach, expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, EventHub } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import { ToolRegistry } from "../src/core/registry";
import { loadAgentConfig } from "../src/config";
import type { ServerRuntime } from "../src/server/runtime";
import type { ServerEvent } from "../src/server/protocol";

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  // Windows 下 taskStore 的 sqlite 句柄可能晚一拍释放，rm 撞 EBUSY/EPERM：重试兜底
  for (const dir of dirs.splice(0)) {
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 3) {
          console.warn(`[test] 清理失败 ${dir}: ${error instanceof Error ? error.message : error}`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-queue-"));
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
  return { manager, hub, dir };
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

/**
 * 可门控的假 client：主调用（带 tools）第一次等 gate 放行（期间响应 abort），
 * 之后立即应答终答；无 tools 的调用（会话命名/长期摘要）固定应答小结果。
 * 替换进 Agent 私有字段 client —— 与 session_config.test.ts 的做法一致。
 */
function installGatedClient(manager: SessionManager, sessionId: string, gate: Promise<void>) {
  const agent = (manager as any).entries.get(sessionId)!.agent;
  let mainCalls = 0;
  const client: any = {
    chat: {
      completions: {
        create: async (_params: any, options?: { signal?: AbortSignal }) => {
          if (!_params.tools?.length) {
            return {
              choices: [{ message: { content: "短摘要" } }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            };
          }
          mainCalls++;
          if (mainCalls === 1) {
            // 第一次主调用：gate 放行前卡住；期间被 abort 则按取消传播
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => reject(new DOMException("aborted", "AbortError"));
              if (options?.signal?.aborted) return onAbort();
              options?.signal?.addEventListener("abort", onAbort);
              gate.then(resolve, reject);
            });
          }
          return {
            choices: [{ message: { content: `第${mainCalls}次回答` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
  (agent as any).client = client;
  return () => mainCalls;
}

/** 收集本会话的全部 SSE 事件（含 queue_changed / run_start / run_end） */
function collector(manager: SessionManager, sessionId: string): ServerEvent[] {
  const events: ServerEvent[] = [];
  cleanups.push(manager.subscribe(sessionId, event => events.push(event)));
  return events;
}

/** 等 collector 的 hello/队列快照异步回调跑完（此刻队列必然为空，不会混入回放事件） */
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

const kinds = (events: ServerEvent[]) => events.map(event => event.type);

test("忙时发送入队等待，回合结束后自动接续并带 queueId", async () => {
  const { manager } = await fixture();
  await hello(manager, "s1"); // 建 Agent
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installGatedClient(manager, "s1", gate);
  const events = collector(manager, "s1");
  await settle();

  const first = await manager.sendMessage("s1", "第一条");
  expect(first.queued).toBe(false); // 空闲：立即开跑
  const second = await manager.sendMessage("s1", "第二条"); // 第一条被 gate 卡住
  expect(second.queued).toBe(true);
  expect(manager.queueSnapshot("s1")).toEqual([{ id: second.queueId, text: "第二条" }]);

  release();
  await new Promise(resolve => setTimeout(resolve, 150)); // 等两条回合都收尾

  const starts = events.filter(event => event.type === "run_start");
  const ends = events.filter(event => event.type === "run_end");
  expect(starts).toHaveLength(2);
  expect(ends).toHaveLength(2);
  // 等待过的消息 run_start 带 queueId、顺序 FIFO；立即执行的不带
  expect(starts[0]).toMatchObject({ userMessage: "第一条" });
  expect((starts[0] as any).queueId).toBeUndefined();
  expect(starts[1]).toMatchObject({ userMessage: "第二条", queueId: second.queueId });
  // 队列事件：A 入队(1) → 立即出队(0) → B 忙时入队(1) → A 收尾后出队(0)
  const queues = events.filter(event => event.type === "queue_changed");
  expect(queues.map(q => (q as any).items.length)).toEqual([1, 0, 1, 0]);
  expect(manager.queueSnapshot("s1")).toEqual([]);
});

test("撤单只撤排队中的消息，正在跑的回合不受影响", async () => {
  const { manager } = await fixture();
  await hello(manager, "s2");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installGatedClient(manager, "s2", gate);
  const events = collector(manager, "s2");
  await settle();

  await manager.sendMessage("s2", "占住回合的");
  const queuedB = await manager.sendMessage("s2", "要撤的");
  const queuedC = await manager.sendMessage("s2", "留下来的");

  expect(manager.removeQueued("s2", queuedB.queueId)).toBe(true);
  expect(manager.removeQueued("s2", "q-nonexistent")).toBe(false);
  expect(manager.queueSnapshot("s2")).toEqual([{ id: queuedC.queueId, text: "留下来的" }]);

  release();
  await new Promise(resolve => setTimeout(resolve, 150));

  const starts = events.filter(event => event.type === "run_start");
  expect(starts.map(start => (start as any).userMessage)).toEqual(["占住回合的", "留下来的"]);
});

test("队列超过上限拒绝（8 条）", async () => {
  const { manager } = await fixture();
  await hello(manager, "s3");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installGatedClient(manager, "s3", gate);

  await manager.sendMessage("s3", "占住回合的");
  for (let i = 1; i <= 8; i++) await manager.sendMessage("s3", `排队 ${i}`);
  await expect(manager.sendMessage("s3", "第 9 条")).rejects.toThrow("队列已满");
  release();
  await new Promise(resolve => setTimeout(resolve, 150));
});

test("cancel 只停当前回合，排队消息随后接续", async () => {
  const { manager } = await fixture();
  await hello(manager, "s4");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installGatedClient(manager, "s4", gate);
  const events = collector(manager, "s4");
  await settle();

  await manager.sendMessage("s4", "会被取消的");
  const queued = await manager.sendMessage("s4", "取消后接续的");

  manager.cancel("s4");
  await new Promise(resolve => setTimeout(resolve, 100));
  const starts = events.filter(event => event.type === "run_start");
  expect(starts.map(start => (start as any).userMessage)).toEqual(["会被取消的", "取消后接续的"]);
  expect((starts[1] as any).queueId).toBe(queued.queueId);
  const ends = events.filter(event => event.type === "run_end");
  expect(ends[0]).toMatchObject({ success: false });
});
