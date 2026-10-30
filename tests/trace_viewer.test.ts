// tests/trace_viewer.test.ts
// 轨迹读取接口（🕘 面板的数据源）：按会话前缀列文件、按行边界增量读、
// 单条事件的载荷截断与超长行跳过、非法文件名/缺失文件的状态码。
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventHub, SessionManager } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import { loadAgentConfig } from "../src/config";
import type { ServerRuntime } from "../src/server/runtime";
import { listSessionTraces, readTraceChunk, TraceViewError } from "../src/server/trace_viewer";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-viewer-"));
  dirs.push(dir);
  return dir;
}

function event(type: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ts: "2026-10-30T00:00:00.000Z", type, ...extra })}\n`;
}

async function writeTrace(dir: string, file: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), body, "utf-8");
}

async function expectViewError(promise: Promise<unknown>, status: 400 | 404): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TraceViewError);
    expect((error as TraceViewError).status).toBe(status);
    return;
  }
  throw new Error(`期望 TraceViewError(${status})，实际成功返回`);
}

test("列文件：只认 <sessionId>-*.jsonl，带 run_start 标题，最新在前", async () => {
  const dir = await tempDir();
  const older = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  const newer = "sess-a-2026-10-02T00-00-00-000Z.jsonl";
  await writeTrace(dir, older, event("run_start", { userMessage: "  看看反诈数据\n  第二行  " }));
  await writeTrace(dir, newer, event("step", { index: 1 }));
  await writeTrace(dir, "sess-b-2026-10-03T00-00-00-000Z.jsonl", event("run_start"));
  await writeTrace(dir, "sess-a.jsonl", event("run_start"));
  await writeTrace(dir, "notes.txt", "x");
  // 显式设置 mtime，避免同一毫秒内两文件排序不稳
  await fs.utimes(path.join(dir, older), new Date("2026-10-01"), new Date("2026-10-01"));
  await fs.utimes(path.join(dir, newer), new Date("2026-10-02"), new Date("2026-10-02"));

  const list = await listSessionTraces(dir, "sess-a");
  expect(list.map((item) => item.file)).toEqual([newer, older]);
  expect(list[0]!.label).toBeUndefined();
  expect(list[1]!.label).toBe("看看反诈数据 第二行");
  expect(list[1]!.sizeBytes).toBeGreaterThan(0);
  expect(typeof list[1]!.modified).toBe("string");
});

test("列文件：目录不存在、会话 id 非法都返回空列表而不是抛错", async () => {
  expect(await listSessionTraces(path.join(os.tmpdir(), "trace-viewer-missing"), "sess-a")).toEqual([]);
  const dir = await tempDir();
  await writeTrace(dir, "sess-a-2026-10-01T00-00-00-000Z.jsonl", event("run_start"));
  expect(await listSessionTraces(dir, "../etc")).toEqual([]);
});

test("读守卫：非法会话 id、越界文件名、非本会话文件都按 400 拒绝", async () => {
  const dir = await tempDir();
  await writeTrace(dir, "sess-a-2026-10-01T00-00-00-000Z.jsonl", event("run_start"));
  await writeTrace(dir, "sess-b-2026-10-01T00-00-00-000Z.jsonl", event("run_start"));

  await expectViewError(readTraceChunk(dir, "..", "x.jsonl"), 400);
  await expectViewError(readTraceChunk(dir, "sess-a", "../../etc/passwd.jsonl"), 400);
  await expectViewError(readTraceChunk(dir, "sess-a", "sess-a-../../x.jsonl"), 400);
  await expectViewError(readTraceChunk(dir, "sess-a", "sess-b-2026-10-01T00-00-00-000Z.jsonl"), 400);
  await expectViewError(readTraceChunk(dir, "sess-a", "sess-a-notes.txt"), 400);
});

test("读缺失文件：404；目录存在但文件被清掉也 404", async () => {
  const dir = await tempDir();
  await expectViewError(readTraceChunk(dir, "sess-a", "sess-a-2026-10-01T00-00-00-000Z.jsonl"), 404);
});

test("增量读：首拉拿全量与偏移，续拉无新内容为空，追加后只回新事件", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  await writeTrace(dir, file, event("run_start") + event("tool_start", { name: "rag_search" }) + event("tool_end"));

  const first = await readTraceChunk(dir, "sess-a", file);
  expect(first.events.map((item) => item.type)).toEqual(["run_start", "tool_start", "tool_end"]);
  expect(first.offset).toBe(first.size);
  expect(first.reset).toBe(false);

  const idle = await readTraceChunk(dir, "sess-a", file, first.offset);
  expect(idle.events).toEqual([]);
  expect(idle.offset).toBe(first.size);

  await fs.appendFile(path.join(dir, file), event("step", { index: 2 }), "utf-8");
  const next = await readTraceChunk(dir, "sess-a", file, first.offset);
  expect(next.events.map((item) => item.type)).toEqual(["step"]);
  expect(next.offset).toBe(next.size);
  expect(next.size).toBeGreaterThan(first.size);
});

test("半行不消费：写到一半的 JSON 留到下次，写完后再给", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  const head = event("run_start");
  await writeTrace(dir, file, head + '{"ts":"2026-10-30T00:00:01.000Z","type":"run_e');

  const partial = await readTraceChunk(dir, "sess-a", file);
  expect(partial.events.map((item) => item.type)).toEqual(["run_start"]);
  expect(partial.offset).toBe(Buffer.byteLength(head, "utf-8"));

  await fs.appendFile(path.join(dir, file), 'nd"}\n', "utf-8");
  const done = await readTraceChunk(dir, "sess-a", file, partial.offset);
  expect(done.events.map((item) => item.type)).toEqual(["run_end"]);
  expect(done.offset).toBe(done.size);
});

test("末尾完整但缺换行：照常给出并消费到文件末尾", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  const line = JSON.stringify({ ts: "2026-10-30T00:00:00.000Z", type: "step", index: 1 });
  await writeTrace(dir, file, line);

  const chunk = await readTraceChunk(dir, "sess-a", file);
  expect(chunk.events.map((item) => item.type)).toEqual(["step"]);
  expect(chunk.offset).toBe(chunk.size);

  const again = await readTraceChunk(dir, "sess-a", file, chunk.offset);
  expect(again.events).toEqual([]);
});

test("坏行跳过但仍推进偏移，不影响后面的正常事件", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  await writeTrace(dir, file, event("run_start") + "not json\n" + event("run_end"));

  const chunk = await readTraceChunk(dir, "sess-a", file);
  expect(chunk.events.map((item) => item.type)).toEqual(["run_start", "run_end"]);
  expect(chunk.offset).toBe(chunk.size);
});

test("载荷截断：长字符串 2000 字、数组 40 项、超过 5 层嵌套都收缩并标 truncated", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  await writeTrace(
    dir,
    file,
    event("tool_end", {
      output: "x".repeat(2_500),
      items: Array.from({ length: 60 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
    })
  );

  const chunk = await readTraceChunk(dir, "sess-a", file);
  const payload = chunk.events[0]!;
  expect(payload.truncated).toBe(true);
  const output = payload.data["output"] as string;
  expect(output).toHaveLength(2_001);
  expect(output.endsWith("…")).toBe(true);
  expect(payload.data["items"]).toHaveLength(40);
  const deep = payload.data["deep"] as Record<string, any>;
  expect(deep.a.b.c.d).toBe("…");
});

test("偏移越界：after 超过文件长度时 reset 并从 0 重读", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  await writeTrace(dir, file, event("run_start"));

  const chunk = await readTraceChunk(dir, "sess-a", file, 999_999);
  expect(chunk.reset).toBe(true);
  expect(chunk.events.map((item) => item.type)).toEqual(["run_start"]);
  expect(chunk.offset).toBe(chunk.size);
});

test("偏移不落在行边界：同样 reset 从 0 重读，不静默漏掉半条事件", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  await writeTrace(dir, file, event("run_start") + event("tool_end"));

  const chunk = await readTraceChunk(dir, "sess-a", file, 5);
  expect(chunk.reset).toBe(true);
  expect(chunk.events.map((item) => item.type)).toEqual(["run_start", "tool_end"]);
});

test("超长单行：超过读窗口的事件跳过并给 oversize 提示，偏移越过该行", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  const huge = event("tool_progress", { data: "x".repeat(300 * 1024) });
  await writeTrace(dir, file, huge + event("tool_end"));

  const chunk = await readTraceChunk(dir, "sess-a", file);
  expect(chunk.events).toHaveLength(1);
  expect(chunk.events[0]!.type).toBe("oversize");
  expect(chunk.events[0]!.truncated).toBe(true);
  expect(chunk.offset).toBe(Buffer.byteLength(huge, "utf-8"));

  const next = await readTraceChunk(dir, "sess-a", file, chunk.offset);
  expect(next.events.map((item) => item.type)).toEqual(["tool_end"]);
});

test("单次响应限 2000 条：一次吃不完，下一次从上次偏移接着读", async () => {
  const dir = await tempDir();
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  const body = Array.from({ length: 2_100 }, (_, index) => event("step", { index })).join("");
  await writeTrace(dir, file, body);

  const first = await readTraceChunk(dir, "sess-a", file);
  expect(first.events).toHaveLength(2_000);
  expect(first.offset).toBeLessThan(first.size);

  const second = await readTraceChunk(dir, "sess-a", file, first.offset);
  expect(second.events).toHaveLength(100);
  expect(second.offset).toBe(second.size);
});

test("SessionManager 接口：列文件与增量读走同一套实现，错误原样抛出", async () => {
  const dir = await tempDir();
  const traceDir = path.join(dir, "traces");
  const file = "sess-a-2026-10-01T00-00-00-000Z.jsonl";
  await fs.mkdir(traceDir, { recursive: true });
  await writeTrace(traceDir, file, event("run_start", { userMessage: "你好" }));

  const hub = new EventHub();
  const bridge = new UiBridge(hub.publish, 5_000);
  const runtime = {
    config: { ...loadAgentConfig(), model: "default-model", stream: false, checkpointsEnabled: false },
    mcp: {},
    sandbox: { backend: "host", reason: "test" },
    sandboxRoot: dir,
  } as unknown as ServerRuntime;
  const manager = new SessionManager({ hub, bridge, runtime, sessionDir: dir, traceDir });

  const list = await manager.listTraces("sess-a");
  expect(list.traces.map((item) => item.file)).toEqual([file]);
  expect(list.traces[0]!.label).toBe("你好");

  const chunk = await manager.readTrace("sess-a", file);
  expect(chunk.events.map((item) => item.type)).toEqual(["run_start"]);

  await expectViewError(manager.readTrace("sess-a", "sess-b-x.jsonl"), 400);
});
