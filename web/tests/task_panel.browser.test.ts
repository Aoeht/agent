import { expect, test } from "bun:test";
import { chromium } from "playwright";
import path from "node:path";

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("持久化任务面板显示验收失败、完成事件与刷新后的恢复", async () => {
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixtures/task_panel.tsx")],
    target: "browser", format: "esm", define: { "process.env.NODE_ENV": '"production"' } });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const bundle = await build.outputs[0]!.text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req =>
    new URL(req.url).pathname === "/fixture.js" ? new Response(bundle, { headers: { "content-type": "application/javascript" } })
      : new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByText("生成并检查报告", { exact: true }).waitFor();
    expect(await page.getByText("! 报告正文：文件不存在", { exact: true }).isVisible()).toBe(true);
    await page.evaluate(() => (window as any).completeTask());
    await page.getByText("验收通过", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("验收通过", { exact: true }).waitFor();
    expect(await page.getByText("✓ 报告正文：文件实测符合条件", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("! 报告正文：文件不存在", { exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 20_000);
