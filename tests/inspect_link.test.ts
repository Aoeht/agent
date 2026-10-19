// tests/inspect_link.test.ts
import { test, expect } from "bun:test";
import {
  classifyNetworkFailure,
  createInspectLinkTool,
  detectProtection,
  extractHtmlFeatures,
  htmlToText,
  isPrivateAddress,
} from "../src/tools/inspect_link";
import type { FetchLike, LookupLike } from "../src/tools/inspect_link";

const PUBLIC_LOOKUP: LookupLike = async (hostname) => [
  { address: hostname.endsWith("6") ? "2606:2800:220:1:248:1893:25c8:1946" : "93.184.216.34", family: hostname.endsWith("6") ? 6 : 4 },
];

function htmlResponse(html: string, contentType = "text/html; charset=utf-8"): Response {
  return new Response(html, { status: 200, headers: { "content-type": contentType } });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function makeTool(fetchImpl: FetchLike, lookup: LookupLike = PUBLIC_LOOKUP) {
  return createInspectLinkTool({ fetchImpl, lookupImpl: lookup });
}

test("isPrivateAddress 覆盖内网/保留段，放行公网地址", () => {
  for (const blocked of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:192.168.1.1", "2001:db8::1",
    // 内嵌 IPv4 的隧道/转换写法：只按字符串前缀判会全部漏掉
    "::ffff:7f00:1", "::ffff:0:127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::", "2001:0:0:0:0:0:7f00:1", "fec0::1", "192.88.99.1", "2001:2::1",
    // 段 >255 的非法写法：dns.lookup 不会返回它，但直接调用必须按不安全处理
    "1.2.3.999", "256.0.0.1",
  ]) {
    expect(isPrivateAddress(blocked)).toBe(true);
  }
  for (const allowed of [
    "93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946", "114.114.114.114",
    // 同样形态但内嵌公网 IPv4：不能过度拦截（DNS64/NAT64 环境下正常域名就是这种解析结果）
    "::ffff:8.8.8.8", "64:ff9b::5db8:d822", "2002:5db8:d822::",
  ]) {
    expect(isPrivateAddress(allowed)).toBe(false);
  }
});

test("SSRF：字面内网 IP 与解析到内网的域名都被拦截，DNS 解析失败也报错", async () => {
  const tool = makeTool(async () => htmlResponse("<title>x</title>"));

  await expect(tool.execute({ url: "http://127.0.0.1:8080/admin" })).rejects.toThrow("SSRF 防护");
  await expect(
    makeTool(async () => htmlResponse("x"), async () => [{ address: "10.0.0.5", family: 4 }]).execute({
      url: "https://internal.example/x",
    })
  ).rejects.toThrow("SSRF 防护");
  await expect(
    makeTool(async () => htmlResponse("x"), async () => []).execute({ url: "https://blackhole.example/x" })
  ).rejects.toThrow("DNS 解析失败");
});

test("SSRF：重定向中途指向内网地址同样被拦", async () => {
  let calls = 0;
  const tool = makeTool(async () => {
    calls++;
    return calls === 1 ? redirectResponse("http://192.168.1.1/next") : htmlResponse("x");
  });

  await expect(tool.execute({ url: "https://evil.example/start" })).rejects.toThrow("SSRF 防护");
  expect(calls).toBe(1); // 第二跳在 fetch 之前就被拦截
});

test("SSRF：NAT64/6to4 字面量里的内网地址也在 fetch 之前被拦", async () => {
  let fetched = 0;
  const tool = makeTool(async () => {
    fetched++;
    return htmlResponse("x");
  });

  await expect(tool.execute({ url: "http://[64:ff9b::7f00:1]/admin" })).rejects.toThrow("SSRF 防护");
  await expect(tool.execute({ url: "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/" })).rejects.toThrow("SSRF 防护");
  await expect(tool.execute({ url: "http://[2002:7f00:1::]/admin" })).rejects.toThrow("SSRF 防护");
  await expect(tool.execute({ url: "http://192.88.99.1/x" })).rejects.toThrow("SSRF 防护");
  expect(fetched).toBe(0);
});

test("跳转链完整记录，Location 相对路径正确解析，最终返回落地页", async () => {
  const seen: string[] = [];
  const tool = makeTool(async (url: string) => {
    seen.push(url);
    if (url === "https://t.cn/ABC") return redirectResponse("https://dwz.cn/xyz", 301);
    if (url === "https://dwz.cn/xyz") return redirectResponse("/landing?from=short");
    return htmlResponse("<title>退款中心</title><p>您好，客服</p>");
  });

  const out = (await tool.execute({ url: "https://t.cn/ABC" })) as Record<string, unknown>;

  expect(out.final_url).toBe("https://dwz.cn/landing?from=short");
  expect((out.redirect_chain as unknown[]).length).toBe(2);
  expect((out.hops as number)).toBe(2);
  const landing = out.landing as Record<string, unknown>;
  expect(landing.title).toBe("退款中心");
  expect(out.signals).toContain("输入是短链（t.cn），真实目的地被隐藏");
  expect(out.signals).toContain("经过 2 次跳转");
  expect(seen.length).toBe(3);
});

