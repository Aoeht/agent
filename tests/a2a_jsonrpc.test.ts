// tests/a2a_jsonrpc.test.ts
// 第 2+3 层联测：A2aOperations（fake runner 注入，不开真模型）经 handleA2aPost 走完整 JSON-RPC 报文
import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { A2aOperations } from "../src/a2a/operations";
import { handleA2aPost, type A2aTransport } from "../src/a2a/jsonrpc";
import { TaskStore } from "../src/a2a/task_store";
import type { A2aTaskRunner } from "../src/a2a/runner";

const dirs: string[] = [];

function makeTransport(overrides: Partial<A2aTaskRunner> = {}): A2aTransport {
  const dir = mkdtempSync(path.join(tmpdir(), "a2a-jsonrpc-test-"));
  dirs.push(dir);
  const store = new TaskStore(dir);
  const runner: A2aTaskRunner = {
    run: async (input) => {
      void input;
      return { finalAnswer: "fake answer", stopReason: "answer", errorMessage: undefined };
    },
    ...overrides,
  };
  return new A2aOperations({ store, runner, taskTimeoutMs: 5_000 });
}

function post(transport: A2aTransport, envelope: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleA2aPost(new Request("http://127.0.0.1:8787/a2a", {
    method: "POST",
    headers: { "content-type": "application/a2a+json", "a2a-version": "1.0", ...headers },
    body: JSON.stringify(envelope),
  }), { transport });
}

function sendMessageEnvelope(id: number | string, text = "你好", extra: Record<string, unknown> = {}): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "SendMessage",
    params: { message: { role: "ROLE_USER", messageId: `m-${id}`, parts: [{ text }] }, ...extra },
  };
}

