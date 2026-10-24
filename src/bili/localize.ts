// src/bili/localize.ts
/**
 * 风险窗口粗定位：把带时间戳的弹幕与字幕按时间分桶，对每桶做关键词打分
 * （诈骗词+引流词加权、链接出现加分、弹幕密度突增加分），合并出 top-K 不重叠风险窗口。
 * 粗定位只是"把模型注意力引到值得看的时间段"，窗口内的定性由 scanner 子代理完成。
 */
import { scanKeywords, type KeywordHit } from "../core/scam_lexicon";
import { extractLinks } from "./links";

/** 弹幕形态的时间文本 */
export interface TimedText {
  t: number;
  text: string;
}

/** 字幕/转写形态的时间文本 */
export interface TimedSegment {
  start_s: number;
  end_s: number;
  text: string;
}

export interface RiskWindow {
  start_s: number;
  end_s: number;
  score: number;
  has_link: boolean;
  /** 窗口内命中关键词的弹幕（最多 maxHitsPerWindow 条） */
  danmaku_hits: Array<{ t: number; text: string; terms: string[] }>;
  /** 与窗口时间重叠且命中关键词的字幕段 */
  transcript_hits: Array<{ start_s: number; end_s: number; text: string; terms: string[] }>;
  /** 窗口内字幕摘录（供模型直接读语境，超长截断） */
  transcript_excerpt: string;
}

export interface LocalizeResult {
  windows: RiskWindow[];
  bucket_seconds: number;
  /** 关键词 → 全片出现次数（含弹幕与字幕），按次数降序 */
  keyword_totals: Array<{ term: string; category: KeywordHit["category"]; count: number }>;
}

export interface LocalizeOptions {
  /** 分桶宽度，默认 10 秒 */
  bucketS?: number;
  /** 最多返回多少个窗口，默认 6 */
  topK?: number;
  /** 每个窗口最多带多少条弹幕命中，默认 10 */
  maxHitsPerWindow?: number;
  /** 字幕摘录最大字符数，默认 500 */
  excerptChars?: number;
}

const LINK_BONUS = 2;
const DENSITY_BONUS = 2;
/** 单桶内同一关键词最多计 3 次，防一条刷屏词独占得分 */
const MAX_PER_TERM = 3;

