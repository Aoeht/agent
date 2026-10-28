// web/tests/attachments.browser.test.ts
// 真实浏览器（msedge）验证附件交互：选择文件、缩略图、移除、错误提示、纯图片发送。
// RUN_BROWSER_TESTS=1 bun test web/tests/attachments.browser.test.ts
import { expect, test } from "bun:test";
import { chromium } from "playwright";
import path from "node:path";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pngBytes = Buffer.from(PNG_BASE64, "base64");

test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("附件：上传、缩略图、移除、错误提示与纯图片发送", async () => {
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixtures/attachments.tsx")],
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
    const input = page.locator('input[type="file"]');

    // 上传 → 缩略图 + 名称/大小；文本与图片一起发送后清空
    await input.setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: pngBytes });
    await page.getByRole("img", { name: "shot.png" }).waitFor();
    await page.getByPlaceholder(/派个任务/).fill("看这张图");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixture.entries)).toEqual([
      { text: "看这张图", images: [{ name: "shot.png", mimeType: "image/png", sizeBytes: pngBytes.length }] },
    ]);
    expect(await page.getByRole("img", { name: "shot.png" }).count()).toBe(0);

    // 纯图片：文本为空也能发送
    await input.setInputFiles({ name: "only.png", mimeType: "image/png", buffer: pngBytes });
    await page.getByRole("button", { name: "发送", exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixture.entries)).toEqual([
      { text: "看这张图", images: [{ name: "shot.png", mimeType: "image/png", sizeBytes: pngBytes.length }] },
      { text: "", images: [{ name: "only.png", mimeType: "image/png", sizeBytes: pngBytes.length }] },
    ]);

    // 移除按钮
    await input.setInputFiles({ name: "a.png", mimeType: "image/png", buffer: pngBytes });
    await input.setInputFiles({ name: "b.png", mimeType: "image/png", buffer: pngBytes });
    await page.getByTitle("移除这张图片").first().click();
    expect(await page.getByRole("img").count()).toBe(1);

    // 非图片文件：错误提示（role=alert），不加入附件
    await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("不是受支持的图片格式");

    // 视觉关闭：附件入口禁用
    await page.evaluate(() => (window as any).fixture.setVision(false));
    const attachButton = page.getByTitle(/图片通道已关闭/);
    await attachButton.waitFor();
    expect(await attachButton.isDisabled()).toBe(true);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30_000);
