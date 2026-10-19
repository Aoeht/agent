import type { Page } from "playwright";

/** 截取当前已渲染视口，不等待 document.fonts.ready 或网络空闲。 */
export async function captureVisibleScreenshot(page: Page, timeoutMs = 10_000): Promise<Buffer> {
  const session = await page.context().newCDPSession(page);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      session.send("Page.captureScreenshot", {
        format: "jpeg", quality: 75, fromSurface: true, captureBeyondViewport: false,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`截取当前视口超时（${timeoutMs}ms），已保留其他页面证据`)), timeoutMs);
      }),
    ]);
    return Buffer.from(result.data, "base64");
  } finally {
    if (timer) clearTimeout(timer);
    await session.detach().catch(() => {});
  }
}