export function localizeRisks(
  danmaku: TimedText[],
  transcript: TimedSegment[],
  options: LocalizeOptions = {},
): LocalizeResult {
  const bucketS = options.bucketS ?? 10;
  const topK = options.topK ?? 6;
  const maxHits = options.maxHitsPerWindow ?? 10;
  const excerptChars = options.excerptChars ?? 500;

  const validDanmaku = danmaku.filter((d) => Number.isFinite(d.t) && d.t >= 0 && d.text.trim());
  const validTranscript = transcript.filter((s) => Number.isFinite(s.start_s) && s.text.trim());
  const maxTime = Math.max(0, ...validDanmaku.map((d) => d.t), ...validTranscript.map((s) => s.end_s));
  const bucketCount = Math.max(1, Math.ceil((maxTime + 0.001) / bucketS));

  // 桶内聚合：文本、命中词、链接、弹幕计数
  const bucketTexts: string[][] = Array.from({ length: bucketCount }, () => []);
  const bucketDanmaku: TimedText[][] = Array.from({ length: bucketCount }, () => []);
  const totals = new Map<string, KeywordHit>();

  const accumulate = (text: string): { weight: number; hasLink: boolean; terms: string[] } => {
    const hits = scanKeywords(text);
    const links = extractLinks(text, "localize");
    for (const hit of hits) {
      const key = hit.term;
      const prev = totals.get(key);
      if (prev) prev.count += hit.count;
      else totals.set(key, { ...hit });
    }
    return {
      weight: hits.reduce((sum, h) => sum + h.weight * Math.min(h.count, MAX_PER_TERM), 0),
      hasLink: links.length > 0,
      terms: hits.map((h) => h.term),
    };
  };

  for (const entry of validDanmaku) {
    const bucket = Math.min(Math.floor(entry.t / bucketS), bucketCount - 1);
    bucketTexts[bucket]!.push(entry.text);
    bucketDanmaku[bucket]!.push(entry);
  }
  const transcriptAssignments: Array<{ segment: TimedSegment; bucket: number; terms: string[] }> = [];
  for (const segment of validTranscript) {
    const bucket = Math.min(Math.floor(segment.start_s / bucketS), bucketCount - 1);
    transcriptAssignments.push({ segment, bucket, terms: scanKeywords(segment.text).map((h) => h.term) });
    bucketTexts[bucket]!.push(segment.text);
  }

  const avgDanmaku = validDanmaku.length / bucketCount;
  const scores = new Array<number>(bucketCount).fill(0);
  const hasLinkByBucket = new Array<boolean>(bucketCount).fill(false);
  for (let i = 0; i < bucketCount; i += 1) {
    const { weight, hasLink } = accumulate(bucketTexts[i]!.join("\n"));
    let score = weight;
    if (hasLink) {
      score += LINK_BONUS;
      hasLinkByBucket[i] = true;
    }
    // 密度突增：弹幕明显高于均值往往是集体反应（嘲讽/警告/引流互动），值得看
    if (validDanmaku.length >= 30 && bucketDanmaku[i]!.length > Math.max(5, avgDanmaku * 2.5)) {
      score += DENSITY_BONUS;
    }
    scores[i] = score;
  }

  // 相邻正分桶合并（允许 1 桶间隔），生成候选窗口
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  let open: { start: number; last: number; score: number; gap: number } | null = null;
  for (let i = 0; i < bucketCount; i += 1) {
    if (scores[i]! > 0) {
      if (!open) open = { start: i, last: i, score: scores[i]!, gap: 0 };
      else {
        open.last = i;
        open.score += scores[i]!;
        open.gap = 0;
      }
    } else if (open) {
      open.gap += 1;
      if (open.gap > 1) {
        candidates.push({ start: open.start, end: open.last, score: open.score });
        open = null;
      }
    }
  }
  if (open) candidates.push({ start: open.start, end: open.last, score: open.score });

  // 按得分取 top-K，且窗口之间不重叠
  const chosen = candidates
    .slice()
    .sort((a, b) => b.score - a.score)
    .reduce<Array<{ start: number; end: number; score: number }>>((acc, cand) => {
      const overlaps = acc.some((w) => cand.start <= w.end && w.start <= cand.end);
      if (!overlaps && acc.length < topK) acc.push(cand);
      return acc;
    }, [])
    .sort((a, b) => a.start - b.start);

  const windows: RiskWindow[] = chosen.map(({ start, end }) => {
    const startS = start * bucketS;
    const endS = (end + 1) * bucketS;
    const overlapping = transcriptAssignments.filter(
      (a) => a.segment.end_s > startS && a.segment.start_s < endS,
    );
    const danmakuHits = validDanmaku
      .filter((d) => d.t >= startS && d.t < endS && scanKeywords(d.text).length > 0)
      .slice(0, maxHits)
      .map((d) => ({ t: d.t, text: d.text, terms: scanKeywords(d.text).map((h) => h.term) }));
    const transcriptHits = overlapping
      .filter((a) => a.terms.length > 0)
      .slice(0, maxHits)
      .map((a) => ({
        start_s: a.segment.start_s,
        end_s: a.segment.end_s,
        text: a.segment.text,
        terms: a.terms,
      }));
    let excerpt = "";
    for (const a of overlapping) {
      if (excerpt.length >= excerptChars) break;
      excerpt += (excerpt ? " " : "") + a.segment.text;
    }
    return {
      start_s: startS,
      end_s: endS,
      score: candidates.find((c) => c.start === start && c.end === end)!.score,
      has_link: hasLinkByBucket.slice(start, end + 1).some(Boolean),
      danmaku_hits: danmakuHits,
      transcript_hits: transcriptHits,
      transcript_excerpt: excerpt.slice(0, excerptChars),
    };
  });

  const keyword_totals = [...totals.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ term, category, count }) => ({ term, category, count }));

  return { windows, bucket_seconds: bucketS, keyword_totals };
}
