import { expect, test } from "bun:test";
import { chromium } from "playwright";
import path from "node:path";

// 本地真实浏览器 + 夹具 transport，不连后端、不调模型。显式启用以兼容无浏览器的 CI。
async function withPage(
  url: (port: number) => string,
  run: (page: import("playwright").Page) => Promise<void>
): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixtures/checkpoints.tsx")],
    target: "browser", format: "esm", define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const bundle = await build.outputs[0]!.text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req =>
    new URL(req.url).pathname === "/fixture.js"
      ? new Response(bundle, { headers: { "content-type": "application/javascript" } })
      : new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>',
        { headers: { "content-type": "text/html" } }),
  });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url(server.port));
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("检查点面板：列表、范围回滚与历史刷新", async () => {
  await withPage((port) => `http://127.0.0.1:${port}`, async (page) => {
    await page.locator("nav").getByText("检查点演示").first().click();
    const chat = page.locator("main");
    await chat.getByText("第二轮", { exact: true }).waitFor();
    page.on("dialog", (dialog) => void dialog.accept());

    await page.getByTitle("检查点（回滚工作区/对话到某轮开始之前）").click();
    const dialog = page.getByRole("dialog", { name: "检查点" });
    await dialog.waitFor();
    await dialog.getByText(/共 2 个/).waitFor();
    // 默认选中最新一个（#2）
    await dialog.getByText("回滚到 #2").waitFor();

    // #1 + 只恢复代码：回执行出现，对话历史原样（"第二轮"还在）
    await dialog.getByRole("button", { name: /#1/ }).click();
    await dialog.getByText("回滚到 #1").waitFor();
    await dialog.getByRole("button", { name: "只恢复代码" }).click();
    await dialog.getByText(/已恢复工作区/).waitFor();
    expect(await chat.getByText("第二轮", { exact: true }).isVisible()).toBe(true);

    // #2 + 只恢复对话：历史截断到 2 条，界面重拉后"第二轮"消失、"第一轮"仍在
    await dialog.getByRole("button", { name: /#2/ }).click();
    await dialog.getByRole("button", { name: "只恢复对话" }).click();
    await dialog.getByText(/已恢复对话/).waitFor();
    await chat.getByText("第二轮", { exact: true }).waitFor({ state: "detached" });
    expect(await chat.getByText("第一轮", { exact: true }).isVisible()).toBe(true);
    expect(await chat.getByText("答 1", { exact: true }).isVisible()).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __rewinds: unknown[] }).__rewinds)).toEqual([
      { seq: 1, scope: "code" },
      { seq: 2, scope: "chat" },
    ]);

    // Esc 关闭面板
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  });
}, 30_000);

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("检查点面板：服务端关闭检查点时显示已关闭且按钮不可用", async () => {
  await withPage((port) => `http://127.0.0.1:${port}/?disabled=1`, async (page) => {
    await page.locator("nav").getByText("检查点演示").first().click();
    await page.locator("main").getByText("第一轮", { exact: true }).waitFor();
    await page.getByTitle("检查点（回滚工作区/对话到某轮开始之前）").click();
    const dialog = page.getByRole("dialog", { name: "检查点" });
    await dialog.getByText(/AGENT_CHECKPOINTS=0/).first().waitFor();
    for (const name of ["只恢复代码", "只恢复对话", "恢复代码 + 对话"]) {
      expect(await dialog.getByRole("button", { name }).isDisabled()).toBe(true);
    }
  });
}, 20_000);
