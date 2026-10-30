import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import path from "node:path";
import type { JobSummaryDTO } from "@protocol";

// 跨会话后台任务完成通知：job_finished 广播 → 右下角 toast → 跳会话 / 打开任务面板 / 关闭。
// 本地真实浏览器，不连接后端或模型。
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("后台任务完成通知：跨会话 toast、去会话、查看任务与关闭", async () => {
  await withPage(async (page) => {
    // 站在 A 会话里；任务由 B 会话发起
    await page.locator("nav").getByText("通知演示 A").first().click();
    await page.locator("header").getByText("通知演示 A").waitFor();

    await pushJob(page, {
      id: "job-20260105-000000-aaaa",
      script: "scripts/collect.py",
      args: ["--pages", "5"],
      backend: "host",
      status: "exited",
      exitCode: 0,
      startedAt: 1_000,
      deadlineAt: 1_000_000,
      endedAt: 43_000,
      sessionId: "notify-b",
    });

    const toast = page.getByRole("status").filter({ hasText: "后台任务已完成" });
    await toast.waitFor();
    await toast.getByText("scripts/collect.py --pages 5").waitFor();
    await toast.getByText("42s · 宿主机 · 通知演示 B").waitFor();

    // 去会话：跳到来源会话，通知随之关闭
    await toast.getByRole("button", { name: "去会话" }).click();
    await page.locator("header").getByText("通知演示 B").waitFor();
    await expect(toast.count()).resolves.toBe(0);

    // 失败任务：状态带退出码；查看任务打开 🖥️ 面板
    await pushJob(page, {
      id: "job-20260105-000001-bbbb",
      script: "scripts/cleanup.py",
      args: [],
      backend: "docker",
      status: "exited",
      exitCode: 3,
      startedAt: 2_000,
      deadlineAt: 1_000_000,
      endedAt: 8_000,
      sessionId: "notify-a",
    });
    const failed = page.getByRole("status").filter({ hasText: "后台任务失败（退出码 3）" });
    await failed.waitFor();
    await failed.getByText("6s · 容器 · 通知演示 A").waitFor();
    await failed.getByRole("button", { name: "查看任务" }).click();
    const jobsDialog = page.getByRole("dialog", { name: "后台任务" });
    await jobsDialog.waitFor();
    await page.keyboard.press("Escape");
    await expect(jobsDialog.isVisible()).resolves.toBe(false);
    await expect(failed.count()).resolves.toBe(0);

    // 没有来源会话的任务：没有"去会话"按钮，✕ 直接关掉
    await pushJob(page, {
      id: "job-20260105-000002-cccc",
      script: "scripts/watch.sh",
      args: ["--interval", "5"],
      backend: "host",
      status: "killed",
      startedAt: 3_000,
      deadlineAt: 1_000_000,
      endedAt: 9_000,
    });
    const killed = page.getByRole("status").filter({ hasText: "后台任务已终止" });
    await killed.waitFor();
    await expect(killed.getByRole("button", { name: "去会话" }).count()).resolves.toBe(0);
    await killed.getByTitle("关闭通知").click();
    await expect(killed.count()).resolves.toBe(0);
  });
}, 30_000);

async function pushJob(page: Page, job: JobSummaryDTO): Promise<void> {
  await page.evaluate((payload) => {
    // 夹具在 window 上挂了推送钩子（模拟服务器广播到当前 SSE 连接）
    (window as unknown as { pushJobFinished: (job: JobSummaryDTO) => void }).pushJobFinished(payload);
  }, job);
}

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixtures/job_notify.tsx")],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const bundle = await build.outputs[0]!.text();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/fixture.js"
        ? new Response(bundle, { headers: { "content-type": "application/javascript" } })
        : new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', {
            headers: { "content-type": "text/html" },
          }),
  });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByText("你好，今天要做什么？").waitFor();
    await run(page);
  } finally {
    await browser.close();
    server.stop(true);
  }
}
