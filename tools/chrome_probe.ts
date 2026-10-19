// 对照实验：Chrome 能不能"看起来就是真人浏览器"，以及"用户真实 profile"是否必要。
//
// 为什么需要这个脚本：DSH 的受限沙箱会阻止 Chrome 启动（崩在崩溃处理器上），
// 所以这个结论必须在**你的正常终端**里跑出来，不能在沙箱里测。
//
// 用法（在项目根目录）：
//   bun run tools/chrome_probe.ts                     # 专用全新 profile（推荐，已验证能过 Cloudflare）
//   bun run tools/chrome_probe.ts <url> [url...]      # 指定要测的站点
//   bun run tools/chrome_probe.ts --real-profile      # 你的真实 Chrome profile（先完全退出 Chrome）
//   bun run tools/chrome_probe.ts --keep-open         # 结束后不关 Chrome
//
// 安全说明：
// - 用 --real-profile 时，请**先完全退出 Chrome**，否则 profile 被占锁会失败；
// - 脚本只读取 title / body.innerText 摘要 / cookie 名称与域名，不读取 cookie 值、不落盘；
// - 只访问下面的白名单站点。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
];
const CHROME = CHROME_CANDIDATES.find((p) => p && existsSync(p));
const REAL_PROFILE = `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`;
const DEDICATED_PROFILE = join(process.cwd(), ".chrome-sandbox-profile");

// 默认只测反爬站点，不主动碰可疑/成人站点。
// 想测别的：在命令行末尾追加 URL，例如
//   bun run tools/chrome_probe.ts https://example.com https://another.example
const DEFAULT_TARGETS = ["https://hltv.org", "https://www.zukongguan.vip"];
const cliTargets = process.argv.slice(2).filter((a) => /^https?:\/\//i.test(a));
const TARGETS = cliTargets.length > 0 ? cliTargets : DEFAULT_TARGETS;
const PORT = 9401;
const useRealProfile = process.argv.includes("--real-profile");
const keepOpen = process.argv.includes("--keep-open");

if (!CHROME) {
  console.error("找不到 chrome.exe，请手动改脚本里的路径");
  process.exit(1);
}
if (!useRealProfile) mkdirSync(DEDICATED_PROFILE, { recursive: true });

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    let id = 1;
    ws.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; result?: any; error?: any };
      if (msg.id === undefined) return;
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      msg.error ? slot.rej(new Error(JSON.stringify(msg.error))) : slot.res(msg.result);
    });
    ws.addEventListener("error", () => reject(new Error("CDP 连接失败")));
    ws.addEventListener("open", () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const n = id++;
            pending.set(n, { res, rej });
            ws.send(JSON.stringify({ id: n, method, params }));
          }),
        close: () => ws.close(),
      })
    );
  });
}

/** 解析可能带横幅前缀的 JSON 响应（Chrome 会在 JSON 前面打印提示文字） */
function parseLoose(text: string, label: string, status: number): any {
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error(`${label} 未返回 JSON（HTTP ${status}）：${text.slice(0, 100)}`);
  }
  return JSON.parse(text.slice(start));
}

