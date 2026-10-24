import { expect, test } from "bun:test";
import { chromium } from "playwright";
import path from "node:path";

// 本地真实浏览器，不连接后端或模型。显式启用以兼容无浏览器的 CI。
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")(
  "窄屏：会话栏/右栏抽屉化；桌面断点保持静态布局不出现抽屉按钮",
  async () => {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixtures/app.tsx")],
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
    // 夹具是裸 Bun.build，没有 Tailwind 管线：注入最小语义垫片模拟布局关键类，
    // 真实 Tailwind 产物由 390px 真机验收覆盖
    const cssShim = `
      .invisible { visibility: hidden; }
      .fixed { position: fixed; }
      .inset-y-0 { top: 0; bottom: 0; }
      .inset-0 { inset: 0; }
      .left-0 { left: 0; }
      .right-0 { right: 0; }
      .-translate-x-full { transform: translateX(-100%); }
      .translate-x-full { transform: translateX(100%); }
      .translate-x-0 { transform: translateX(0); }
      .hidden { display: none; }
      .z-30 { z-index: 30; }
      .z-40 { z-index: 40; }
      .w-72 { width: 18rem; }
      .w-80 { width: 20rem; }
      @media (min-width: 1280px) { .xl\\:flex { display: flex; } }
    `;
    try {
      // ---- 390px 手机视口 ----
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(5000);
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.addStyleTag({ content: cssShim });
      await page.getByText("你好，今天要做什么？").waitFor();
      // 会话栏在抽屉里收纳：入口按钮可见，列表本身不可见
      const sidebarItem = page.locator("nav").getByText("上次的任务").first();
      expect(await sidebarItem.isVisible()).toBe(false);
      const hamburger = page.getByTitle("会话列表");
      expect(await hamburger.count()).toBe(1);
      await hamburger.click();
      await sidebarItem.waitFor({ state: "visible" });
      // 选中会话 → 抽屉收起并进入聊天视图
      await sidebarItem.click();
      await page.getByRole("heading", { name: "上次的任务" }).waitFor({ state: "visible" });
      expect(await sidebarItem.isVisible()).toBe(false);
      // <1280 出现右栏抽屉入口：打开可见任务计划，点遮罩关闭
      const panelBtn = page.getByTitle("任务与运行环境");
      expect(await panelBtn.count()).toBe(1);
      await panelBtn.click();
      const planHeading = page.getByRole("heading", { name: "任务计划" });
      await planHeading.waitFor({ state: "visible" });
      await page.locator("div.fixed.inset-0").click({ position: { x: 10, y: 10 } });
      await planHeading.waitFor({ state: "hidden" });
      // 欢迎界面也有会话入口（header 的 ☰ 在新会话分支同样渲染）
      await page.getByTitle("会话列表").click();
      await sidebarItem.waitFor({ state: "visible" });

      // ---- 1280px 桌面回归：静态布局，无抽屉按钮 ----
      const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      desktop.setDefaultTimeout(5000);
      await desktop.goto(`http://127.0.0.1:${server.port}`);
      await desktop.addStyleTag({ content: cssShim });
      await desktop.getByText("你好，今天要做什么？").waitFor();
      expect(await desktop.getByTitle("会话列表").count()).toBe(0);
      const desktopItem = desktop.locator("nav").getByText("上次的任务").first();
      expect(await desktopItem.isVisible()).toBe(true);
      await desktopItem.click();
      // xl 断点起右栏静态展示，无需入口按钮
      await desktop.getByRole("heading", { name: "任务计划" }).waitFor({ state: "visible" });
      expect(await desktop.getByTitle("任务与运行环境").count()).toBe(0);
    } finally {
      await browser.close();
      server.stop(true);
    }
  },
  30_000
);
