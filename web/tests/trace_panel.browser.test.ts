import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import path from "node:path";

// 本地真实浏览器，不连接后端或模型。显式启用与其它浏览器用例保持一致。
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("运行轨迹：文件列表、时间轴摘要、心跳开关与 JSON 展开", async () => {
  await withPage(async (page) => {
    const dialog = await openPanel(page);

    // 文件列表：一条演示轨迹，标题取 run_start 的用户消息
    await dialog.getByText("共 1 个轨迹文件").waitFor();
    await dialog.getByText("分析一下反诈数据", { exact: true }).first().waitFor();

    // 时间轴：步骤 / 工具 / 压缩 / 结束的摘要都按事件类型渲染
    await dialog.getByText("第 1 步 · prompt 2140 / 输出 186 tokens · rag_search").waitFor();
    await dialog.getByText("rag_search · 2.9s · 成功").waitFor();
    await dialog.getByText(/stub_tool_outputs · 省 ~1240 tokens/).waitFor();
    await dialog.getByText("✓ 完成 · 2 次迭代 · 1 次工具调用 · 9820 tokens").waitFor();
    await dialog.getByText("1 回合 · 1 工具调用 · 9.4s").waitFor();

    // 心跳（tool_progress）默认隐藏，计数在元信息与按钮上
    await dialog.getByText(/7 条事件（隐藏 2 条心跳）/).waitFor();
    await expect(dialog.getByText(/已运行/).count()).resolves.toBe(0);
    await dialog.getByRole("button", { name: "显示心跳（2）" }).click();
    await dialog.getByText("rag_search · 已运行 1.0s").waitFor();
    await dialog.getByText("rag_search · 已运行 2.2s").waitFor();
    await dialog.getByRole("button", { name: "隐藏心跳" }).waitFor();

    // 点事件展开原始 JSON，再点收起
    await dialog.getByText("rag_search · 2.9s · 成功").click();
    const json = dialog.locator("pre").first();
    await json.waitFor();
    expect(await json.textContent()).toContain('"durationMs": 2900');
    await dialog.getByText("rag_search · 2.9s · 成功").click();
    await expect(dialog.locator("pre").count()).resolves.toBe(0);

    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect(dialog.isVisible()).resolves.toBe(false);
  });
}, 30_000);

async function openPanel(page: Page) {
  await page.locator("nav").getByText("轨迹演示").first().click();
  await page.getByTitle("运行轨迹（每轮决策、工具调用与压缩）").click();
  const dialog = page.getByRole("dialog", { name: "运行轨迹" });
  await dialog.waitFor();
  return dialog;
}

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixtures/trace.tsx")],
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
