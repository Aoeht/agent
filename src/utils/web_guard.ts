// src/utils/web_guard.ts
// 访问防护纯函数：SSRF 守卫（内网/保留地址判定）+ 人机校验/反爬厂商指纹识别。
// 从 src/tools/inspect_link.ts 拆出 —— inspect_link（HTTP 采证）与 browser_inspector
// （浏览器采证）共用，原先 browser_inspector 反向 import inspect_link 形成循环依赖。
// 不含网络 IO：lookup 由调用方注入，可直接用样本测试。

import { isIP } from "node:net";

export type LookupLike = (hostname: string) => Promise<{ address: string; family: number }[]>;

/**
 * 人机校验 / 反爬厂商指纹：响应头标记 + 页面特征标记。
 * 厂商特征仅用于识别基础设施；不能据此推断拦截或诈骗。
 */
const PROTECTION_VENDORS: Array<{ vendor: string; headerMarks?: string[]; bodyMarks: RegExp[] }> = [
  {
    vendor: "cloudflare",
    headerMarks: ["cf-ray", "cf-mitigated", "cf-cache-status"],
    bodyMarks: [
      /challenge-platform/i,
      /cdn-cgi\/challenge/i,
      /__cf_chl/i,
      /cf_chl_opt/i,
      /cf-mitigated/i,
      // 挑战页标题就是这四个词；用 <title> 里的精确短语，避免把正文里出现 "just a moment" 的普通页面误判
      /<title[^>]*>\s*just a moment/i,
      /turnstile/i,
      /checking your browser/i,
    ],
  },
  {
    vendor: "akamai",
    headerMarks: ["x-akamai-transformed"],
    bodyMarks: [/_abck/i, /ak_bmsc/i, /bm_sz/i, /akamai/i],
  },
  { vendor: "datadome", headerMarks: ["x-datadome"], bodyMarks: [/datadome/i, /dd_cookie_test/i] },
  { vendor: "perimeterx", bodyMarks: [/perimeterx/i, /_pxhd/i, /px-captcha/i, /human-challenge/i] },
  { vendor: "imperva", bodyMarks: [/incapsula/i, /visid_incap/i, /_incap_ses/i] },
  { vendor: "recaptcha", bodyMarks: [/www\.google\.com\/recaptcha/i, /g-recaptcha/i, /grecaptcha/i] },
  { vendor: "hcaptcha", bodyMarks: [/hcaptcha\.com/i, /h-captcha/i] },
];

/**
 * 人机校验 / 拦截特征识别。纯函数，便于用样本直接测。
 * `blocked` 的含义是明确的："这次拿到的不是目标内容，而是防护层"。
 */
export function detectProtection(
  headers: Record<string, string>,
  body: string
): { vendor?: string; blocked: boolean; evidence: string[] } {
  const evidence: string[] = [];
  let vendor: string | undefined;

  for (const descriptor of PROTECTION_VENDORS) {
    const headerHits = (descriptor.headerMarks ?? []).filter((name) => {
      const value = headers[name];
      return value !== undefined && value !== "";
    });
    const bodyHits = descriptor.bodyMarks.some((re) => re.test(body));
    if (headerHits.length === 0 && !bodyHits) continue;
    vendor ??= descriptor.vendor;
    for (const name of headerHits) evidence.push(`响应头 ${name}=${headers[name]!.slice(0, 60)}`);
    if (bodyHits) evidence.push(`页面含 ${descriptor.vendor} 挑战特征`);
  }

  // Cloudflare 会把"这是一次拦截"直接写在响应头里，这是最强的信号
  const mitigated = headers["cf-mitigated"];
  if (mitigated) evidence.push(`cf-mitigated=${mitigated}`);

  const blocked = headers["cf-mitigated"]?.toLowerCase() === "challenge" ||
    /<title[^>]*>\s*(?:just a moment|access denied|attention required)|checking your browser|verify (?:that )?you are human|请完成人机验证/i.test(body);
  return { ...(vendor ? { vendor } : {}), blocked, evidence: [...new Set(evidence)] };
}

/**
 * IPv6 → 8 个 16 位组；写法非法时返回 undefined。
 * 必须真正解析而不是靠字符串前缀：NAT64（64:ff9b::/96）、6to4（2002::/16）、
 * IPv4 映射/转换（::ffff:…）都能把一个内网 IPv4 藏进"看起来正常"的 IPv6 字面量里。
 * 只接受规范写法（"::" 最多一个、点分十进制只能收尾）；dns.lookup 返回的就是规范形式。
 */