test("重定向循环与超出跳转上限都停下，并保留已采到的链路（不抛错丢证据）", async () => {
  let aCalls = 0;
  const loopTool = makeTool(async (url: string) => {
    if (url.startsWith("https://a.example")) {
      aCalls++;
      return redirectResponse("https://b.example/b");
    }
    return redirectResponse("https://a.example/a");
  });
  const loopOut = (await loopTool.execute({ url: "https://a.example/a" })) as Record<string, unknown>;
  const loopLanding = loopOut.landing as Record<string, unknown>;
  expect(String(loopLanding.note)).toContain("重定向循环");
  // a → b 两次请求即可判定（起点已记录，不需要再取一次 a）
  expect(aCalls).toBe(1);
  // 只记录"真的走过"的跳转：a→b 记一条，b→a 因为命中循环没走、也不进记录
  expect((loopOut.redirect_chain as unknown[]).length).toBe(1);
  expect(loopOut.final_url).toBe("https://b.example/b");

  // 起点自跳转：A → A，必须当场停下
  let selfCalls = 0;
  const selfTool = makeTool(async () => {
    selfCalls++;
    return redirectResponse("https://self.example/a");
  });
  const selfOut = (await selfTool.execute({ url: "https://self.example/a" })) as Record<string, unknown>;
  expect(String((selfOut.landing as Record<string, unknown>).note)).toContain("重定向循环");
  expect(selfCalls).toBe(1);

  // 超出上限：max_redirects=3 的语义是"最多跟随 3 次重定向"（= 请求 4 个页面：起点 + 3 跳），
  // 与 axios/curl 的 maxRedirects 一致。关键是保留 3 跳记录 + 说明下一跳指向哪里，而不是抛错丢证据。
  let requests = 0;
  const chainTool = makeTool(async () => redirectResponse(`https://h${++requests}.example/x`));
  const chainOut = (await chainTool.execute({ url: "https://start.example/a", max_redirects: 3 })) as Record<
    string,
    unknown
  >;
  expect((chainOut.redirect_chain as unknown[]).length).toBe(3);
  expect(chainOut.hops).toBe(3);
  expect(requests).toBe(4); // 起点 1 次 + 跟随 3 次；第 4 跳不再请求
  const chainLanding = chainOut.landing as Record<string, unknown>;
  expect(String(chainLanding.note)).toContain("跳转次数达到上限 3");
  expect(String(chainLanding.note)).toContain("h4.example");
  expect(chainOut.final_url).toBe("https://h3.example/x");
  expect((chainOut.signals as string[]).some((s) => s.includes("跳转次数达到上限"))).toBe(true);

  // 边界：max_redirects=1 → 只跟 1 跳（请求 2 次）就停
  let oneHopRequests = 0;
  const oneHop = makeTool(async () => redirectResponse(`https://o${++oneHopRequests}.example/x`));
  const oneHopOut = (await oneHop.execute({ url: "https://start2.example/a", max_redirects: 1 })) as Record<
    string,
    unknown
  >;
  expect(oneHopRequests).toBe(2);
  expect(oneHopOut.hops).toBe(1);
  expect(String((oneHopOut.landing as Record<string, unknown>).note)).toContain("跳转次数达到上限 1");
});

test("响应体超大时流式截断而不是整段读进内存（证据优先，不中止）", async () => {
  // 声明了超限的 Content-Length：不读 body，立即如实记录。
  // 用最小假 Response：Headers 对 content-length 有特殊处理，直接塞会拿不到原值。
  const fakeResponse = (): Response =>
    ({
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "99999999" : "text/html") },
      body: null,
      text: async () => "<html><title>大</title></html>",
    }) as unknown as Response;
  const declared = makeTool(async () => fakeResponse());
  const declaredOut = (await declared.execute({ url: "https://big.example/x" })) as Record<string, unknown>;
  const declaredLanding = declaredOut.landing as Record<string, unknown>;
  expect(String(declaredLanding.note)).toContain("超过上限");
  // 语义是"读到多少解析多少"（证据优先），不是整页放弃
  expect(declaredLanding.title).toBe("大");

  // 未声明长度的大响应：只读前 maxResponseBytes 字节，并在 note 里说明
  const big = "A".repeat(50_000);
  const streamed = createInspectLinkTool({
    fetchImpl: async () => htmlResponse(`<html><body>${big}</body></html>`),
    lookupImpl: PUBLIC_LOOKUP,
    maxResponseBytes: 1000,
    maxTextChars: 200,
  });
  const streamedOut = (await streamed.execute({ url: "https://big2.example/x" })) as Record<string, unknown>;
  const streamedLanding = streamedOut.landing as Record<string, unknown>;
  // 响应体被字节上限截断这件事必须如实报告，并带上实测字节数
  expect(String(streamedLanding.note)).toContain("仅解析了前 1000 字节");
  expect(streamedLanding.bytes_read).toBe(1000);
  expect(streamedLanding.body_truncated).toBe(true);
  expect(String(streamedLanding.text_preview).length).toBeLessThanOrEqual(200);
  expect(String(streamedLanding.text_preview)).toContain("A");
});

