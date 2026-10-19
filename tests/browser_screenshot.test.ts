import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { captureVisibleScreenshot } from "../src/tools/browser_screenshot";

// 本地 Edge 集成回归：不访问真实网页或模型服务。
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("字体永不完成时，原截图超时但当前视口仍能截图", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    let fontRequested!: () => void;
    const requested = new Promise<void>(resolve => { fontRequested = resolve; });
    await page.route("https://fixture.invalid/stalled.woff2", () => {
      fontRequested(); // 故意不完成请求，模拟代理下卡住的字体。
    });
    await page.setContent(`<style>@font-face { font-family: stalled; src: url('https://fixture.invalid/stalled.woff2'); font-display: swap; } body {font-family: stalled, sans-serif}</style><h1>Visible page despite stalled font</h1>`, { waitUntil: "domcontentloaded" });
    await requested;
    expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
    await expect(page.screenshot({ timeout: 500 })).rejects.toThrow("waiting for fonts");
    const bytes = await captureVisibleScreenshot(page, 5000);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
  } finally { await browser.close(); }
}, 20_000);
