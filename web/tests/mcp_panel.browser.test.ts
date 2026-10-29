import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import path from "node:path";

// 本地真实浏览器，不连接后端或模型。显式启用以兼容无浏览器的 CI。
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("MCP 目录：资源浏览、预览与注入命令", async () => {
  await withPage(async (page) => {
    const dialog = await openPanel(page);
    // 资源列表含文本与二进制两条
    await dialog.getByText("anti_fraud.md", { exact: true }).waitFor();
    await dialog.getByText("logo.png", { exact: true }).waitFor();

    // 选中文本资源 → 预览正文
    await dialog.getByText("anti_fraud.md", { exact: true }).click();
    await dialog.getByText(/演示资源正文/).waitFor();

    // 注入：发出 /resource <serverId:uri> 命令
    await dialog.getByRole("button", { name: "注入下一轮" }).click();
    await dialog.getByText(/已注入 anti_fraud.md/).waitFor();
    const commands = await page.evaluate(() => (window as unknown as { __mcpCommands?: string[] }).__mcpCommands ?? []);
    expect(commands).toEqual(["/resource local:file:///docs/anti_fraud.md"]);

    // 二进制资源只给大小提示
    await dialog.getByText("logo.png", { exact: true }).click();
    await dialog.getByText(/二进制内容（12\.1 KiB）/).waitFor();

    // Esc 关闭
    await page.keyboard.press("Escape");
    await expect(dialog.isVisible()).resolves.toBe(false);
  });
}, 30_000);

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("MCP 目录：模板参数校验与载入命令", async () => {
  await withPage(async (page) => {
    const dialog = await openPanel(page);
    await dialog.getByRole("button", { name: /提示模板/ }).click();
    await dialog.getByText("review").click();

    // 必填参数为空时不发命令
    await dialog.getByRole("button", { name: "载入模板" }).click();
    await dialog.getByText("必填参数为空：text").waitFor();
    let commands = await page.evaluate(() => (window as unknown as { __mcpCommands?: string[] }).__mcpCommands ?? []);
    expect(commands).toEqual([]);

    // 填参数后发出 /prompt <serverId:name> {JSON}
    await dialog.getByRole("textbox").fill("这段客服话术可信吗");
    await dialog.getByRole("button", { name: "载入模板" }).click();
    await dialog.getByText(/已载入模板 local:review/).waitFor();
    commands = await page.evaluate(() => (window as unknown as { __mcpCommands?: string[] }).__mcpCommands ?? []);
    expect(commands).toEqual(['/prompt local:review {"text":"这段客服话术可信吗"}']);
  });
}, 30_000);

async function openPanel(page: Page) {
  await page.locator("nav").getByText("MCP 演示").first().click();
  await page.getByTitle("MCP 目录（资源 / 提示模板）").click();
  const dialog = page.getByRole("dialog", { name: "MCP 目录" });
  await dialog.waitFor();
  return dialog;
}

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixtures/mcp.tsx")],
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
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByText("你好，今天要做什么？").waitFor();
    await run(page);
  } finally {
    await browser.close();
    server.stop(true);
  }
}
