// src/tools/bili_collect.ts
/**
 * B 站视频快照读数工具：读取 dataset/<BV号>.json 快照（由独立采集流程生成），
 * 做确定性的证据预处理并返回结构化 JSON——本工具不做任何判断：
 * 粗定位窗口、命中评论、链接候选、作者卡片都只是"值得看一眼"的线索，
 * 定性由 scanner 子代理结合 inspect_link 采证与反诈知识库完成。
 *
 * 快照格式契约见 src/bili/snapshot.ts 与 docs/视频诈骗扫描.md。
 */
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../core/types";
import { scanKeywords } from "../core/scam_lexicon";
import {
  describeOfficial,
  loadSnapshot,
  normalizeTranscript,
  resolveBvid,
  type VideoSnapshot,
} from "../bili/snapshot";
import { extractLinks, type ExtractedLink } from "../bili/links";
import { localizeRisks, type RiskWindow } from "../bili/localize";
import { associateContacts } from "../bili/contacts";
import { measureDataCoverage } from "../bili/coverage";

export interface BiliCollectToolOptions {
  /** 快照数据集目录；缺省 BILI_DATASET_DIR，再缺省 dataset/。注册时固定，子代理不可指定任意路径 */
  datasetDir?: string;
}

/** 输出体量上限：仅超限时压缩弹幕/字幕摘录（评论永远全量），并置 size_trimmed 留痕 */
const OUTPUT_CHAR_LIMIT = 24_000;

const trunc = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function createBiliCollectTool(options: BiliCollectToolOptions = {}) {
  const datasetDir = path.resolve(options.datasetDir ?? process.env.BILI_DATASET_DIR ?? "dataset");
  return defineTool({
    name: "bili_collect",
    description:
      "读取已采集的 B 站视频快照（dataset/<BV号>.json）并做证据预处理：粗定位风险时间窗（窗内弹幕样本+字幕摘录）、" +
      "输出全部评论（含楼中楼，命中风险的评论就地标注 hits/links，置顶与评论图带标记）、" +
      "提取全部文本中的链接候选（含混淆变体）、输出作者卡片。返回结构化证据 JSON，不含结论；" +
      "快照缺失会明确报错并提示先运行采集流程。",
    schema: z.object({
      bvid: z.string().min(1).describe("BV 号或 B 站视频链接"),
    }),
    parallelSafe: true,
    needsReconciliation: false,
    execute: async ({ bvid }) => collectEvidence(resolveBvid(bvid), datasetDir),
  });
}

