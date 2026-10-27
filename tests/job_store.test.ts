// 后台脚本任务：run_script 的 background 分支 + job_output 的轮询面。
// 用真实子进程验证：立即返回、运行中可读输出、到点回收、列表、关停收口。
// 运行：bun test tests/job_store.test.ts
import { test, expect, afterAll } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobStore } from "../src/core/job_store";
import { createRunScriptTool } from "../src/tools/run_script";
import { createJobOutputTool } from "../src/tools/job_output";

const allow = async () => "y";
const roots: string[] = [];

interface JobView {
  job_id: string;
  status: string;
  exit_code?: number;
  stdout_tail: string;
  stderr_tail: string;
  elapsed_ms: number;
  timeout_ms: number;
}

interface JobList {
  jobs: Array<{ job_id: string; status: string; script: string }>;
}

/** 条件轮询：测试不用固定 sleep，条件满足即返回（项目测试纪律） */
async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

async function setup(prefix: string) {
  const root = await fs.mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  const workDir = path.join(root, "work");
  await fs.mkdir(workDir, { recursive: true });
  const jobs = new JobStore(path.join(root, "jobs"));
  await jobs.init();
  const run = createRunScriptTool({ sandboxRoot: workDir, jobs });
  const inspect = createJobOutputTool(jobs);
  return { workDir, jobs, run, inspect };
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

test("background 立即返回 job_id，轮询到结束后能拿到退出码与输出", async () => {
  const { workDir, run, inspect } = await setup("job-finish-");
  await fs.writeFile(
    path.join(workDir, "tick.js"),
    `(async () => {
      for (let i = 1; i <= 3; i++) { console.log("tick " + i); await Bun.sleep(120); }
      console.error("done");
    })();`,
    "utf-8"
  );

  const startedAt = Date.now();
  const started = (await run.execute(
    { script: "tick.js", background: true },
    { requestHuman: allow }
  )) as unknown as { job_id: string; status: string; stdout_log: string };
  const returnMs = Date.now() - startedAt;

  expect(returnMs).toBeLessThan(2_000); // 阻塞式执行要等脚本跑完，后台模式必须立刻回来
  expect(started.job_id).toMatch(/^job-/);
  expect(started.status).toBe("running");

  const finished = await waitFor("任务结束", async () => {
    const view = (await inspect.execute({ job_id: started.job_id }, {})) as unknown as JobView;
    return view.status !== "running" ? view : undefined;
  });

  expect(finished.status).toBe("exited");
  expect(finished.exit_code).toBe(0);
  expect(finished.stdout_tail).toContain("tick 3");
  expect(finished.stderr_tail).toContain("done");
  expect(finished.elapsed_ms).toBeGreaterThanOrEqual(300);
});

test("运行中就能读到已产出的输出（不必等结束）", async () => {
  const { workDir, jobs, run, inspect } = await setup("job-tail-");
  await fs.writeFile(
    path.join(workDir, "stay.js"),
    `console.log("started"); setTimeout(() => {}, 20_000);`,
    "utf-8"
  );

  const started = (await run.execute(
    { script: "stay.js", background: true, timeout_ms: 60_000 },
    { requestHuman: allow }
  )) as unknown as { job_id: string };

  const running = await waitFor("运行中且已有输出", async () => {
    const view = (await inspect.execute({ job_id: started.job_id }, {})) as unknown as JobView;
    return view.status === "running" && view.stdout_tail.includes("started") ? view : undefined;
  });
  expect(running.exit_code).toBeUndefined();
  expect(running.stdout_tail).toContain("started");

  await jobs.killAll();
});

test("到截止时间仍在跑：强制终止并标 timed_out / 124", async () => {
  const { workDir, run, inspect } = await setup("job-timeout-");
  await fs.writeFile(path.join(workDir, "hang.js"), `setTimeout(() => {}, 60_000);`, "utf-8");

  const started = (await run.execute(
    { script: "hang.js", background: true, timeout_ms: 1_000 },
    { requestHuman: allow }
  )) as unknown as { job_id: string };

  const expired = await waitFor("超时回收", async () => {
    const view = (await inspect.execute({ job_id: started.job_id }, {})) as unknown as JobView;
    return view.status === "timed_out" ? view : undefined;
  }, 20_000);

  expect(expired.status).toBe("timed_out");
  expect(expired.exit_code).toBe(124);
});

test("不给 job_id 列出最近任务；未知 id 报错", async () => {
  const { workDir, run, inspect } = await setup("job-list-");
  await fs.writeFile(path.join(workDir, "quick.js"), `console.log("hi");`, "utf-8");
  const started = (await run.execute(
    { script: "quick.js", background: true },
    { requestHuman: allow }
  )) as unknown as { job_id: string };

  await waitFor("任务结束", async () => {
    const view = (await inspect.execute({ job_id: started.job_id }, {})) as unknown as JobView;
    return view.status !== "running" ? view : undefined;
  });

  const list = (await inspect.execute({}, {})) as unknown as JobList;
  expect(list.jobs.length).toBe(1);
  expect(list.jobs[0]!.job_id).toBe(started.job_id);
  expect(list.jobs[0]!.script).toBe("quick.js");

  await expect(
    inspect.execute({ job_id: "job-00000000-000000-aaaa" }, {})
  ).rejects.toThrow(/未找到后台任务/);
});

test("killAll 收口所有仍在跑的后台任务", async () => {
  const { workDir, jobs, run, inspect } = await setup("job-kill-");
  await fs.writeFile(path.join(workDir, "stay2.js"), `setTimeout(() => {}, 60_000);`, "utf-8");
  const started = (await run.execute(
    { script: "stay2.js", background: true, timeout_ms: 60_000 },
    { requestHuman: allow }
  )) as unknown as { job_id: string };

  await waitFor("任务已在运行", async () => {
    const view = (await inspect.execute({ job_id: started.job_id }, {})) as unknown as JobView;
    return view.status === "running" ? view : undefined;
  });

  const killed = await jobs.killAll();
  expect(killed).toBeGreaterThanOrEqual(1);

  const view = (await inspect.execute({ job_id: started.job_id }, {})) as unknown as JobView;
  expect(view.status).toBe("killed");
});
