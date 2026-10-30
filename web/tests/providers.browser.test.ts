import { expect, test } from "bun:test";
import { chromium } from "playwright";
import path from "node:path";

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("供应商模型开关：隐藏后从模型下拉消失，全部显示后恢复", async () => {
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixtures/providers.tsx")],
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
    await page.getByText("你好，今天要做什么？", { exact: true }).waitFor();

    await page.getByRole("button", { name: "模型供应商" }).click();
    await page.getByText("演示供应商", { exact: true }).waitFor();
    const alpha = page.getByRole("switch", { name: "alpha 在模型列表显示" });
    const beta = page.getByRole("switch", { name: "beta 在模型列表显示" });
    expect(await alpha.getAttribute("aria-checked")).toBe("true");
    expect(await beta.getAttribute("aria-checked")).toBe("true");

    // 关掉 beta：面板显示隐藏态，请求体只带 alpha
    await beta.click();
    await page.getByText("隐藏", { exact: true }).waitFor();
    expect(await page.getByRole("switch", { name: "beta 在模型列表显示" }).getAttribute("aria-checked")).toBe("false");
    const calls = await page.evaluate(() => (window as unknown as { providerCalls: Array<{ id: string; enabled: string[] }> }).providerCalls);
    expect(calls.at(-1)).toEqual({ id: "demo-1", enabled: ["alpha"] });

    // 模型下拉里 beta 消失、alpha 仍在
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: /glm-5\.2/ }).click();
    await page.getByText("模型与参数", { exact: true }).waitFor();
    const hidden = await page.locator("select").first().locator("option").allTextContents();
    expect(hidden).toContain("demo-1::alpha");
    expect(hidden).not.toContain("demo-1::beta");

    // 全部显示后恢复
    await page.getByRole("button", { name: /glm-5\.2/ }).click();
    await page.getByRole("button", { name: "模型供应商" }).click();
    await page.getByRole("button", { name: "全部显示" }).click();
    await page.getByText("隐藏", { exact: true }).waitFor({ state: "detached" });
    expect(await page.getByRole("switch", { name: "beta 在模型列表显示" }).getAttribute("aria-checked")).toBe("true");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: /glm-5\.2/ }).click();
    await page.getByText("模型与参数", { exact: true }).waitFor();
    const restored = await page.locator("select").first().locator("option").allTextContents();
    expect(restored).toContain("demo-1::beta");
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
