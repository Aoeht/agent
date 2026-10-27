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
  // Windows 上被杀/刚退出的子进程可能短暂占着日志文件句柄，删除重试几次
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

test("日志窗口：首帧取尾部快照，随后按 offset 续拉增量且停在字符边界", async () => {
  const { workDir, jobs, run } = await setup("job-log-");
  await fs.writeFile(
    path.join(workDir, "grow.js"),
    `(async () => {
      for (let i = 1; i <= 3; i++) { console.log("line-" + i); await Bun.sleep(150); }
      console.error("err-line");
    })();`,
    "utf-8"
  );
  const started = (await run.execute(
    { script: "grow.js", background: true },
    { requestHuman: allow }
  )) as unknown as { job_id: string };

  const first = await jobs.readLog(started.job_id, "stdout");
  expect(first.reset).toBe(true);
  expect(first.size).toBeGreaterThanOrEqual(0);

  // 从首帧拿到的 offset 续拉，条件轮询到三行都到齐
  let offset = first.offset;
  const chunks = [first.text];
  await waitFor("按偏移续拉到 line-3", async () => {
    const chunk = await jobs.readLog(started.job_id, "stdout", { after: offset });
    expect(chunk.reset).toBe(false);
    offset = chunk.offset;
    chunks.push(chunk.text);
    return chunks.join("").includes("line-3") ? true : undefined;
  });
  expect(chunks.join("")).toContain("line-1");

  // 等进程真正退出再断言"无新增"，顺带让子进程释放日志句柄（Windows 清理依赖它）
  await waitFor("任务退出", async () => {
    const record = await jobs.get(started.job_id);
    return record?.status === "exited" ? record : undefined;
  });

  // 已无新增：同一 offset 再拉是空帧
  const idle = await jobs.readLog(started.job_id, "stdout", { after: offset });
  expect(idle.text).toBe("");
  expect(idle.offset).toBe(offset);

  // 多字节字符被切在窗口边界时留给下一帧，不吐出半截
  const splitId = "job-19700101-000000-utf8";
  const huge = "a".repeat(32_767) + "中";
  await fs.writeFile(jobs.paths(splitId).stdout, huge, "utf-8");
  const head = await jobs.readLog(splitId, "stdout", { after: 0 });
  expect(head.text).toBe("a".repeat(32_767));
  expect(head.offset).toBe(32_767);
  const rest = await jobs.readLog(splitId, "stdout", { after: head.offset });
  expect(rest.text).toBe("中");
  expect(rest.offset).toBe(Buffer.byteLength(huge));

  // 未知任务的文件不存在：空内容而不是抛错
  const missing = await jobs.readLog("job-19700101-000000-none", "stderr");
  expect(missing.text).toBe("");
  expect(missing.size).toBe(0);
});

test("kill 终止指定任务并标 killed；重复调用幂等", async () => {
  const { workDir, jobs, run, inspect } = await setup("job-kill-one-");
  await fs.writeFile(path.join(workDir, "stay3.js"), `setTimeout(() => {}, 60_000);`, "utf-8");
  const started = (await run.execute(
    { script: "stay3.js", background: true, timeout_ms: 60_000 },
    { requestHuman: allow }
  )) as unknown as { job_id: string };

  await waitFor("任务已在运行", async () => {
    const view = (await inspect.execute({ job_id: started.job_id }, {})) as unknown as JobView;
    return view.status === "running" ? view : undefined;
  });

  const killed = await jobs.kill(started.job_id);
  expect(killed?.status).toBe("killed");
  expect(killed?.endedAt).toBeGreaterThan(0);

  const again = await jobs.kill(started.job_id);
  expect(again?.status).toBe("killed");
  expect(again?.endedAt).toBe(killed?.endedAt);
  expect(await jobs.kill("job-19700101-000000-none")).toBeUndefined();
});