describe("A2A JSON-RPC 绑定", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("缺 A2A-Version 头 → -32009（缺头视为 0.3，明确拒绝）", async () => {
    const transport = makeTransport();
    const response = await handleA2aPost(new Request("http://x/a2a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sendMessageEnvelope(1)),
    }), { transport });
    const body = (await response.json()) as { error?: { code: number; data?: Array<{ reason?: string }> } };
    expect(body.error?.code).toBe(-32009);
    expect(body.error?.data?.[0]?.reason).toBe("VERSION_NOT_SUPPORTED");
  });

  test("支持 1.0.x patch 声明（Major 匹配即可）", async () => {
    const transport = makeTransport();
    const response = await post(transport, sendMessageEnvelope(1), { "a2a-version": "1.0.1" });
    const body = (await response.json()) as { result?: { task?: { status?: { state?: string } } } };
    expect(body.result?.task?.status?.state).toBe("TASK_STATE_COMPLETED");
  });

  test("SendMessage 阻塞到终态，产物是 fake runner 的答案", async () => {
    const response = await post(makeTransport(), sendMessageEnvelope(1));
    const body = (await response.json()) as {
      result?: { task?: { id: string; contextId: string; status: { state: string; timestamp?: string }; artifacts?: Array<{ parts: Array<{ text: string }> }> } };
    };
    const task = body.result!.task!;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.status.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(task.artifacts![0]!.parts[0]!.text).toBe("fake answer");
    expect(task.id).not.toBe("");
    expect(task.contextId).not.toBe("");
  });

  test("未知方法 → -32601；坏信封 → -32700", async () => {
    const transport = makeTransport();
    const unknown = await (await post(transport, { jsonrpc: "2.0", id: 2, method: "Nope" })).json() as { error?: { code: number } };
    expect(unknown.error?.code).toBe(-32601);
    const bad = await (await post(transport, { method: "SendMessage" })).json() as { error?: { code: number } };
    expect(bad.error?.code).toBe(-32700);
  });

  test("GetTask 未找到 → -32001 + ErrorInfo reason；不泄露存在性", async () => {
    const response = await post(makeTransport(), { jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: "nope" } });
    const body = (await response.json()) as { error?: { code: number; message: string; data?: Array<{ "@type"?: string; reason?: string }> } };
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.data?.[0]?.["@type"]).toContain("google.rpc.ErrorInfo");
    expect(body.error?.data?.[0]?.reason).toBe("TASK_NOT_FOUND");
  });

  test("终态任务取消 → -32002；进行中任务取消 → runner 收到 abort", async () => {
    let abortSeen = false;
    const transport = makeTransport({
      run: (input) => new Promise((resolve) => {
        input.signal.addEventListener("abort", () => {
          abortSeen = true;
          resolve({ finalAnswer: null, stopReason: "cancelled", errorMessage: undefined });
        });
      }),
    });
    // 起一个不阻塞的任务（returnImmediately=true），随后取消
    await post(transport, sendMessageEnvelope(10, "hi", { returnImmediately: true }));
    // 拿任务 ID：通过 ListTasks
    const list = await (await post(transport, { jsonrpc: "2.0", id: 11, method: "ListTasks", params: {} })).json() as {
      result?: { tasks?: Array<{ id: string; status: { state: string } }> };
    };
    const task = list.result!.tasks![0]!;
    expect(task.status.state).toBe("TASK_STATE_WORKING");
    const cancelResponse = await post(transport, { jsonrpc: "2.0", id: 12, method: "CancelTask", params: { id: task.id } });
    const cancelBody = (await cancelResponse.json()) as { result?: { status?: { state?: string } } };
    expect(cancelBody.result).toBeDefined();
    expect(abortSeen).toBe(true);
    // 等 run 走完终态
    await new Promise((resolve) => setTimeout(resolve, 50));
    const final = await (await post(transport, { jsonrpc: "2.0", id: 13, method: "GetTask", params: { id: task.id } })).json() as {
      result?: { task?: { status?: { state?: string } } };
    };
    expect(final.result!.task!.status!.state).toBe("TASK_STATE_CANCELED");
  });

  test("ListTasks：timestamp 降序、默认省略 artifacts、nextPageToken 空串结尾", async () => {
    const transport = makeTransport();
    for (const id of [1, 2, 3]) {
      await post(transport, sendMessageEnvelope(id, `msg-${id}`));
    }
    const page = await (await post(transport, { jsonrpc: "2.0", id: 20, method: "ListTasks", params: { pageSize: 2 } })).json() as {
      result?: { tasks?: Array<{ id: string; artifacts?: unknown }>; nextPageToken?: string };
    };
    expect(page.result!.tasks).toHaveLength(2);
    for (const task of page.result!.tasks!) {
      // includeArtifacts 缺省 false：字段整体省略，不是空数组（规范 2.5）
      expect("artifacts" in task).toBe(false);
    }
    expect(page.result!.nextPageToken).not.toBe("");
    const page2 = await (await post(transport, { jsonrpc: "2.0", id: 21, method: "ListTasks", params: { pageSize: 2, pageToken: page.result!.nextPageToken } })).json() as {
      result?: { tasks?: unknown[]; nextPageToken?: string };
    };
    expect(page2.result!.tasks).toHaveLength(1);
    expect(page2.result!.nextPageToken).toBe("");
    // includeArtifacts=true 时 artifacts 回来
    const withArtifacts = await (await post(transport, { jsonrpc: "2.0", id: 22, method: "ListTasks", params: { includeArtifacts: true } })).json() as {
      result?: { tasks?: Array<{ artifacts?: unknown }> };
    };
    for (const task of withArtifacts.result!.tasks!) {
      expect(Array.isArray(task.artifacts)).toBe(true);
    }
  });

  test("工作中的任务收到带 taskId 的后续消息 → -32602（攒到终态再发，不私有排队）", async () => {
    let release: (() => void) | undefined;
    const transport = makeTransport({
      run: () => new Promise((resolve) => {
        // 挂住第一个 run，直到测试放行
        release = () => resolve({ finalAnswer: "done", stopReason: "answer", errorMessage: undefined });
      }),
    });
    try {
      await post(transport, sendMessageEnvelope(30, "第一条", { returnImmediately: true }));
      const first = await (await post(transport, { jsonrpc: "2.0", id: 31, method: "ListTasks", params: {} })).json() as {
        result?: { tasks?: Array<{ id: string; contextId: string }> };
      };
      const running = first.result!.tasks![0]!;
      expect(running.contextId).not.toBe("");
      // 显式引用进行中的 taskId：明确拒绝
      const rejected = await (await post(transport, {
        jsonrpc: "2.0",
        id: 32,
        method: "SendMessage",
        params: { message: { role: "ROLE_USER", messageId: "m-32", parts: [{ text: "第二条" }], taskId: running.id } },
      })).json() as { error?: { code: number } };
      expect(rejected.error?.code).toBe(-32602);
      // 只带 contextId（不带 taskId）：按规范开新任务，允许（returnImmediately 避免测试挂住）
      const fresh = await (await post(transport, {
        jsonrpc: "2.0",
        id: 33,
        method: "SendMessage",
        params: { message: { role: "ROLE_USER", messageId: "m-33", parts: [{ text: "新任务" }], contextId: running.contextId }, returnImmediately: true },
      })).json() as { error?: { code: number }; result?: { task?: { contextId: string } } };
      expect(fresh.error).toBeUndefined();
      expect(fresh.result!.task!.contextId).toBe(running.contextId);
    } finally {
      release?.();
    }
  });

  test("SendStreamingMessage：首事件 Task 快照 → WORKING → artifact → 终态 → 关流", async () => {
    const transport = makeTransport();
    const response = await post(transport, {
      jsonrpc: "2.0",
      id: 40,
      method: "SendStreamingMessage",
      params: { message: { role: "ROLE_USER", messageId: "m-40", parts: [{ text: "流式" }] } },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const raw = await response.text();
    const events = raw.split("\n\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)) as { result?: Record<string, unknown> });
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect("task" in events[0]!.result!).toBe(true);
    expect("statusUpdate" in events[1]!.result!).toBe(true);
    const statuses = events.map((event) => (event.result && "statusUpdate" in event.result ? (event.result.statusUpdate as { status: { state: string } }).status.state : undefined)).filter(Boolean);
    expect(statuses[0]).toBe("TASK_STATE_WORKING");
    expect(statuses[statuses.length - 1]).toBe("TASK_STATE_COMPLETED");
    // v1.0：没有 kind、没有 final 字段
    expect(raw).not.toContain('"kind"');
    expect(raw).not.toContain('"final"');
  });

  test("推送通知四方法 → -32004（能力未实现，如实拒绝）", async () => {
    const transport = makeTransport();
    for (const method of ["CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"]) {
      const body = await (await post(transport, { jsonrpc: "2.0", id: 50, method, params: {} })).json() as { error?: { code: number } };
      expect(body.error?.code).toBe(-32004);
    }
  });

  test("runner 抛错 → 任务转 FAILED，异常不穿透到传输层", async () => {
    const transport = makeTransport({
      run: async () => {
        throw new Error("装配失败");
      },
    });
    const body = await (await post(transport, sendMessageEnvelope(60))).json() as {
      result?: { task?: { status?: { state?: string; message?: { parts?: Array<{ text: string }> } } } };
    };
    expect(body.result!.task!.status!.state).toBe("TASK_STATE_FAILED");
    expect(body.result!.task!.status!.message!.parts![0]!.text).toContain("装配失败");
  });
});
