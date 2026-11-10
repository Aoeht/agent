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
  type CommentEntry,
  type ReplyEntry,
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

/** 单个楼中楼（主楼+回复）的字符上限；超出按顺序截断并注明未展示条数 */
const THREAD_CHAR_LIMIT = 1_000;
/** 根 -> R1 -> R1.1 共三层；更深的回复保留血统标签（R1.1.1）压平在同一条二层回复之后 */
const MAX_THREAD_DEPTH = 2;

const trunc = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function createBiliCollectTool(options: BiliCollectToolOptions = {}) {
  const datasetDir = path.resolve(options.datasetDir ?? process.env.BILI_DATASET_DIR ?? "dataset");
  return defineTool({
    name: "bili_collect",
    description:
      "读取已采集的 B 站视频快照（dataset/<BV号>.json）并做证据预处理：粗定位风险时间窗（窗内弹幕样本+字幕摘录）、" +
      "输出全部评论树（根评论带 rpid 与用户名/mid，楼中楼按 root/parent 最多三层，单楼不超过 1000 字符，" +
      "命中词与链接就地标注，置顶与评论图带标记）、" +
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

  // 评论以树形文本交给模型：根评论带 rpid，楼内按 root/parent 重建最多三层，保留用户名与 mid
  const commentThreads = comments.map((comment) => renderCommentThread(comment, scanKeywords, extractLinks));
  const replyCaptured = comments.reduce((sum, comment) => sum + (comment.replies?.length ?? 0), 0);
  const truncatedThreads = commentThreads.filter((thread) => thread.truncated).length;
  if (truncatedThreads > 0) notes.push(`${truncatedThreads} 个楼中楼超过 ${THREAD_CHAR_LIMIT} 字符，已按顺序截断`);

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
      reply_count: replyCaptured,
      truncated_threads: truncatedThreads,
    },
    title_desc_hits: titleDescHits.map((h) => ({ term: h.term, category: h.category, count: h.count })),
    risk_windows: localization.windows,
    keyword_totals: localization.keyword_totals.slice(0, 30),
    comment_threads: commentThreads.map((thread) => thread.text),
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

interface RenderedThread {
  text: string;
  truncated: boolean;
}

const commentDate = (t?: number): string => {
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return "";
  return new Date(t * 1000).toISOString().slice(0, 10);
};

const commentUser = (uname: string | undefined, mid: string | number | undefined): string =>
  `${uname?.trim() || "匿名"}${mid === undefined || mid === "" ? "" : `(mid=${mid})`}`;

/** 命中词/链接就地标注在节点末尾，保持与旧证据一致的提示语义 */
function commentTags(
  hits: { term: string }[],
  links: ExtractedLink[],
): string {
  const parts: string[] = [];
  const terms = [...new Set(hits.map((hit) => hit.term))];
  if (terms.length) parts.push(`[命中：${terms.join("、")}]`);
  const urls = [...new Set(links.map((link) => link.normalized))];
  if (urls.length) parts.push(`[链接：${urls.join("、")}]`);
  return parts.length ? ` ${parts.join("")}` : "";
}

/** 树结构已标明回复对象，去掉正文里指向同一对象的“回复 @X :”/“@X ”前缀；指向别人的保留 */
function stripReplyPrefix(text: string, parentName?: string): string {
  if (!parentName) return text;
  const target = parentName.trim();
  const reply = text.match(/^回[复復覆]\s*@([^:：]+?)\s*[:：]\s*/);
  if (reply) {
    const names = reply[1]!.split(/[、,，\s]+/).filter(Boolean);
    if (names.length === 0 || names.some((name) => name !== target)) return text;
    return text.slice(reply[0].length).trim() || text;
  }
  const mention = text.match(/^@([^\s:：]+)[\s:：]+/);
  if (mention && mention[1] === target) {
    return text.slice(mention[0].length).trim() || text;
  }
  return text;
}

function replyLine(
  reply: ReplyEntry,
  label: string,
  prefix: string,
  parentName: string | undefined,
  scan: (text: string) => { term: string }[],
  extract: (text: string, source: string) => ExtractedLink[],
): string {
  const parts = [`${prefix}${label} ${commentUser(reply.uname, reply.mid)}`];
  if (reply.is_up) parts.push("UP");
  if (typeof reply.like === "number") parts.push(`赞${reply.like}`);
  const date = commentDate(reply.t);
  if (date) parts.push(date);
  const text = stripReplyPrefix(reply.message.trim(), parentName);
  return `${parts.join(" ")}：${text}${commentTags(scan(text), extract(text, "comment"))}`;
}

/**
 * 把一条主楼的平铺回复按 parent 重建成树形文本：
 * 根（带 rpid）-> R1 -> R1.1，缩进最多三层；更深的回复以 ↳ 压平在同一层，
 * 标签保留完整父链（R1.1.1.1 即回复 R1.1.1），紧跟其父节点输出；
 * 正文里指向同一父节点的“回复 @X :”前缀属于重复信息，去掉后保留原文的其余部分。
 * 单楼总字符数不超过 THREAD_CHAR_LIMIT，超出按顺序丢弃尾部回复并注明条数。
 */
function renderCommentThread(
  root: CommentEntry,
  scan: (text: string) => { term: string }[],
  extract: (text: string, source: string) => ExtractedLink[],
): RenderedThread {
  const replies = root.replies ?? [];
  const headerParts = [`[#${root.rpid?.trim() || "-"}]`, commentUser(root.uname, root.mid)];
  if (typeof root.like === "number") headerParts.push(`赞${root.like}`);
  const rootDate = commentDate(root.t);
  if (rootDate) headerParts.push(rootDate);
  if (root.is_pinned) headerParts.push("置顶");
  const localImages = root.localPicPath ?? [];
  const imageCount = Math.max(localImages.length, root.pics?.length ?? 0);
  if (imageCount) {
    headerParts.push(`评论图${imageCount}张${localImages.length ? `：${localImages.join("；")}` : ""}`);
  }
  if (replies.length) {
    const declared = typeof root.reply_count === "number" ? root.reply_count : undefined;
    headerParts.push(
      declared === undefined
        ? `楼中楼${replies.length}条`
        : replies.length >= declared
          ? `楼中楼${replies.length}条（完整）`
          : `楼中楼${replies.length}/${declared}条（不完整）`,
    );
    if (root.upreply) headerParts.push("UP回复过");
  }
  const header = headerParts.join(" ");
  const bodyTags = commentTags(scan(root.message), extract(root.message, "comment"));
  if (replies.length === 0) {
    return { text: `${header}\n  ${root.message.trim()}${bodyTags}`, truncated: false };
  }

  // 有楼中楼时整楼共享 1k 字符预算：先保根评论，再按顺序放回复
  const bodyBudget = THREAD_CHAR_LIMIT - header.length - 1 - 2 - bodyTags.length;
  let body = root.message.trim();
  if (body.length > Math.max(0, bodyBudget - 1)) {
    body = body.slice(0, Math.max(0, bodyBudget - 1)) + "…";
  }
  const lines = [header, `  ${body}${bodyTags}`];

  const rootRpid = root.rpid?.trim();
  const byId = new Map<string, ReplyEntry>();
  for (const reply of replies) {
    const id = reply.rpid?.trim();
    if (id) byId.set(id, reply);
  }

  // parent 链（直接父在前、顶层在后），用于确定每条回复挂在哪一层
  const chainOf = new Map<ReplyEntry, ReplyEntry[]>();
  for (const reply of replies) {
    const chain: ReplyEntry[] = [];
    let cur = reply;
    const seen = new Set<string>();
    while (true) {
      const parentId = cur.parent?.trim();
      if (!parentId || parentId === rootRpid || !byId.has(parentId)) break;
      const curId = cur.rpid?.trim();
      if (curId) {
        if (seen.has(curId)) break;
        seen.add(curId);
      }
      cur = byId.get(parentId)!;
      chain.push(cur);
      if (chain.length > MAX_THREAD_DEPTH + 8) break;
    }
    chainOf.set(reply, chain);
  }

  const direct: ReplyEntry[] = [];
  const childrenOf = new Map<string, ReplyEntry[]>();
  const parentNameOf = new Map<ReplyEntry, string | undefined>();
  for (const reply of replies) {
    const parent = chainOf.get(reply)![0];
    if (!parent) {
      direct.push(reply);
      parentNameOf.set(reply, root.uname);
      continue;
    }
    parentNameOf.set(reply, parent.uname);
    const parentId = parent.rpid?.trim() ?? "";
    const list = childrenOf.get(parentId) ?? [];
    list.push(reply);
    childrenOf.set(parentId, list);
  }

  // 标签沿真实父链累加：R1.2.1.1 明确表示“回复 R1.2.1”，不会落到祖先的兄弟层
  const labelOf = new Map<string, string>();
  const labelTree = (reply: ReplyEntry, label: string, seen: Set<string>): void => {
    const id = reply.rpid?.trim() ?? "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    labelOf.set(id, label);
    (childrenOf.get(id) ?? []).forEach((kid, index) => {
      labelTree(kid, `${label}.${index + 1}`, seen);
    });
  };
  const seenLabels = new Set<string>();
  direct.forEach((reply, index) => labelTree(reply, `R${index + 1}`, seenLabels));

  const nodeLines: string[] = [];
  const renderedIds = new Set<string>();
  const emit = (reply: ReplyEntry, prefix: string): void => {
    const id = reply.rpid?.trim() ?? "";
    if (id && renderedIds.has(id)) return;
    if (id) renderedIds.add(id);
    const label = labelOf.get(id) ?? "R?";
    nodeLines.push(replyLine(reply, label, prefix, parentNameOf.get(reply), scan, extract));
    for (const kid of childrenOf.get(id) ?? []) {
      const depth = labelOf.get(kid.rpid?.trim() ?? "")?.split(".").length ?? 0;
      emit(kid, depth <= 2 ? "  │  └ " : "  │  ↳ ");
    }
  };
  direct.forEach((reply) => emit(reply, "  ├ "));

  let used = lines.join("\n").length;
  const rendered: string[] = [];
  for (const line of nodeLines) {
    if (used + 1 + line.length > THREAD_CHAR_LIMIT) break;
    rendered.push(line);
    used += 1 + line.length;
  }
  let dropped = replies.length - rendered.length;
  let text = lines.concat(rendered).join("\n");
  if (dropped > 0) {
    let note = `  …（本楼另有 ${dropped} 条回复未展示）`;
    while (rendered.length > 0 && text.length + 1 + note.length > THREAD_CHAR_LIMIT) {
      rendered.pop();
      dropped += 1;
      note = `  …（本楼另有 ${dropped} 条回复未展示）`;
      text = lines.concat(rendered).join("\n");
    }
    if (text.length + 1 + note.length <= THREAD_CHAR_LIMIT) text += `\n${note}`;
  }
  return { text, truncated: dropped > 0 };
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