function parseIpv6Groups(value: string): number[] | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;

  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups: number[] = [];
    const tokens = part.split(":");
    for (const [index, token] of tokens.entries()) {
      if (token!.includes(".")) {
        // 点分十进制只能出现在最后一段，占 2 个组
        if (index !== tokens.length - 1) return undefined;
        const quad = token!.split(".").map(Number);
        if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
        groups.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token!)) return undefined;
      groups.push(Number.parseInt(token!, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]!);
  if (!head) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const tail = parseGroups(halves[1]!);
  if (!tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined; // "::" 至少要压缩掉一组
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** 两个 16 位组还原成点分十进制，用于递归判定内嵌的 IPv4 */
function embeddedIpv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** 内网/保留地址段判定：IPv4 精确到常用段，IPv6 规范成 8 组后按"只放行全球单播"判。SSRF 防护的核心。 */
export function isPrivateAddress(ip: string): boolean {
  const value = ip.trim().toLowerCase();

  // IPv4 点分十进制（dns.lookup 不会返回八进制/十六进制形式）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split(".").map(Number) as [number, number, number, number];
    // 段必须 ≤255：dns.lookup 不会返回非法写法，但直接调用时认不出来的按不安全处理（与 IPv6 分支同一原则）
    if (parts.some((n) => n > 255)) return true;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast（已废弃，仍不该作为目标）
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // 组播 + 保留 + 广播
    return false;
  }

  const groups = parseIpv6Groups(value);
  if (!groups) return true; // 认不出来的写法一律按不安全处理（只会在直接调用时出现）
  const g = (index: number) => groups[index]!;
  const zeros = (from: number, to: number) => groups.slice(from, to + 1).every((part) => part === 0);

  // 内嵌 IPv4 的形式先按内嵌地址递归判：这些写法在 IPv6-only/隧道网络里是真实存在的
  // （DNS64/NAT64 下正常域名也会解析成 64:ff9b::/96），所以不能整段拦，要看内嵌地址本身
  if (zeros(0, 3) && ((g(4) === 0xffff && g(5) === 0) || (g(4) === 0 && g(5) === 0xffff))) {
    // IPv4 映射 ::ffff:a.b.c.d 与 IPv4 转换 ::ffff:0:a.b.c.d：内嵌地址在最后 32 位
    return isPrivateAddress(embeddedIpv4(g(6), g(7)));
  }
  if (g(0) === 0x0064 && g(1) === 0xff9b) {
    // NAT64 64:ff9b::/96（内嵌在最后 32 位）；64:ff9b:1::/48 是本地用途段，整段拦
    return zeros(2, 5) ? isPrivateAddress(embeddedIpv4(g(6), g(7))) : true;
  }
  if (g(0) === 0x2002) return isPrivateAddress(embeddedIpv4(g(1), g(2))); // 6to4 2002:V4ADDR::/48
  if (g(0) === 0x2001 && g(1) === 0x0000) return true; // Teredo 2001::/32（客户端地址按位取反藏在末 32 位）

  // 其余只放行全球单播 2000::/3（RFC 4291）：这一条同时覆盖 ::/128、::1、::/96 兼容地址、
  // fc00::/7 ULA、fe80::/10 link-local、fec0::/10 已废弃 site-local、ff00::/8 组播、100::/64 丢弃前缀，
  // 以及 4000::/3 等尚未分配的空间——白名单比逐个列举保留段更难漏
  if ((g(0) & 0xe000) !== 0x2000) return true;

  // 2000::/3 内部的特例段
  if (g(0) === 0x2001 && g(1) === 0x0db8) return true; // 2001:db8::/32 文档段
  if (g(0) === 0x2001 && g(1) === 0x0002 && g(2) === 0) return true; // 2001:2::/48 基准测试段
  if ((g(0) & 0xfff0) === 0x3ff0) return true; // 3fff::/20 文档段（RFC 9637）
  return false;
}

/** 标记位：SSRF 守卫主动抛出的错误，上层不得把它当成"站点拒绝"归一成证据 */
export const GUARD_BLOCK = Symbol("guardBlock");

/** 校验一个跳转目标：仅 http/https，且解析出的所有 IP 都不在内网/保留段 */
export async function assertPublicHost(target: URL, lookup: LookupLike): Promise<void> {
  if (!/^https?:$/.test(target.protocol)) {
    throw markGuardBlocked(new Error(`SSRF 防护：仅允许 http/https 协议，收到 ${target.protocol}`));
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw markGuardBlocked(new Error(`SSRF 防护：目标指向内网/保留地址 ${hostname}，已拦截`));
    }
    return;
  }
  const addresses = await lookup(hostname);
  if (addresses.length === 0) {
    throw markGuardBlocked(new Error(`DNS 解析失败：${hostname}`));
  }
  const blocked = addresses.filter((a) => isPrivateAddress(a.address));
  if (blocked.length > 0) {
    throw markGuardBlocked(
      new Error(
        `SSRF 防护：${hostname} 解析到内网/保留地址（${blocked.map((b) => b.address).join(", ")}），已拦截`
      )
    );
  }
}

function markGuardBlocked(error: Error): Error {
  Object.defineProperty(error, GUARD_BLOCK, { value: true, enumerable: false });
  return error;
}
