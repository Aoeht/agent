import { extractLinks } from "./links";
import { normalizeTranscript, type VideoSnapshot } from "./snapshot";

type ContactKind = "wechat" | "qq" | "qq_group" | "phone" | "email" | "domain";
interface ContactEvidence { source: string; ref: string; excerpt: string; t?: number }
interface ContactAssociation {
  kind: ContactKind;
  value: string;
  sources: string[];
  occurrences: number;
  evidence: ContactEvidence[];
}

/** 只关联明确标识；类型不同不合并，同域名也不等于同一账号或同一控制者。 */
export function associateContacts(snapshot: VideoSnapshot) {
  const found = new Map<string, ContactAssociation>();
  const patterns: Array<[ContactKind, RegExp]> = [
    ["wechat", /(?<![a-z0-9_])(?:微信(?:号)?|微[信讯]|vx|wechat)\s*[:：=号]?\s*([a-z][a-z0-9_-]{5,19})(?![a-z0-9_-])/gi],
    ["qq", /(?<![a-z0-9_])(?:qq(?:号)?|扣扣)\s*[:：=号]?\s*([1-9][0-9]{4,11})(?![0-9])/gi],
    ["qq_group", /(?<![a-z0-9_])qq群(?:号)?\s*[:：=]?\s*([1-9][0-9]{4,11})(?![0-9])/gi],
    ["phone", /(?<![a-z0-9_])(?:手机(?:号)?|电话|tel)\s*[:：=]?\s*(?:\+?86[ -]?)?(1[3-9][0-9](?:[ -]?[0-9]){8})(?![0-9])/gi],
    ["email", /([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi],
  ];
  const collect = (original: string, source: string, ref: string, t?: number) => {
    const text = original.normalize("NFKC");
    const seen = new Set<string>();
    const add = (kind: ContactKind, value: string, excerpt: string) => {
      if (value.length > 254) return;
      const key = `${kind}:${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      const entry = found.get(key) ?? { kind, value, sources: [], occurrences: 0, evidence: [] };
      entry.occurrences += 1;
      if (!entry.sources.includes(source)) {
        entry.sources.push(source);
        entry.evidence.push({ source, ref, excerpt: excerpt.slice(0, 120), ...(t === undefined ? {} : { t }) });
      }
      found.set(key, entry);
    };
    for (const [kind, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        // 邮箱 local-part 保留大小写，域名可忽略大小写；避免强行合并不同地址。
        const raw = match[1]!;
        const value = kind === "phone" ? raw.replace(/[ -]/g, "")
          : kind === "email" ? raw.slice(0, raw.lastIndexOf("@") + 1) + raw.slice(raw.lastIndexOf("@") + 1).toLowerCase()
          : raw.toLowerCase();
        add(kind, value, text.slice(Math.max(0, match.index! - 25), match.index! + match[0].length + 25));
      }
    }
    for (const link of extractLinks(text, source)) {
      try {
        const host = new URL(`https://${link.normalized}`).hostname.replace(/^www\./, "");
        add("domain", host, link.raw);
      } catch { /* 不把无法解析的域名候选作为关联依据 */ }
    }
  };
  collect(snapshot.video?.title ?? "", "title", "video.title");
  collect(snapshot.video?.desc ?? "", "desc", "video.desc");
  collect(snapshot.author?.name ?? "", "author_name", "author.name");
  collect(snapshot.author?.sign ?? "", "author_sign", "author.sign");
  snapshot.danmaku.forEach((entry, i) => collect(entry.text, "danmaku", `danmaku[${i}]`, entry.t));
  snapshot.comments.forEach((entry, i) => {
    collect(entry.message, "comment", `comments[${i}]`);
    entry.replies?.forEach((reply, j) => collect(reply.message, "reply", `comments[${i}].replies[${j}]`));
  });
  normalizeTranscript(snapshot).forEach((entry, i) => collect(entry.text, "transcript", `transcript.segments[${i}]`, entry.start_s));
  const associations = [...found.values()].filter((entry) => entry.sources.length > 1)
    .sort((a, b) => b.sources.length - a.sources.length || a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value));
  return { associations: associations.slice(0, 10), total: associations.length, truncated: associations.length > 10 };
}
