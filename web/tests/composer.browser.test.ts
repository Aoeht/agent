import { expect, test } from "bun:test";
import { chromium } from "playwright";
import path from "node:path";

// 本地真实浏览器，不连接后端或模型。显式启用以兼容无浏览器的 CI。
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("设置草稿不被迟到配置覆盖；一次应用生效；失败提示与会话隔离", async () => {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixtures/composer.tsx")],
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
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByTitle("模型与参数").click();
    await page.getByRole("combobox").selectOption("chosen");
    // 模拟会话初始状态在编辑以后才送达。
    await page.evaluate(() => (window as any).fixture.update({ model: "late", temperature: 0.3, maxIterations: 9 }));
    expect(await page.getByRole("combobox").inputValue()).toBe("chosen");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[title="模型与参数"]')?.textContent?.includes("chosen"));
    expect(await page.evaluate(() => (window as any).fixture.submissions)).toEqual([
      { sessionId: "a", model: "chosen" },
    ]);
    await page.getByTitle("模型与参数").click();
    await page.getByRole("combobox").selectOption("old");
    await page.evaluate(() => { (window as any).fixture.fail = true; });
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("保存失败");
    expect(await page.getByRole("combobox").inputValue()).toBe("old");
    await page.evaluate(() => {
      (window as any).fixture.switchSession("b");
      (window as any).fixture.update({ model: "late", temperature: 0.2, maxIterations: 6 });
    });
    await page.getByRole("combobox").waitFor({ state: "hidden" });
    await page.getByTitle("模型与参数").click();
    expect(await page.getByRole("combobox").inputValue()).toBe("late");
    expect(await page.getByRole("alert").count()).toBe(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 20_000);
