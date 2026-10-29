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
    const panelTitle = page.getByRole("heading", { name: "模型与参数" });
    // 面板里另有摘要模型与思考程度两个 select：模型是第一个（只在面板打开时取）
    const openPanel = async () => {
      await page.getByTitle("模型与参数").click();
      await panelTitle.waitFor();
    };
    const modelSelect = () => page.getByRole("combobox").first();
    await openPanel();
    await modelSelect().selectOption("chosen");
    // 模拟会话初始状态在编辑以后才送达。
    await page.evaluate(() => (window as any).fixture.update({ model: "late", temperature: 0.3, maxIterations: 9 }));
    expect(await modelSelect().inputValue()).toBe("chosen");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await panelTitle.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector('[title="模型与参数"]')?.textContent?.includes("chosen"));
    expect(await page.evaluate(() => (window as any).fixture.submissions)).toEqual([
      { sessionId: "a", model: "chosen" },
    ]);
    await openPanel();
    await modelSelect().selectOption("old");
    await page.evaluate(() => { (window as any).fixture.fail = true; });
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("保存失败");
    expect(await modelSelect().inputValue()).toBe("old");
    await page.evaluate(() => {
      (window as any).fixture.switchSession("b");
      (window as any).fixture.update({ model: "late", temperature: 0.2, maxIterations: 6 });
    });
    await panelTitle.waitFor({ state: "hidden" });
    await openPanel();
    expect(await modelSelect().inputValue()).toBe("late");
    expect(await page.getByRole("alert").count()).toBe(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 20_000);

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("上下文窗口：填数字下发覆盖，清空下发 null 回到自动", async () => {
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
    const panelTitle = page.getByRole("heading", { name: "模型与参数" });
    const windowInput = page.getByRole("spinbutton", { name: /上下文窗口/ });
    const submissions = () => page.evaluate(() => (window as any).fixture.submissions);

    await page.getByTitle("模型与参数").click();
    // 没有会话级覆盖时留空，占位显示当前生效窗口
    expect(await windowInput.inputValue()).toBe("");
    expect(await windowInput.getAttribute("placeholder")).toBe("128000");

    // 非法值就地拒绝，不发请求
    await windowInput.fill("0");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    expect(await page.getByRole("alert").textContent()).toContain("上下文窗口必须是正整数");
    expect(await submissions()).toEqual([]);

    // 填数字：下发覆盖，面板关闭后重开仍是覆盖值
    await windowInput.fill("32000");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await panelTitle.waitFor({ state: "hidden" });
    expect(await submissions()).toEqual([{ sessionId: "a", contextWindow: 32000 }]);
    await page.getByTitle("模型与参数").click();
    expect(await windowInput.inputValue()).toBe("32000");
    // 手填值落在某个档位上时，该档位显示为选中
    expect(await page.getByRole("button", { name: "32K" }).getAttribute("aria-pressed")).toBe("true");

    // 清空：下发 null 收回覆盖，重开后留空、占位回到模型查表值
    await windowInput.fill("");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await panelTitle.waitFor({ state: "hidden" });
    expect(await submissions()).toEqual([
      { sessionId: "a", contextWindow: 32000 },
      { sessionId: "a", contextWindow: null },
    ]);
    await page.getByTitle("模型与参数").click();
    expect(await windowInput.inputValue()).toBe("");
    expect(await windowInput.getAttribute("placeholder")).toBe("200000");

    // 点档位：一键填入并下发覆盖
    await page.getByRole("button", { name: "64K" }).click();
    expect(await windowInput.inputValue()).toBe("64000");
    expect(await page.getByRole("button", { name: "64K" }).getAttribute("aria-pressed")).toBe("true");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await panelTitle.waitFor({ state: "hidden" });
    await page.getByTitle("模型与参数").click();
    expect(await windowInput.inputValue()).toBe("64000");

    // 点「自动」清空覆盖，回到按模型查表
    await page.getByRole("button", { name: "自动", exact: true }).click();
    expect(await windowInput.inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "自动", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await panelTitle.waitFor({ state: "hidden" });
    expect(await submissions()).toEqual([
      { sessionId: "a", contextWindow: 32000 },
      { sessionId: "a", contextWindow: null },
      { sessionId: "a", contextWindow: 64000 },
      { sessionId: "a", contextWindow: null },
    ]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 20_000);
