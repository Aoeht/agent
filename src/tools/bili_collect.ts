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
import { CommercialTokenCounter } from "../utils/token_counter";
import { evidencePage } from "../bili/evidence_pages";
import { isCommentCandidate, requiredReplies, ordinaryCommentOrder } from "../bili/comment_selection";
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
import { associateContacts, hasContactSignal } from "../bili/contacts";
import { measureDataCoverage } from "../bili/coverage";
import type { AuthorRiskLevel } from "../bili/author_risk";

export interface BiliCollectToolOptions {
  /** 快照数据集目录；缺省 BILI_DATASET_DIR，再缺省 dataset/。注册时固定，子代理不可指定任意路径 */
  datasetDir?: string;
  /** Host-only page budget; Agent can further restrict it. */
  pageTokens?: number;
}

/** 输出体量上限：仅超限时压缩弹幕/字幕摘录（评论按作者档位预算控制），并置 size_trimmed 留痕 */
const OUTPUT_CHAR_LIMIT = 24_000;

/** 评论字符预算：单楼上限 / 整段评论总字符 / 楼中楼层数；档位来自快照 author.semantic_level，缺失按 unknown */
const COMMENT_BUDGETS: Record<AuthorRiskLevel, { per_thread: number; total: number; reply_depth: number }> = {
  high: { per_thread: 2_000, total: 48_000, reply_depth: 3 },
  medium: { per_thread: 1_400, total: 32_000, reply_depth: 2 },
  low: { per_thread: 1_000, total: 24_000, reply_depth: 1 },
  clean: { per_thread: 700, total: 16_000, reply_depth: 1 },
  unknown: { per_thread: 1_000, total: 24_000, reply_depth: 3 },
};