test("HTML 实体被解码、块级标签转换行、行级标签不破坏分词", () => {
  // 实体伪装是绕过关键词表的常见手法：十六进制与十进制都要解出来
  expect(htmlToText("<p>&#x9a8c;&#x8bc1;&#x7801;</p>")).toBe("验证码");
  expect(htmlToText("<p>&#39564;&#35777;&#30721;</p>")).toBe("验证码");
  expect(htmlToText("<p>a&amp;b &lt;tag&gt; &quot;q&quot;&nbsp;x</p>")).toBe('a&b <tag> "q" x');
  // 解码后的文本必须能被关键词表命中（这条是 A4 修复的真正目的）
  expect(htmlToText("<p>&#x9a8c;&#x8bc1;&#x7801;</p>")).toContain("验证码");
  // 行级标签不插空格：a<b>bold</b>c 仍是 aboldc，而不是 a bold c
  expect(htmlToText("<p>a<b>bold</b>c</p>")).toBe("aboldc");
  // 块级标签转换行（注意 extractHtmlFeatures 会把换行压成空格，这里直接测 htmlToText）
  expect(htmlToText("<div>a</div><div>b</div>")).toBe("a\nb");
  // script/style 里的伪标签不能进正文
  expect(htmlToText('<p>正文</p><script>var s = "<div>假正文</div>";</script>')).toBe("正文");
  expect(htmlToText("<style>.a{content:'验证码'}</style><p>真正文</p>")).toBe("真正文");
  // template 是未实例化模板，不该进正文
  expect(htmlToText("<template><p>模板内容</p></template><p>真内容</p>")).toBe("真内容");
  // 标签里带属性含 > 时不至于把后面内容整段吞掉
  expect(htmlToText('<p title="a>b">文字</p>')).toContain("文字");
});

test("信号去重与封顶：同类输入只算一条，超量时如实说明", async () => {
  // 构造满 5 个表单（返回里也只保留前 5 个），每个都含 5 类敏感输入 + 提交到不同外部域名；
  // 再加 app 下载入口、iframe、meta refresh —— 唯一信号总数 = 5 + 5 + 1 + 1 + 1 = 13…
  // 加上跨域名跳转特征与关键词命中后超过上限 24，用来验证裁剪说明。
  const forms = Array.from(
    { length: 5 },
    (_v, i) =>
      `<form action="https://collect${i}.example/submit">` +
      `<input type="tel" name="phone${i}" placeholder="手机号">` +
      `<input type="text" name="sms${i}" placeholder="短信验证码">` +
      `<input type="text" name="card${i}" placeholder="银行卡号">` +
      `<input type="text" name="id${i}" placeholder="身份证号">` +
      `<input type="password" name="pwd${i}">` +
      `</form>`
  ).join("");
  const extras =
    `<a href="https://cdn.example/app.apk">下载APP</a>` +
    `<iframe src="https://frame.example/f"></iframe>` +
    `<meta http-equiv="refresh" content="5; url=https://next.example/go">` +
    `<p>${"客服 退款 理赔 贷款 征信 解冻 中奖 刷单 兼职 保证金 返利".repeat(3)}</p>`;
  const build = (maxSignals?: number) =>
    createInspectLinkTool({
      fetchImpl: async () => htmlResponse(`<html><body>${forms}${extras}</body></html>`),
      lookupImpl: PUBLIC_LOOKUP,
      // 给足上限，确保响应体不被切断（正文上限会切碎 <form>，那是另一个已知边界，见下一条测试）
      maxTextChars: 20_000,
      ...(maxSignals !== undefined ? { maxSignals } : {}),
    });

  // ① 上限给足：验证信号内容本身正确
  const full = (await build().execute({ url: "https://many.example/x" })) as Record<string, unknown>;
  const fullSignals = full.signals as string[];
  // 去重：5 个表单都含"手机号"，但只应产出 1 条信号
  expect(fullSignals.filter((s) => s === "表单要求输入手机号").length).toBe(1);
  expect(fullSignals.filter((s) => s === "表单要求输入身份证号").length).toBe(1);
  // 不同目标不该被去重：5 个不同外部域名各一条
  expect(fullSignals.filter((s) => s.startsWith("表单提交到外部域名")).length).toBe(5);
  // 只有一条"存在 App 安装包下载入口"（不管有几个 apk 链接）
  expect(fullSignals.filter((s) => s === "存在 App 安装包下载入口").length).toBe(1);
  // 表单证据完整
  expect((full.landing as Record<string, unknown>).forms).toHaveLength(5);
  expect(fullSignals.some((s) => s.includes("未列出"))).toBe(false);

  // ② 上限调小：验证封顶分支如实报告被裁掉的数量（不必为此构造 25 条信号的畸形页面）
  const capped = (await build(5).execute({ url: "https://many.example/x" })) as Record<string, unknown>;
  const cappedSignals = capped.signals as string[];
  expect(cappedSignals).toHaveLength(6); // 5 条 + 1 条说明
  expect(cappedSignals[5]).toMatch(/另有 \d+ 条信号未列出/);
});

