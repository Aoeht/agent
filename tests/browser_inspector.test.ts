import { test, expect } from "bun:test";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { createInspectLinkTool } from "../src/tools/inspect_link";
import { detectProtection, isPrivateAddress } from "../src/utils/web_guard";
import { browserContextOptions, parseBrowserDevice, resolveBrowserProfileDir } from "../src/utils/browser_device";

test("正常 CDN 页面和验证码组件不等于挑战页", () => {
  expect(detectProtection({ "cf-ray": "ray", "cf-cache-status": "HIT" }, "<h1>内容</h1>").blocked).toBe(false);
  expect(detectProtection({}, '<script src="https://www.google.com/recaptcha/api.js"></script>').blocked).toBe(false);
  expect(detectProtection({ "cf-mitigated": "challenge" }, "").blocked).toBe(true);
  expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
  expect(isPrivateAddress("198.19.0.1")).toBe(true);
});

test("网络失败保留已完成跳转，auto 升级失败仍保留 HTTP 证据", async () => {
  const tool = createInspectLinkTool({
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }], maxRetries: 0,
    fetchImpl: async url => {
      if (url.includes("first")) return new Response(null, { status: 302, headers: { location: "https://second.example/" } });
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    },
    browserInspect: async () => { throw new Error("browser unavailable"); },
  });
  const result = await tool.execute({ url: "https://first.example/", mode: "auto" }) as any;
  expect(result.http.hops).toBe(1);
  expect(result.http.redirect_chain[0].location).toBe("https://second.example/");
  expect(result.browser.access_status).toBe("failed");
});

test("browser 模式直接采证，图片以多模态消息发出且不进入 trace/返回历史", async () => {
  const tools = new ToolRegistry();
  tools.register(createInspectLinkTool({
    fetchImpl: async () => { throw new Error("不应 HTTP 抓取"); },
    browserInspect: async (url, runtime) => {
      runtime?.emitImage?.({ dataUrl: "data:image/jpeg;base64,TESTIMAGE", label: url });
      return { screenshots: ["evidence.jpg"] };
    },
  }));
  const requests: any[] = [];
  const client = { chat: { completions: { create: async (request: any) => {
    requests.push(request);
    return { choices: [{ message: requests.length === 1 ? {
      content: null, tool_calls: [{ id: "image-call", type: "function", function: {
        name: "inspect_link", arguments: JSON.stringify({ url: "https://example.com", mode: "browser" }),
      } }],
    } : { content: "截图已观察" } }], usage: { total_tokens: 1 } };
  } } } } as any;
  const agent = new Agent({ model: "vision-test", systemPrompt: "test", client, tools });
  const result = await agent.run("核查");
  const parts = requests[1].messages.at(-1).content;
  expect(parts[1].image_url.url).toContain("TESTIMAGE");
  expect(parts[0].text).toContain("image-call");
  expect(JSON.stringify(result.steps)).not.toContain("TESTIMAGE");
  expect(JSON.stringify(result.messages)).not.toContain("TESTIMAGE");
});

test("采证形态：移动/微信是移动视口+触摸+对应 UA，桌面保持 1280x900", () => {
  expect(browserContextOptions("desktop")).toEqual({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });

  const mobile = browserContextOptions("mobile");
  expect(mobile.viewport).toEqual({ width: 390, height: 844 });
  expect(mobile.isMobile).toBe(true);
  expect(mobile.hasTouch).toBe(true);
  expect(mobile.userAgent).toContain("Android");
  expect(mobile.userAgent).toContain("Mobile");

  expect(browserContextOptions("wechat").userAgent).toContain("MicroMessenger");
  expect(parseBrowserDevice(" WeChat ")).toBe("wechat");
  expect(parseBrowserDevice(undefined)).toBe("desktop");
  expect(parseBrowserDevice("tablet")).toBe("desktop");

  // 未配置/空白 = 临时上下文；配置后原样作为专用持久档目录
  expect(resolveBrowserProfileDir(undefined)).toBeUndefined();
  expect(resolveBrowserProfileDir("   ")).toBeUndefined();
  expect(resolveBrowserProfileDir(" .chrome-inspect-profile ")).toBe(".chrome-inspect-profile");
});

test("调用方取消后不升级到浏览器", async () => {
  const controller = new AbortController(); controller.abort();
  let opened = false;
  const tool = createInspectLinkTool({ browserInspect: async () => { opened = true; return {}; } });
  await expect(tool.execute({ url: "https://example.com", mode: "browser" }, { signal: controller.signal })).rejects.toThrow();
  expect(opened).toBe(false);
});

test("同回合截图失败后不重开；新回合可以重试", async () => {
  let opens = 0;
  const tool = createInspectLinkTool({ browserInspect: async () => {
    opens++;
    return { access_status: "observed", capture_status: "partial", visible_text: "已读到的正文" };
  } });
  const runtime = { browserFailures: new Set<string>() };
  const first = await tool.execute({ url: "https://example.com", mode: "browser" }, runtime) as any;
  expect(first.browser.visible_text).toBe("已读到的正文");
  const second = await tool.execute({ url: "https://example.com/", mode: "browser" }, runtime) as any;
  expect(second.browser.access_status).toBe("retry_blocked");
  expect(opens).toBe(1);
  await tool.execute({ url: "https://example.com", mode: "browser" }, { browserFailures: new Set() });
  expect(opens).toBe(2);
});