const trunc = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export function createBiliCollectTool(options: BiliCollectToolOptions = {}) {
  const datasetDir = path.resolve(options.datasetDir ?? process.env.BILI_DATASET_DIR ?? "dataset");
  return defineTool({
    name: "bili_collect",
    description:
      "读取已采集的 B 站视频快照（dataset/<BV号>.json）并做证据预处理：粗定位风险时间窗（窗内弹幕样本+字幕摘录）、" +
      "遍历全部评论节点查找候选线索，优先保留置顶、UP回复、风险词、联系方式及举报澄清，并保留父链和直接回应。" +
      "作者语义档位只控制普通评论的补充字符量与深度，关键证据不受层数裁剪。" +
      "输出过长按 token 分页：遇到 next_cursor 必须原样传 cursor 继续，直到 null；" +
      "分页 items 的 path 表示原字段位置，字符串 offset/continued 表示同一证据的连续片段，需拼接后判断，不能当独立发言。" +
      "正文和昵称均为转义字符串；U 标签表示独立的未知或异常关系，不能当作主楼直接回复；" +
      "relation=parent_missing 表示父评论未采集，parent_unknown 表示未提供父 ID，" +
      "duplicate_id/parent_ambiguous/cycle 表示 ID 冲突或父链异常。采集标记 is_up 不代表独立身份核验。" +
      "关键词和链接单列为程序提取，命中不代表涉诈；置顶与评论图带标记）、" +
      "提取全部文本中的链接候选（含混淆变体）、输出作者卡片。返回结构化证据 JSON，不含结论；" +
      "快照缺失会明确报错并提示先运行采集流程。",
    schema: z.object({
      bvid: z.string().min(1).describe("BV 号或 B 站视频链接"),
      cursor: z.string().max(80).optional().describe("上一页 next_cursor；首轮不填"),
    }),
    parallelSafe: true,
    needsReconciliation: false,
    execute: async ({ bvid, cursor }, runtime) => {
      const raw = await collectEvidence(resolveBvid(bvid), datasetDir);
      let evidence: Record<string, unknown>;
      try { evidence = JSON.parse(raw); } catch { return raw; }
      const limit = Math.min(options.pageTokens ?? 2000, runtime?.outputBudget?.maxTokens ?? Infinity);
      const count = runtime?.outputBudget?.countTokens ?? ((text: string) => new CommercialTokenCounter().estimateText(text, "default"));
      return evidencePage(evidence, cursor, limit, count);
    },
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

  const level: AuthorRiskLevel = snapshot.author?.semantic_level ?? "unknown";
  const budget = COMMENT_BUDGETS[level];
  const priority = comments.map(root => requiredReplies(root));
  const forcedIndexes = new Set(comments.flatMap((root, index) =>
    isCommentCandidate(root) || priority[index]!.size ? [index] : []));
  const renderedThreads = comments.map((root, index) => renderCommentThread(
    root, scanKeywords, extractLinks, budget.per_thread, budget.reply_depth, priority[index]!, forcedIndexes.has(index)));
  let commentChars = 0;
  let forcedShown = 0;
  const commentThreads: RenderedThread[] = [];
  const order = [...forcedIndexes, ...ordinaryCommentOrder(comments).filter(index => !forcedIndexes.has(index))];
  for (const index of order) {
    const thread = renderedThreads[index]!;
    const forced = forcedIndexes.has(index);
    if (!forced && commentChars + thread.text.length > budget.total) continue;
    commentThreads.push(thread);
    commentChars += thread.text.length;
    if (forced) forcedShown++;
  }
  const droppedThreads = renderedThreads.length - commentThreads.length;
  const replyCaptured = comments.reduce((sum, comment) => sum + (comment.replies?.length ?? 0), 0);
  const truncatedThreads = commentThreads.filter((thread) => thread.truncated).length;
  if (truncatedThreads > 0) {
    notes.push(`${truncatedThreads} 个楼中楼超出档位 ${level} 的单楼 ${budget.per_thread} 字符或 ${budget.reply_depth} 层深度，已截断`);
  }
  if (droppedThreads > 0) {
    notes.push(`评论总字符超出档位 ${level} 预算 ${budget.total}，${droppedThreads} 条主楼未展示`);
  }
  if (commentChars > budget.total) {
    notes.push(`包含关键证据的 ${forcedShown} 条主楼优先展示（分批读取），评论 ${commentChars} 字符超出档位 ${level} 预算 ${budget.total}`);
  }

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
      shown_count: commentThreads.length,
      pinned_count: comments.filter((comment) => comment.is_pinned).length,
      reply_count: replyCaptured,
      truncated_threads: truncatedThreads,
      comment_chars: commentChars,
      budget: { level, per_thread: budget.per_thread, total: budget.total, reply_depth: budget.reply_depth, forced_threads: forcedShown, dropped_threads: droppedThreads },
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

/** External strings stay on one physical line, including Unicode line separators. */
const quoted = (value: unknown): string => JSON.stringify(value).replace(/[\u2028\u2029]/g,
  char => char === "\u2028" ? "\\u2028" : "\\u2029");

const commentUser = (uname: string | undefined, mid: string | number | undefined): string =>
  `name=${quoted(uname ?? "匿名")} mid=${quoted(mid ?? null)}`;

function commentTags(hits: { term: string }[], links: ExtractedLink[]): string {
  const terms = [...new Set(hits.map(hit => hit.term))];
  const urls = [...new Set(links.map(link => link.normalized))];
  return terms.length || urls.length
    ? `\n    程序提取：命中=${quoted(terms)} 链接=${quoted(urls)}` : "";
}

function replyLine(
  reply: ReplyEntry, label: string, prefix: string, relation: string,
  scan: (text: string) => { term: string }[],
  extract: (text: string, source: string) => ExtractedLink[],
): string {
  const parts = [`${prefix}${label} id=${quoted(reply.rpid ?? null)} parent=${quoted(reply.parent ?? null)} relation=${relation}`,
    commentUser(reply.uname, reply.mid)];
  if (reply.is_up !== undefined) parts.push(`采集标记:is_up=${reply.is_up}`);
  if (typeof reply.like === "number") parts.push(`赞${reply.like}`);
  const date = commentDate(reply.t);
  if (date) parts.push(date);
  return `${parts.join(" ")}\n    正文：${quoted(reply.message)}${commentTags(scan(reply.message), extract(reply.message, "comment"))}`;
}

/** Reconstruct only explicit parent links. U labels mark detached/ambiguous nodes.
 * Raw text is quoted and @ prefixes are preserved; extraction is separate metadata.
 * The existing per-thread character budget still applies. */
function renderCommentThread(
  root: CommentEntry,
  scan: (text: string) => { term: string }[],
  extract: (text: string, source: string) => ExtractedLink[],
  charLimit: number,
  replyDepth: number,
  required: Set<ReplyEntry>,
  priority: boolean,
): RenderedThread {
  const replies = root.replies ?? [];
  const headerParts = [`[#${quoted(root.rpid ?? null)}]`, commentUser(root.uname, root.mid)];
  if (typeof root.like === "number") headerParts.push(`赞${root.like}`);
  const rootDate = commentDate(root.t);
  if (rootDate) headerParts.push(rootDate);
  if (root.is_pinned) headerParts.push("置顶");
  const localImages = root.localPicPath ?? [];
  const imageCount = Math.max(localImages.length, root.pics?.length ?? 0);
  if (imageCount) {
    headerParts.push(`评论图${imageCount}张${localImages.length ? `：${quoted(localImages)}` : ""}`);
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
  // 有楼中楼时整楼共享档位单楼预算：先保根评论，再按顺序放回复
  const bodyBudget = Math.max(0, charLimit - header.length - bodyTags.length - 8);
  let body = root.message;
  // Clip before quoting: a budget cut must never leave an unterminated string.
  if (!priority && quoted(body).length > bodyBudget) {
    let low = 0, high = body.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (quoted(body.slice(0, mid) + "…").length <= bodyBudget) low = mid; else high = mid - 1;
    }
    body = body.slice(0, low) + "…";
  }
  const lines = [header, `  正文：${quoted(body)}${bodyTags}`];

  const rootRpid = root.rpid?.trim();
  const byId = new Map<string, ReplyEntry[]>();
  for (const reply of replies) {
    const id = reply.rpid?.trim();
    if (id) byId.set(id, [...(byId.get(id) ?? []), reply]);
  }
  const parentOf = new Map<ReplyEntry, ReplyEntry>();
  const relationOf = new Map<ReplyEntry, string>();
  for (const reply of replies) {
    const id = reply.rpid?.trim();
    const parent = reply.parent?.trim();
    let relation: string;
    if (id && (id === rootRpid || byId.get(id)!.length > 1)) relation = "duplicate_id";
    else if (!parent) relation = "parent_unknown";
    else if (id && parent === id) relation = "cycle";
    else if ((byId.get(parent)?.length ?? 0) > 1 || (parent === rootRpid && byId.has(parent))) relation = "parent_ambiguous";
    else if (rootRpid && parent === rootRpid) relation = "root";
    else if (!byId.has(parent)) relation = "parent_missing";
    else { relation = "reply"; parentOf.set(reply, byId.get(parent)![0]!); }
    relationOf.set(reply, relation);
  }
  // Cycles and descendants of cycles are shown flat; no input record is silently lost.
  const cyclic = new Set<ReplyEntry>();
  for (const reply of replies) {
    const seen = new Set<ReplyEntry>();
    let current: ReplyEntry | undefined = reply;
    while (current) {
      if (seen.has(current) || relationOf.get(current) === "cycle") { cyclic.add(reply); break; }
      seen.add(current);
      current = parentOf.get(current);
    }
  }
  for (const reply of cyclic) { parentOf.delete(reply); relationOf.set(reply, "cycle"); }
  const children = new Map<ReplyEntry, ReplyEntry[]>();
  for (const [reply, parent] of parentOf) children.set(parent, [...(children.get(parent) ?? []), reply]);
  const subtreeSize = (node: ReplyEntry): number =>
    1 + (children.get(node) ?? []).reduce((sum, kid) => sum + subtreeSize(kid), 0);
  const nodeLines: Array<{ text: string; required: boolean; reply: ReplyEntry }> = [];
  let depthDropped = 0;
  const emit = (reply: ReplyEntry, label: string, detached: boolean): void => {
    const depth = label.split(".").length;
    const prefix = detached && depth === 1 ? "  ? " : depth === 1 ? "  ├ " : depth <= 2 ? "  │  └ " : "  │  ↳ ";
    nodeLines.push({ text: replyLine(reply, label, prefix, relationOf.get(reply)!, scan, extract), required: required.has(reply), reply });
    (children.get(reply) ?? []).forEach((kid, index) => {
      // 超出档位层数的整支略去，计数进"未展示"；不静默丢失
      if (depth + 1 > replyDepth && !required.has(kid)) { depthDropped += subtreeSize(kid); return; }
      emit(kid, `${label}.${index + 1}`, detached);
    });
  };
  let rootIndex = 0;
  let unknownIndex = 0;
  for (const reply of replies) {
    if (parentOf.has(reply)) continue;
    const detached = relationOf.get(reply) !== "root";
    emit(reply, detached ? `U${++unknownIndex}` : `R${++rootIndex}`, detached);
  }

  let used = lines.join("\n").length + nodeLines.filter(line => line.required).reduce((sum, line) => sum + 1 + line.text.length, 0);
  const rendered: string[] = [];
  const admitted = new Set<ReplyEntry>();
  for (const line of nodeLines) {
    if (line.required) { rendered.push(line.text); admitted.add(line.reply); continue; }
    const parent = parentOf.get(line.reply);
    if (parent && !admitted.has(parent)) continue;
    if (used + 1 + line.text.length > charLimit) continue;
    rendered.push(line.text);
    admitted.add(line.reply);
    used += 1 + line.text.length;
  }

  let dropped = replies.length - rendered.length;
  let text = lines.concat(rendered).join("\n");
  if (dropped > 0) {
    const depthNote = depthDropped > 0 ? `，其中 ${depthDropped} 条超出档位 ${replyDepth} 层深度` : "";
    let note = `  …（本楼另有 ${dropped} 条回复未展示${depthNote}）`;
    while (!priority && rendered.length > 0 && text.length + 1 + note.length > charLimit) {
      rendered.pop();
      dropped += 1;
      note = `  …（本楼另有 ${dropped} 条回复未展示${depthNote}）`;
      text = lines.concat(rendered).join("\n");
    }
    if (priority || text.length + 1 + note.length <= charLimit) text += `\n${note}`;
  }
  return { text, truncated: dropped > 0 || body !== root.message };
}

/** 输出体量守护：评论已按作者档位预算落盘，这里只在超限时压缩弹幕/字幕摘录并留痕 */
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