test("maxSignals 默认上限是 24，正常页面不会被裁剪", async () => {
  const tool = createInspectLinkTool({
    fetchImpl: async () =>
      htmlResponse(`<html><body><form action="/x"><input type="tel" name="p" placeholder="手机号"></form></body></html>`),
    lookupImpl: PUBLIC_LOOKUP,
  });
  const out = (await tool.execute({ url: "https://small.example/x" })) as Record<string, unknown>;
  const signals = out.signals as string[];
  expect(signals.some((s) => s.includes("未列出"))).toBe(false);
  expect(signals).toContain("表单要求输入手机号");
});

test("预览上限只影响正文，不影响证据提取：表单完整、无正文时不报截断", async () => {
  // 两个上限的职责分离：maxReadBytes 管"抓多少字节"，maxTextChars 管"给模型看多少字符"。
  // 这份 HTML 只有表单控件、没有文本节点，所以正文为空、也不该报"正文已截断"。
  const forms = Array.from(
    { length: 5 },
    (_v, i) => `<form action="/s${i}"><input type="tel" name="phone${i}" placeholder="手机号"></form>`
  ).join("");
  const html = `<html><body>${forms}</body></html>`;
  const tool = createInspectLinkTool({
    fetchImpl: async () => htmlResponse(html),
    lookupImpl: PUBLIC_LOOKUP,
    maxTextChars: 60,
  });
  const out = (await tool.execute({ url: "https://tiny.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;
  // 读取量按**字节**统计（中文 UTF-8 占 3 字节），且不受预览上限影响
  expect(Number(landing.bytes_read)).toBe(new TextEncoder().encode(html).length);
  expect(landing.body_truncated).toBe(false);
  expect(landing.note).toBeUndefined();
  // 证据不受预览上限影响
  expect((landing.forms as unknown[]).length).toBe(5);
  expect(out.signals).toContain("表单要求输入手机号");
});

test("正文超预览上限时报截断并给出原文长度，证据仍完整", async () => {
  const longText = "这是一段用于测试的正文内容。".repeat(80); // 约 1040 字
  const forms = `<form action="/s"><input type="tel" name="phone" placeholder="手机号"></form>`;
  const html = `<html><body><p>${longText}</p>${forms}</body></html>`;
  const tool = createInspectLinkTool({
    fetchImpl: async () => htmlResponse(html),
    lookupImpl: PUBLIC_LOOKUP,
    maxTextChars: 60,
  });
  const out = (await tool.execute({ url: "https://long.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;
  expect(String(landing.text_preview).length).toBeLessThanOrEqual(60);
  expect(Number(landing.text_length)).toBeGreaterThan(60);
  expect(String(landing.note)).toMatch(/落地页正文已截断（原文 \d+ 字）/);
  expect((landing.forms as unknown[]).length).toBe(1);
});

test("maxReadBytes 可单独限制读取量，截断时如实报告实测字节数", async () => {
  const big = "A".repeat(50_000);
  const tool = createInspectLinkTool({
    fetchImpl: async () => htmlResponse(`<html><body><p>${big}</p></body></html>`),
    lookupImpl: PUBLIC_LOOKUP,
    maxReadBytes: 800,
    maxTextChars: 100,
  });
  const out = (await tool.execute({ url: "https://cut.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;
  expect(Number(landing.bytes_read)).toBe(800);
  expect(landing.body_truncated).toBe(true);
  expect(String(landing.note)).toContain("仅解析了前 800 字节");
});

test("extractHtmlFeatures 纯函数：button 提交按钮也被记录", () => {
  const features = extractHtmlFeatures(
    `<form action="/go"><input name="q"><button type="submit" name="submitBtn">提交</button></form>`,
    "https://base.example/"
  );
  expect(features.forms[0]!.inputs).toContainEqual({ type: "submit", name: "submitBtn" });
});

test("落地页特征：索要手机号/验证码/密码的表单、APK 链接、风险关键词都进 signals", async () => {
  const html = `
    <html><head><title>官方认证中心</title></head><body>
      <form action="https://collect.example/submit" method="post">
        <input type="tel" name="phone" placeholder="请输入手机号">
        <input type="text" name="sms_code" placeholder="短信验证码">
        <input type="password" name="pwd">
        <input type="hidden" name="track" value="x">
      </form>
      <a href="https://cdn.example/app/release.apk">下载APP</a>
      <a href="/local/page">站内</a>
      <iframe src="https://track.example/pixel"></iframe>
      <p>本平台提供极速退款通道</p>
    </body></html>`;
  const tool = makeTool(async () => htmlResponse(html));
  const out = (await tool.execute({ url: "https://phish.example/" })) as Record<string, unknown>;
  const signals = out.signals as string[];

  expect(signals).toContain("表单要求输入手机号");
  expect(signals).toContain("表单要求输入短信验证码");
  expect(signals).toContain("表单要求输入密码");
  expect(signals).toContain("表单提交到外部域名（collect.example）");
  expect(signals).toContain("存在 App 安装包下载入口");
  expect(signals).toContain("页面内嵌 1 个 iframe");
  // 用当前关键词表里的词（退款/退款通道），避免测试与词表内容耦合
  expect(signals.some((s) => s.startsWith("页面文本命中风险关键词:"))).toBe(true);
  expect(signals.some((s) => s.includes("退款"))).toBe(true);

  const landing = out.landing as Record<string, unknown>;
  expect(landing.app_links).toEqual(["https://cdn.example/app/release.apk"]);
  expect(landing.external_link_count).toBe(1); // 只有 <a href> 计入，iframe 不算
  const forms = landing.forms as { inputs: unknown[] }[];
  expect(forms[0]!.inputs.length).toBe(3); // hidden 输入被过滤
  expect((out.notice as string)).toContain("不可信");
  expect((out.caveat as string)).toContain("不构成最终定性");
});

test("非网页落地：APK 直链与未知 content-type 只记录不解析", async () => {
  const apkTool = makeTool(async () =>
    new Response("MZ binary...", {
      status: 200,
      headers: { "content-type": "application/vnd.android.package-archive" },
    })
  );
  const apkOut = (await apkTool.execute({ url: "https://dl.example/app.apk" })) as Record<string, unknown>;
  expect((apkOut.signals as string[])).toContain("存在 App 安装包下载入口");
  expect(((apkOut.landing as Record<string, unknown>).note as string)).toContain("安装包");

  const binTool = makeTool(async () =>
    new Response("", { status: 200, headers: { "content-type": "application/octet-stream" } })
  );
  const binOut = (await binTool.execute({ url: "https://x.example/file" })) as Record<string, unknown>;
  expect(((binOut.landing as Record<string, unknown>).note as string)).toContain("非网页内容");
});

test("extractHtmlFeatures 纯函数：title/表单/链接/meta refresh", () => {
  const features = extractHtmlFeatures(
    `<html><head><title>T</title><meta http-equiv="refresh" content="0; url=/go"></head>
     <body><form action="/submit"><input name="q"><textarea name="msg"></textarea></form>
     <a href="HTTPS://OUT.Example/a">x</a></body></html>`,
    "https://base.example/dir/page"
  );
  expect(features.title).toBe("T");
  expect(features.forms[0]!.action).toBe("https://base.example/submit");
  expect(features.forms[0]!.inputs).toEqual([
    { type: "text", name: "q" },
    { type: "textarea", name: "msg" },
  ]);
  expect(features.externalLinks).toEqual(["https://out.example/a"]);
  expect(features.metaRefresh).toBe("https://base.example/go");
});

test("畸形 action / meta refresh 只丢解析结果，不中断整次采证", () => {
  // 页面 HTML 攻击者可控：一条畸形属性不该让已经拿到的正文、表单、跳转链全部作废
  const features = extractHtmlFeatures(
    `<html><head><title>T</title><meta http-equiv="refresh" content="0;url=http://"></head>
     <body><form action="http://"><input name="phone"></form></body></html>`,
    "https://base.example/dir/page"
  );
  expect(features.forms[0]!.action).toBe("http://"); // 解析不了就原样保留，"畸形"本身是证据
  expect(features.metaRefresh).toBe("http://");
  expect(features.forms[0]!.inputs).toEqual([{ type: "text", name: "phone" }]);
});

test("落地页含畸形属性时工具仍返回完整证据", async () => {
  const tool = makeTool(async () =>
    htmlResponse(`<title>t</title><form action="http://"><input name="phone"></form>`)
  );
  const result = (await tool.execute({ url: "https://a.example/x" })) as any;

  expect(result.landing.title).toBe("t");
  expect(result.landing.forms[0].action).toBe("http://");
  expect(result.signals).toContain("表单要求输入手机号");
});

test("URL 归一化：无 scheme 的粘贴域名补 https，非法输入给人话而不是裸 TypeError", async () => {
  const seen: string[] = [];
  const tool = createInspectLinkTool({
    browserInspect: async (url) => {
      seen.push(url);
      return { access_status: "observed", capture_status: "complete" };
    },
  });

  await tool.execute({ url: "example.com/verify?t=1", mode: "browser" });
  expect(seen).toEqual(["https://example.com/verify?t=1"]);

  // 带端口但没有 scheme 的写法不能被当成 scheme=example.com
  await tool.execute({ url: "example.com:8443/verify", mode: "browser" });
  expect(seen[1]).toBe("https://example.com:8443/verify");

  await expect(tool.execute({ url: "http://", mode: "browser" })).rejects.toThrow("非法 URL");
  await expect(tool.execute({ url: "javascript:alert(1)", mode: "browser" })).rejects.toThrow("仅允许 http/https");
  await expect(tool.execute({ url: "file:///C:/windows/win.ini", mode: "browser" })).rejects.toThrow("仅允许 http/https");
  expect(seen.length).toBe(2); // 非法输入没有走到浏览器
});

test("同回合浏览器失败去重键用归一化后的 URL", async () => {
  let opens = 0;
  const tool = createInspectLinkTool({
    browserInspect: async () => {
      opens++;
      return { access_status: "failed" };
    },
  });
  const runtime = { browserFailures: new Set<string>() };

  const first = (await tool.execute({ url: "example.com/a", mode: "browser" }, runtime)) as any;
  expect(first.browser.access_status).toBe("failed");
  const second = (await tool.execute({ url: "https://example.com/a", mode: "browser" }, runtime)) as any;
  expect(second.browser.access_status).toBe("retry_blocked");
  expect(opens).toBe(1);
});

test("运行时取消信号会中止抓取", async () => {
  const tool = makeTool(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      })
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("用户取消")), 20);
  await expect(tool.execute({ url: "https://slow.example/x" }, { signal: controller.signal })).rejects.toThrow(
    "用户取消"
  );
});

// ───────────────────────── 人机校验 / 反爬识别 ─────────────────────────

test("detectProtection：响应头与页面特征都能识别厂商", () => {
  // Cloudflare：cf-mitigated 是最强信号（服务端直接声明"这是一次拦截"）
  const cf = detectProtection(
    { "cf-ray": "a4a7228e095c8211-SIN", "cf-mitigated": "challenge", server: "cloudflare" },
    "<html><title>Just a moment...</title><script src=\"/cdn-cgi/challenge-platform/x\"></script></html>"
  );
  expect(cf.vendor).toBe("cloudflare");
  expect(cf.blocked).toBe(true);
  expect(cf.evidence.some((e) => e.includes("cf-mitigated"))).toBe(true);
  expect(cf.evidence.some((e) => e.includes("cf-ray"))).toBe(true);

  // 只有页面特征也算（有些站点不返回 cf-* 头）
  const cfBodyOnly = detectProtection({}, "<html><title>Just a moment...</title></html>");
  expect(cfBodyOnly.vendor).toBe("cloudflare");
  expect(cfBodyOnly.blocked).toBe(true);

  // Akamai 的 cookie/脚本特征
  const akamai = detectProtection({}, "<script>var _abck='x'; var bm_sz='y';</script>");
  expect(akamai.vendor).toBe("akamai");
  expect(akamai.blocked).toBe(false); // 厂商脚本不能证明内容被拦截

  // 普通页面：不误报
  const clean = detectProtection(
    { server: "nginx", "content-type": "text/html" },
    "<html><head><title>欢迎</title></head><body><p>正常内容，客服中心</p></body></html>"
  );
  expect(clean.blocked).toBe(false);
  expect(clean.vendor).toBeUndefined();
  expect(clean.evidence).toEqual([]);

  // 正文里出现 "just a moment" 但 title 不是挑战页 → 不应误判为挑战
  const falsePositive = detectProtection({}, "<html><title>客服中心</title><p>wait just a moment please</p></html>");
  expect(falsePositive.blocked).toBe(false);
});

test("Cloudflare 挑战：landing 标记 blocked、note 说明、并产出独立信号", async () => {
  const challengeHtml =
    '<html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div></body></html>';
  const tool = makeTool(
    async () =>
      new Response(challengeHtml, {
        status: 403,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cf-ray": "a4a7228e095c8211-SIN",
          "cf-mitigated": "challenge",
          server: "cloudflare",
        },
      })
  );
  const out = (await tool.execute({ url: "https://walled.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;

  expect(landing.blocked).toBe(true);
  expect(landing.protection).toBe("cloudflare");
  expect(Array.isArray(landing.block_evidence)).toBe(true);
  // 证据头被保留（且不含 set-cookie 这类敏感头）
  expect((landing.headers as Record<string, string>)["cf-mitigated"]).toBe("challenge");
  expect(String(landing.note)).toContain("人机校验/拦截页");
  // 独立信号：这是"没有内容可分析"的原因，也是风险线索
  const signals = out.signals as string[];
  expect(signals.some((s) => s.includes("人机校验/反爬拦截"))).toBe(true);
  expect(signals.some((s) => s.includes("cloudflare"))).toBe(true);
});

test("普通 403（非防护层）也会作为独立信号报出", async () => {
  const tool = makeTool(
    async () => new Response("<html><title>Forbidden</title></html>", { status: 403, headers: { "content-type": "text/html" } })
  );
  const out = (await tool.execute({ url: "https://deny.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;
  expect(landing.blocked).toBeUndefined();
  expect((out.signals as string[]).some((s) => s.includes("403"))).toBe(true);
});

test("跳转链每一跳都带上关键响应头（便于事后定位是谁拦的）", async () => {
  let hop = 0;
  const tool = makeTool(async () => {
    hop++;
    if (hop === 1) {
      return new Response(null, {
        status: 301,
        headers: { location: "https://next.example/b", server: "cloudflare", "cf-ray": "ray-1-SIN" },
      });
    }
    return new Response("<html><title>ok</title></html>", { status: 200, headers: { "content-type": "text/html" } });
  });
  const out = (await tool.execute({ url: "https://first.example/a" })) as Record<string, unknown>;
  const chain = out.redirect_chain as Array<Record<string, unknown>>;
  expect(chain).toHaveLength(1);
  expect(chain[0]!.headers).toEqual({ server: "cloudflare", "cf-ray": "ray-1-SIN" });
});

// ───────────────────────── 网络层失败归一化 ─────────────────────────

test("站点拒绝连接：归一成 blocked 证据 + 重试一次，而不是抛错", async () => {
  let attempts = 0;
  const tool = makeTool(async () => {
    attempts++;
    throw Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
  });
  const out = (await tool.execute({ url: "https://reject.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;

  expect(landing.blocked).toBe(true);
  expect(landing.network_failure).toBe("connection_rejected");
  expect(landing.status).toBe(0);
  expect(String(landing.note)).toContain("无法确定原因");
  expect(String(landing.note)).toContain("已重试 1 次");
  const signals = out.signals as string[];
  expect(signals.some((s) => s.includes("未取得页面内容"))).toBe(true);
  expect(signals.some((s) => s.includes("原因未确定"))).toBe(true);
  // 重试确实发生了：1 次原始 + 1 次重试
  expect(attempts).toBe(2);
  // 明确告诉模型"没抓到 ≠ 没问题"
  expect(String(out.caveat)).toContain("不能");
});

test("超时（中文文案）也归一成证据，并重试一次", async () => {
  let attempts = 0;
  const tool = makeTool(async (_url, init) => {
    attempts++;
    // 复刻网络超时的错误文案（真实实现里来自 combineSignals 的 abort reason）
    throw new Error("单次请求超时（15000ms）");
  });
  const out = (await tool.execute({ url: "https://slow.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;
  expect(landing.blocked).toBe(true);
  expect(landing.network_failure).toBe("timeout");
  expect(attempts).toBe(2);
});

test("DNS 不存在：归一成证据且不重试（重试也没意义）", async () => {
  let attempts = 0;
  const tool = makeTool(async () => {
    attempts++;
    throw Object.assign(new TypeError("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" });
  });
  const out = (await tool.execute({ url: "https://nope.example/x" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;
  expect(landing.blocked).toBe(true);
  expect(landing.network_failure).toBe("dns_failure");
  expect(attempts).toBe(1);
});

test("SSRF 守卫的拒绝仍然抛错，不被归一成'站点拒绝'", async () => {
  // 内网 IP：必须抛（这是我们主动拦截，不是站点行为）
  const privateTool = makeTool(async () => htmlResponse("x"));
  await expect(privateTool.execute({ url: "http://10.0.0.1/x" })).rejects.toThrow("SSRF 防护");

  // 解析结果为空（DNS 解析失败）：守卫的拒绝同样要抛，不能变成"域名不存在"证据
  const noDns = makeTool(async () => htmlResponse("x"), async () => []);
  await expect(noDns.execute({ url: "https://blackhole.example/x" })).rejects.toThrow("DNS 解析失败");
});

test("重试上限可配置：maxRetries=0 时不重试", async () => {
  let attempts = 0;
  const tool = createInspectLinkTool({
    fetchImpl: async () => {
      attempts++;
      throw Object.assign(new Error("socket connection was closed"), { code: "ECONNRESET" });
    },
    lookupImpl: PUBLIC_LOOKUP,
    maxRetries: 0,
  });
  await tool.execute({ url: "https://once.example/x" });
  expect(attempts).toBe(1);
});

test("属性解析三处回归：title 实体解码、引号内空格、meta refresh 属性顺序", () => {
  // title 的实体必须解码：htmlToText 跳过 <head>，实体编码的关键词只能在这里被解出
  const titled = extractHtmlFeatures(
    "<html><head><title>恭喜您中&#22870;&#20102;</title></head><body>x</body></html>",
    "https://base.example/"
  );
  expect(titled.title).toBe("恭喜您中奖了");

  // 引号内的空格不能截断属性值（旧实现只取到"请输入"，"验证码"信号丢失）
  const spaced = extractHtmlFeatures(
    '<html><body><form action="/x"><input name="code" placeholder="请输入 短信验证码"></form></body></html>',
    "https://base.example/"
  );
  expect(spaced.forms[0]!.inputs[0]!.placeholder).toBe("请输入 短信验证码");

  // meta refresh 的 content 写在 http-equiv 前面同样合法，必须识别
  const reordered = extractHtmlFeatures(
    '<html><head><meta content="0;url=https://jump.example/go" http-equiv="refresh"></head><body>x</body></html>',
    "https://base.example/"
  );
  expect(reordered.metaRefresh).toBe("https://jump.example/go");
});

test("title 里的实体编码关键词能进 signals（端到端）", async () => {
  const tool = makeTool(async () =>
    htmlResponse("<html><head><title>官方&#36864;&#27454;中心</title></head><body>正文没有风险词</body></html>")
  );
  const out = (await tool.execute({ url: "https://titlekw.example/x" })) as Record<string, unknown>;
  expect(out.signals).toContain("页面文本命中风险关键词: 退款");
});

test("总时长预算：超限后停在原地保留链路，不算站点故障", async () => {
  const seen: string[] = [];
  const tool = createInspectLinkTool({
    // mock 不响应 abort 信号：预算超限靠"跳与跳之间"的检查兜住，正好验证这条路径
    fetchImpl: async (url: string) => {
      seen.push(url);
      await new Promise((r) => setTimeout(r, 60));
      return redirectResponse(`https://n${seen.length}.example/x`);
    },
    lookupImpl: PUBLIC_LOOKUP,
    totalTimeoutMs: 90,
  });
  const out = (await tool.execute({ url: "https://a.example/a" })) as Record<string, unknown>;
  const landing = out.landing as Record<string, unknown>;
  expect(String(landing.note)).toContain("总时长达到");
  expect(landing.status).toBe(0);
  expect(landing.network_failure).toBeUndefined(); // 是我们主动停，不是站点故障
  expect(out.redirect_chain).toHaveLength(2); // 已采到的跳转链保留
  expect(seen).toEqual(["https://a.example/a", "https://n1.example/x"]);
  expect((out.signals as string[]).some((s) => s.includes("总时长达到"))).toBe(true);
});

test("classifyNetworkFailure 同时认 Bun 与 Node 两套错误码词汇", () => {
  // Bun：自己的码 + 文案（实测 2048.vip 就是这个形状：DNS 能解析，但连接被拒）
  expect(
    classifyNetworkFailure(
      Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), {
        code: "ConnectionRefused",
      })
    ).kind
  ).toBe("connection_rejected");
  expect(classifyNetworkFailure(Object.assign(new Error("boom"), { code: "ConnectionClosed" })).kind).toBe("connection_rejected");
  expect(classifyNetworkFailure(Object.assign(new Error("boom"), { code: "FailedToOpenSocket" })).kind).toBe("connection_rejected");
  expect(classifyNetworkFailure(Object.assign(new Error("boom"), { code: "ConnectionTimedOut" })).kind).toBe("timeout");
  // Node / undici 的词汇
  expect(classifyNetworkFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).kind).toBe("connection_rejected");
  expect(classifyNetworkFailure(new Error("The socket connection was closed unexpectedly")).kind).toBe("connection_rejected");
  expect(
    classifyNetworkFailure(Object.assign(new TypeError("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" })).kind
  ).toBe("dns_failure");
  // 内部超时用中文文案（来自 combineSignals 的 abort reason）
  expect(classifyNetworkFailure(new Error("单次请求超时（15000ms）")).kind).toBe("timeout");
  // 不认识的一律 other：不重试、也不当成"站点拒绝"
  expect(classifyNetworkFailure(new Error("boom")).kind).toBe("other");
});
