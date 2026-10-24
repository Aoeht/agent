// web/tests/queue.test.ts
// 会话消息队列的前端状态迁移（applyEvent 纯函数部分）：
//   - queue_changed 全量替换队列
//   - run_start 带 queueId：芯片移除 + 正式用户气泡进入聊天流 + 记录 lastRunQueueId
//   - run_start 不带 queueId（立即执行路径）：不加气泡（气泡由 user_sent 先加）
import { expect, test } from "bun:test";
import { applyEvent, type SessionUIState } from "../src/state/store";

const idle: SessionUIState = { items: [], plan: [], status: "idle" };

test("queue_changed 全量替换队列", () => {
  const withQueue = applyEvent(idle, {
    type: "queue_changed",
    items: [
      { id: "q1", text: "第一条排队" },
      { id: "q2", text: "第二条排队" },
    ],
  });
  expect(withQueue.queue).toHaveLength(2);
  const drained = applyEvent(withQueue, { type: "queue_changed", items: [] });
  expect(drained.queue).toEqual([]);
});

test("run_start 带 queueId：芯片转气泡", () => {
  const queued = applyEvent(
    { ...idle, queue: [{ id: "q1", text: "排队消息" }] },
    { type: "run_start", userMessage: "排队消息", queueId: "q1" }
  );
  expect(queued.queue).toEqual([]);
  expect(queued.lastRunQueueId).toBe("q1");
  expect(queued.status).toBe("running");
  // 用户气泡此刻才进入聊天流（发送时忙，没有本地回显）
  expect(queued.items).toHaveLength(1);
  expect(queued.items[0]).toMatchObject({ kind: "user", text: "排队消息" });
  expect(queued.runStartIndex).toBe(1);
});

test("run_start 不带 queueId：不加气泡、不动队列", () => {
  const withQueue = { ...idle, queue: [{ id: "q1", text: "排队消息" }] };
  const started = applyEvent(withQueue, { type: "run_start", userMessage: "立即执行的消息" });
  expect(started.items).toEqual([]); // 气泡由 user_sent 本地回显，这里不重复加
  expect(started.queue).toEqual(withQueue.queue);
  expect(started.status).toBe("running");
});
