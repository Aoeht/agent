import { expect, test } from "bun:test";
import { chromium } from "playwright";
import path from "node:path";

// 本地真实浏览器，不连接后端或模型。显式启用以兼容无浏览器的 CI。
test.skipIf(process.env.RUN_BROWSER_TESTS !== "1")("欢迎界面：默认停留；沙箱目录可见；选模型随首条消息建会话", async () => {
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
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    // 启动即欢迎界面：问候语可见，历史会话没有被自动打开（侧栏里有它，但主区是欢迎态）
    await page.getByText("你好，今天要做什么？").waitFor();
    await page.locator("nav").getByText("上次的任务").first().waitFor(); // 侧栏会话项
    // 沙箱目录行显示服务器当前根目录
    const sandboxRow = page.getByTitle("更改沙箱目录");
    await sandboxRow.waitFor();
    expect(await sandboxRow.textContent()).toContain("A:\\welcome-fixture");
    // 欢迎态选模型：上报草稿（不调会话配置接口），chip 立即反映
    await page.getByTitle("模型与参数").click();
    // 面板里另有摘要模型与思考程度两个 select：模型是第一个
    await page.getByRole("combobox").first().selectOption("beta-model");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await page.getByTitle("模型与参数").filter({ hasText: "beta-model" }).waitFor();
    // 发送首条消息：创建会话并进入聊天视图，欢迎语退场
    await page.getByPlaceholder(/给 Agent 派个任务/).fill("帮我把这件事跑起来");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByText("帮我把这件事跑起来").waitFor();
    expect(await page.getByText("你好，今天要做什么？").count()).toBe(0);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 20_000);
