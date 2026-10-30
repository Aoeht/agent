// 后台任务完成通知：JobStore.onFinished 的触发语义 + EventHub 广播 + 服务器侧接线。
// 用真实子进程验证"结束一次、通知一次"，不 mock spawn。
// 运行：bun test tests/job_notify.test.ts
import { test, expect, afterAll } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobStore, type JobRecord } from "../src/core/job_store";
import { createRunScriptTool } from "../src/tools/run_script";
import { attachJobNotifier } from "../src/server/runtime";
import { EventHub } from "../src/server/sessions";
import type { ServerEvent } from "../src/server/protocol";

const allow = async () => "y";
const roots: string[] = [];

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function setup(prefix: string) {
  const root = await fs.mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  const workDir = path.join(root, "work");
  await fs.mkdir(workDir, { recursive: true });
  const jobs = new JobStore(path.join(root, "jobs"));
  await jobs.init();
  const run = createRunScriptTool({ sandboxRoot: workDir, jobs, sessionId: "session-A" });
  const finishCalls: JobRecord[] = [];
  jobs.onFinished = (record) => finishCalls.push(record);
  return { workDir, jobs, run, finishCalls };
}

async function startBackground(workDir: string, run: ReturnType<typeof createRunScriptTool>, source: string, timeoutMs?: number) {
  const script = `bg-${Math.random().toString(36).slice(2, 8)}.js`;
  await fs.writeFile(path.join(workDir, script), source, "utf-8");
  const result = (await run.execute(
    { script, background: true, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) },
    { requestHuman: allow }
  )) as unknown as { job_id: string };
  return result.job_id;
}

afterAll(async () => {
  for (const root of roots) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
  }
});

test("正常退出：只回调一次，带上退出码与会话 id", async () => {
  const { workDir, jobs, run, finishCalls } = await setup("notify-exit-");
  const id = await startBackground(workDir, run, `console.log("done");`);

  const record = await waitFor("任务结束", async () => {
    const current = await jobs.get(id);
    return current?.status === "exited" ? current : undefined;
  });
  expect(record.exitCode).toBe(0);

  expect(finishCalls).toHaveLength(1);
  expect(finishCalls[0]!.id).toBe(id);
  expect(finishCalls[0]!.status).toBe("exited");
  expect(finishCalls[0]!.exitCode).toBe(0);
  expect(finishCalls[0]!.sessionId).toBe("session-A");

  // 已结束的任务再 kill 不会补第二次回调
  await jobs.kill(id);
  expect(finishCalls).toHaveLength(1);
});

test("kill：回调一次；随后的 close 回填被去重", async () => {
  const { workDir, jobs, run, finishCalls } = await setup("notify-kill-");
  const id = await startBackground(workDir, run, `setTimeout(() => {}, 60_000);`);
  const running = (await jobs.get(id))!;

  await jobs.kill(id);
  expect(finishCalls).toHaveLength(1);
  expect(finishCalls[0]!.status).toBe("killed");

  // 等进程真的消失，让 close 回填跑完；仍不应有第二次回调
  await waitFor("进程退出", async () => (alive(running.pid) ? undefined : true));
  await Bun.sleep(100);
  expect(finishCalls).toHaveLength(1);
});

test("到点回收：回调 status=timed_out / 124", async () => {
  const { workDir, jobs, run, finishCalls } = await setup("notify-timeout-");
  const id = await startBackground(workDir, run, `setTimeout(() => {}, 60_000);`, 1_000);

  await waitFor("超时回收", async () => {
    const current = await jobs.get(id);
    return current?.status === "timed_out" ? true : undefined;
  }, 20_000);

  expect(finishCalls).toHaveLength(1);
  expect(finishCalls[0]!.status).toBe("timed_out");
  expect(finishCalls[0]!.exitCode).toBe(124);
});

test("killAll（关停收口）不触发回调", async () => {
  const { workDir, jobs, run, finishCalls } = await setup("notify-killall-");
  const id = await startBackground(workDir, run, `setTimeout(() => {}, 60_000);`);
  const running = (await jobs.get(id))!;

  await jobs.killAll();
  expect(finishCalls).toHaveLength(0);

  await waitFor("进程退出", async () => (alive(running.pid) ? undefined : true));
  await Bun.sleep(100);
  expect(finishCalls).toHaveLength(0);
});

test("EventHub.publishAll：每个订阅者一次，跨会话可见", () => {
  const hub = new EventHub();
  const a: ServerEvent[] = [];
  const b: ServerEvent[] = [];
  const offA = hub.subscribe("session-a", (event) => a.push(event));
  hub.subscribe("session-b", (event) => b.push(event));

  const event: ServerEvent = {
    type: "job_finished",
    job: { id: "job-20260101-000000-aaaa", script: "x.js", args: [], backend: "host", status: "exited",
      startedAt: 1, deadlineAt: 2, endedAt: 3, exitCode: 0 },
  };
  hub.publishAll(event);
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);

  // 同一个 listener 订阅两个会话时也只收一次
  const shared: ServerEvent[] = [];
  const listener = (e: ServerEvent) => shared.push(e);
  hub.subscribe("session-a", listener);
  hub.subscribe("session-c", listener);
  hub.publishAll(event);
  expect(shared).toHaveLength(1);

  // 退订后不再增长（此时 a 已收 2 次：首播 + shared 那次广播）
  offA();
  hub.publishAll(event);
  expect(a).toHaveLength(2);
  expect(b).toHaveLength(3);
});

test("attachJobNotifier：任务从 A 会话起、B 会话的订阅者也能收到 job_finished", async () => {
  const { workDir, jobs, run } = await setup("notify-broadcast-");
  const hub = new EventHub();
  const seen: ServerEvent[] = [];
  const offA = hub.subscribe("session-A", (event) => seen.push(event));
  const offB = hub.subscribe("session-B", (event) => seen.push(event));
  attachJobNotifier(jobs, hub);

  const id = await startBackground(workDir, run, `console.log("broadcast");`);
  const finished = await waitFor("两边都收到通知", async () => {
    const hits = seen.filter((e) => e.type === "job_finished" && e.job.id === id);
    return hits.length === 2 ? hits : undefined;
  });

  const job = finished[0]!;
  if (job.type !== "job_finished") throw new Error("类型收窄失败");
  expect(job.job.status).toBe("exited");
  expect(job.job.exitCode).toBe(0);
  expect(job.job.sessionId).toBe("session-A");
  offA();
  offB();
});
