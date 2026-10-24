// src/bili/links.ts
/**
 * 从自由文本（标题/简介/弹幕/评论/字幕）中提取链接候选。
 * 平台站外导流会把链接做成各种变体（中文句号当点、空格拆开、"点"字代替"."），
 * 所以除了常规 URL/域名，还做一轮"去混淆"后再匹配；候选只是线索，定性交给 inspect_link 和模型。
 * 同一主机只保留证据最强的形态（url > domain > obfuscated），同级取带路径的更完整候选。
 */
import { SHORT_LINK_HOSTS } from "../core/scam_lexicon";

export interface ExtractedLink {
  /** 原文中的片段（混淆变体没有可分离的"原文"，给归一化后的候选） */
  raw: string;
  /** 归一化候选：小写、去尾部标点；混淆变体已还原成常规写法 */
  normalized: string;
  kind: "url" | "domain" | "obfuscated";
  /** 短链域名：目的地被隐藏是主要风险特征之一 */
  short: boolean;
  /** 出现来源：title / desc / danmaku / comment / transcript 等，由调用方命名 */
  source: string;
}

const URL_RE = /https?:\/\/[^\s"'<>，。；、！？：）)】\]]+/gi;
const WWW_RE = /(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s"'<>，。；、！？：）)】\]]*)?/gi;
// 常见顶级域白名单式匹配：宁可漏过冷门后缀，也不在整段中文里撒网
const DOMAIN_RE = new RegExp(
  "[a-z0-9][a-z0-9-]{0,61}\\.(?:com|net|cn|org|cc|top|xyz|vip|icu|cyou|me|tv|app|site|online|shop|store|fun|club|art|bid|pw|info|biz|link|live|io|co|la|moe|ltd|group|tech|work|games|cloud|blog|plus|pro|red|gold|ink|zone|kim|pet|bar|lol|pics|video|website|press|edu|gov|ru|su|de|uk|jp|kr|us|tw|hk|sg|in|fr|it|es|nl|se|no|fi|dk|pl|cz|at|ch|be|pt|gr|hu|ro|bg|ua|by|tr|il|ae|sa|mx|br|ar|cl|pe|au|nz)" +
  "(?![a-z0-9-])(?:\\.[a-z]{2,3})?(\\/[^\\s\"'<>，。；、！？：）)】\\]]*)?",
  "gi",
);
const TRAILING_PUNCT = /[.,;:!?、。！？；：）)】\]"']+$/;
const KIND_RANK = { url: 3, domain: 2, obfuscated: 1 } as const;

/** 去混淆：去空格，把中文语境里代替 "." 的字符还原成点 */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[点。·•・]/g, ".")
    .replace(/[（(]\s*(?:dot|点)\s*[)）]/gi, ".")
    .replace(/[（(]\s*\.\s*[)）]/g, ".");
}

const stripWww = (host: string): string => host.replace(/^www\./, "");

export function extractLinks(text: string, source: string): ExtractedLink[] {
  const found = new Map<string, ExtractedLink>();
  const push = (rawInput: string, kind: ExtractedLink["kind"]) => {
    const raw = rawInput.replace(TRAILING_PUNCT, "");
    // 完整 URL 先剥 scheme，否则 split("/")[0] 取到的是 "https:" 而不是主机
    const withoutScheme = raw.replace(/^https?:\/\//i, "");
    const bareHost = withoutScheme.split("/")[0]!.toLowerCase();
    if (!bareHost.includes(".")) return;
    // 纯数字/版本号误报（如 "1.2.3"）
    if (/^\d+(\.\d+)+$/.test(bareHost)) return;
    const normalized = (bareHost + (withoutScheme.includes("/") ? "/" + withoutScheme.split("/").slice(1).join("/") : "")).toLowerCase();
    const host = stripWww(bareHost);
    const existing = found.get(host);
    if (existing) {
      if (KIND_RANK[kind] > KIND_RANK[existing.kind]) {
        existing.kind = kind;
        existing.normalized = normalized;
        existing.raw = raw;
      } else if (KIND_RANK[kind] === KIND_RANK[existing.kind] && normalized.length > existing.normalized.length) {
        existing.normalized = normalized;
        existing.raw = raw;
      }
      return;
    }
    found.set(host, {
      raw,
      normalized,
      kind,
      short: SHORT_LINK_HOSTS.has(host) || SHORT_LINK_HOSTS.has(bareHost),
      source,
    });
  };

  for (const match of text.matchAll(URL_RE)) push(match[0], "url");
  for (const match of text.matchAll(WWW_RE)) push(match[0], "domain");
  for (const match of text.matchAll(DOMAIN_RE)) push(match[0], "domain");
  // 混淆轮次：还原后再匹配，同一主机已在前面拿到更强证据的跳过
  for (const match of deobfuscate(text).matchAll(DOMAIN_RE)) push(match[0], "obfuscated");

  return [...found.values()];
}