async function collectEvidence(bvid: string, datasetDir: string): Promise<string> {
  let snapshot: VideoSnapshot;
  try {
    snapshot = await loadSnapshot(datasetDir, bvid);
  } catch (error) {
    // 缺快照/格式不对是常规情况，返回可读指引而不是让注册表把异常包成错误观察
    return error instanceof Error ? error.message : String(error);
  }

  const notes: string[] = [];
  const video = snapshot.video;
  const author = snapshot.author;
  const danmaku = snapshot.danmaku;
  const comments = snapshot.comments;
  const transcriptSegments = normalizeTranscript(snapshot);
  const transcriptSource = snapshot.transcript?.source ?? "none";

  if (!video) notes.push("快照缺少 video，标题/简介维度无法判断");
  if (danmaku.length === 0) notes.push("快照无弹幕数据");
  if (comments.length === 0) notes.push("快照无评论数据");
  if (!author) notes.push("快照缺少 author，作者维度无法判断");
  if (transcriptSegments.length === 0) notes.push("快照无字幕/转写文本（source=" + transcriptSource + "）");

  const titleText = video ? `${video.title}\n${video.desc}` : "";
  const titleDescHits = video ? scanKeywords(titleText) : [];

  const localization = localizeRisks(danmaku, transcriptSegments, { topK: 6 });

  // 链接聚合：来源标注 + 按 normalized 去重（kind 取证据最强的）
  const kindRank = { url: 3, domain: 2, obfuscated: 1 } as const;
  const linkMap = new Map<string, ExtractedLink & { sources: Set<string> }>();
  const collectLinks = (text: string, source: string) => {
    if (!text.trim()) return;
    for (const link of extractLinks(text, source)) {
      const existing = linkMap.get(link.normalized);
      if (!existing) {
        linkMap.set(link.normalized, { ...link, sources: new Set([source]) });
      } else {
        existing.sources.add(source);
        if (kindRank[link.kind] > kindRank[existing.kind]) existing.kind = link.kind;
        existing.short = existing.short || link.short;
      }
    }
  };
  if (video) {
    collectLinks(video.title, "title");
    collectLinks(video.desc, "desc");
  }
  if (author) {
    collectLinks(author.name, "author_name");
    collectLinks(author.sign, "author_sign");
  }
  for (const entry of danmaku) collectLinks(entry.text, "danmaku");
  for (const comment of comments) {
    collectLinks(comment.message, "comment");
    for (const reply of comment.replies ?? []) collectLinks(reply.message, "comment");
  }
  for (const segment of transcriptSegments) collectLinks(segment.text, "transcript");

  // 全量评论：一条不裁（含楼中楼与评论图），风险命中就地标注，由模型自己通读判定
  const allComments = comments.map((comment) => {
    const hits = scanKeywords(comment.message).map((h) => h.term);
    const links = extractLinks(comment.message, "comment").map((l) => l.normalized);
    const localImages = comment.localPicPath ?? [];
    const imageCount = Math.max(localImages.length, comment.pics?.length ?? 0);
    const replies = (comment.replies ?? []).map((reply) => {
      const replyHits = scanKeywords(reply.message).map((h) => h.term);
      const replyLinks = extractLinks(reply.message, "comment").map((l) => l.normalized);
      return {
        ...(reply.uname !== undefined ? { uname: reply.uname } : {}),
        ...(reply.like !== undefined ? { like: reply.like } : {}),
        message: reply.message,
        ...(replyHits.length ? { hits: replyHits } : {}),
        ...(replyLinks.length ? { links: replyLinks } : {}),
      };
    });
    return {
      ...(comment.uname !== undefined ? { uname: comment.uname } : {}),
      ...(comment.like !== undefined ? { like: comment.like } : {}),
      ...(comment.t !== undefined ? { t: comment.t } : {}),
      ...(comment.is_pinned ? { is_pinned: true } : {}),
      ...(imageCount ? { image_count: imageCount } : {}),
      ...(localImages.length ? { local_images: localImages } : {}),
      message: comment.message,
      ...(hits.length ? { hits } : {}),
      ...(links.length ? { links } : {}),
      ...(replies.length ? { replies } : {}),
    };
  });

  const evidence = {
    bvid,
    data_coverage: measureDataCoverage(snapshot),
    contact_associations: associateContacts(snapshot),
    snapshot_fetched_at: snapshot.fetched_at,
    video: video
      ? {
          title: video.title,
          desc: trunc(video.desc, 600),
          ...(video.duration_s !== undefined ? { duration_s: video.duration_s } : {}),
          ...(video.pubdate !== undefined ? { pubdate: video.pubdate } : {}),
          ...(video.owner_name !== undefined ? { owner_name: video.owner_name } : {}),
          ...(video.owner_mid !== undefined ? { owner_mid: video.owner_mid } : {}),
          tags: video.tags.slice(0, 20),
          // 统计缺失代表未采到/稿件下架，不是零；availability 如实透传，供判定时"不当作低风险依据"
          ...(video.stat !== undefined ? { stat: video.stat } : {}),
          ...(video.availability !== undefined ? { availability: video.availability } : {}),
        }
      : null,
    author: author
      ? {
          name: author.name,
          ...(author.mid !== undefined ? { mid: author.mid } : {}),
          ...(author.fans !== undefined ? { fans: author.fans } : {}),
          ...(author.attention !== undefined ? { attention: author.attention } : {}),
          ...(author.video_count !== undefined ? { video_count: author.video_count } : {}),
          ...(author.total_views !== undefined ? { total_views: author.total_views } : {}),
          official: describeOfficial(author.official_type) +
            (author.official_desc ? `：${trunc(author.official_desc, 120)}` : ""),
          sign: trunc(author.sign, 200),
        }
      : null,
    transcript: { source: transcriptSource, segment_count: transcriptSegments.length },
    danmaku: { count: danmaku.length },
    comment_stats: {
      count: comments.length,
      pinned_count: comments.filter((comment) => comment.is_pinned).length,
      reply_count: comments.reduce((sum, comment) => sum + (comment.replies?.length ?? 0), 0),
    },
    title_desc_hits: titleDescHits.map((h) => ({ term: h.term, category: h.category, count: h.count })),
    risk_windows: localization.windows,
    keyword_totals: localization.keyword_totals.slice(0, 30),
    comments: allComments,
    links: [...linkMap.values()]
      .sort((a, b) => Number(b.short) - Number(a.short) || a.normalized.localeCompare(b.normalized))
      .slice(0, 25)
      .map((link) => ({
        raw: trunc(link.raw, 200),
        normalized: link.normalized,
        kind: link.kind,
        short: link.short,
        sources: [...link.sources],
      })),
    notes,
  };

  return capOutput(evidence);
}

/** 输出体量守护：评论（含楼中楼）全量输出、绝不裁剪；仅在超限时压缩弹幕/字幕摘录并留痕 */
function capOutput(evidence: Record<string, unknown>): string {
  const text = JSON.stringify(evidence);
  if (text.length <= OUTPUT_CHAR_LIMIT) return text;
  const trimmed = (evidence.risk_windows as RiskWindow[]).map((w) => ({
    ...w,
    transcript_excerpt: trunc(w.transcript_excerpt, 200),
    danmaku_hits: w.danmaku_hits.slice(0, 5).map((h) => ({ ...h, text: trunc(h.text, 100) })),
  }));
  return JSON.stringify({ ...evidence, size_trimmed: true, risk_windows: trimmed });
}