const json = async (path: string): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} 返回 HTTP ${res.status}：${text.slice(0, 100)}`);
  return parseLoose(text, path, res.status);
};

/** 新建标签页：新版 Chrome 要求 PUT；GET 作兜底（会附带"unsafe verb"横幅，已能容忍） */
const newTarget = async (url: string): Promise<any> => {
  let lastError = "";
  for (const method of ["PUT", "GET"] as const) {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method });
    const text = await res.text();
    // 只要体里能找到 JSON 就用它（横幅不影响）；找不到再换下一个方法
    const start = text.indexOf("{");
    if (start !== -1) return JSON.parse(text.slice(start));
    lastError = `${method} → HTTP ${res.status} ${text.slice(0, 80)}`;
  }
  throw new Error(`/json/new 失败（PUT/GET 都试过）：${lastError}`);
};

async function waitPort(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await json("/json/version");
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

const profile = useRealProfile ? REAL_PROFILE : DEDICATED_PROFILE;
console.log(`对照组: ${useRealProfile ? "B（真实 profile）" : "A（专用全新 profile）"}`);
console.log(`profile: ${profile}`);
if (useRealProfile) console.log("提示：若 Chrome 正在运行，这一步会失败——请先完全退出 Chrome。\n");

const child = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    ...(useRealProfile ? ["--profile-directory=Default"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "about:blank",
  ],
  { stdio: "ignore" }
);

let chromeExited: number | null = null;
child.on("exit", (code) => (chromeExited = code ?? -1));

/** 打开一个标签页、等挑战脚本跑完、读出"到底看到了内容还是挑战页" */
async function probe(connectFn: (ws: string) => Promise<Cdp>, url: string): Promise<void> {
  const target = await newTarget(url);
  const cdp = await connectFn(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Page.enable");
    // 等到"正文出现"或超时：固定 sleep 会同时冤枉快站（白等）和慢站（还没渲染完就取样）。
    // 首次给 2 秒（让挑战脚本/首屏有时间跑），之后每 500ms 复查一次正文长度。
    const readText = async () =>
      String(
        (await cdp.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }))
          .result?.value ?? ""
      )
        .replace(/\s+/g, " ")
        .trim();

    await new Promise((r) => setTimeout(r, 2000));
    let text = await readText();
    const deadline = Date.now() + 13_000;
    while (text.length < 200 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const next = await readText();
      // 正文没再增长且已经等够了，就不再耗时间
      if (next.length === text.length && Date.now() > deadline - 8000) break;
      text = next;
    }

    const title: any = await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
    const html: any = await cdp.send("Runtime.evaluate", {
      expression: "document.documentElement ? document.documentElement.outerHTML : ''",
      returnByValue: true,
    });
    const ck: any = await cdp.send("Network.getCookies", { urls: [url] });
    const rawHtml = String(html.result?.value ?? "");
    const names: string[] = (ck.cookies ?? []).map((c: any) => `${c.name}@${c.domain}`);
    const cleared = names.some((n) => n.startsWith("cf_clearance"));
    const titleText = String(title.result?.value ?? "");
    const looksEmpty = text.length === 0;

    // Chrome 导航失败时会渲染**它自己的错误页**（内容随语言/版本变化，这里同时匹配中英文），
    // 不能当成"站点的短页面"。这类失败是网络层封禁，与"页面是空壳"性质完全不同。
    const chromeError = /ERR_[A-Z_]+/.exec(text)?.[0];
    const errorPageText =
      /无法访问此网站|连接已重置|连接已超时|找不到服务器|拒绝了我们的连接|This site can't be reached|ERR_[A-Z_]+/i.test(text);

    // 挑战页判据：**没有可见正文** 且 有挑战标记，或者标题就是挑战页标题。
    // 只看"HTML 里有 challenge-platform"会把正常站点误判——很多站正常页面也带 Turnstile。
    const challengeTitle = /just a moment|attention required|checking your browser|请稍候|验证中/i.test(titleText);
    const challengeMarkers = /cf_chl_opt|__cf_chl|cdn-cgi\/challenge|turnstile\/v0|_abck|datadome|perimeterx/i.test(rawHtml);
    const isChallenge = challengeTitle || (looksEmpty && challengeMarkers);

    console.log(`${url}`);
    console.log(`  title     : ${JSON.stringify(titleText)}`);
    console.log(`  正文长度  : ${text.length} 字（HTML ${rawHtml.length} 字节）`);
    console.log(`  正文摘要  : ${JSON.stringify(text.slice(0, 160))}`);
    console.log(`  cookie    : ${names.length} 个${cleared ? "（含 cf_clearance → 挑战已通过）" : ""}`);
    console.log(
      `  判定      : ${
        errorPageText
          ? `⚠️ 连接失败（Chrome 错误页${chromeError ? `：${chromeError}` : ""}）——站点拒绝本次连接`
          : isChallenge
            ? `⚠️ 仍是挑战/人机校验页（${challengeTitle ? "标题特征" : "无正文 + 挑战标记"}）`
            : text.length < 200
              ? `拿到了页面但内容很短（${text.length} 字，可能本就是导航/空壳页）`
              : "内容可见 ✅"
      }\n`
    );
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => undefined);
  }
}

try {
  const ready = await waitPort();
  if (!ready) {
    console.log(`\n❌ 调试端口未就绪。进程退出码=${chromeExited ?? "（仍存活但无端口）"}`);
    if (useRealProfile) console.log("   最常见原因：Chrome 已在运行（profile 被占用）。请完全退出 Chrome 后重试。");
    process.exitCode = 1;
  } else {
    const version = await json("/json/version");
    console.log(`✅ CDP 就绪: ${version.Browser}\n`);
    for (const url of TARGETS) await probe(connect, url);
  }
} catch (error) {
  // 之前这里只有 finally，异常会被静默吞掉（表现为"什么都没打印就退出"）
  console.error(`\n❌ 探针失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (!keepOpen) {
    child.kill();
    console.log("已关闭实验用 Chrome");
  } else {
    console.log("保留 Chrome 运行中（--keep-open），请自行关闭");
  }
}
