// src/bili/snapshot.ts
/**
 * 视频快照的读取与校验——采集侧与识别侧之间的契约点。
 *
 * 快照由独立的采集流程生成（本架构不含抓取），每个视频一个 JSON 文件：
 * `dataset/<BV号>.json`（目录可用 BILI_DATASET_DIR 改）。快照记录的是"数据截至
 * fetched_at 时该视频长什么样"，是论文可复现实验的输入基准。
 *
 * 设计原则：缺部件不报错——采集时某维度没拿到（弹幕关闭、作者接口失败等）
 * 属于合法状态，loader 照常返回，缺什么由 bili_collect 转成证据 notes，
 * scanner 对应维度记"无法判断"而不是失败。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseSrt } from "./srt";
import { AuthorVideoSchema } from "./author_videos";

/** 从任意输入（BV 号 / 视频链接 / 含 BV 的文本）中提取 BV 号 */
export function resolveBvid(input: string): string {
  const match = input.match(/BV[0-9A-Za-z]{10}/);
  if (!match) throw new Error(`无法从输入中解析 BV 号：${input}`);
  return match[0];
}

export const TimedSegmentSchema = z.object({
  start_s: z.number(),
  end_s: z.number(),
  text: z.string(),
});

export const VideoMetaSchema = z.object({
  title: z.string().default(""),
  desc: z.string().default(""),
  duration_s: z.number().nonnegative().optional(),
  pubdate: z.union([z.string(), z.number()]).optional(),
  owner_name: z.string().optional(),
  owner_mid: z.number().optional(),
  tags: z.array(z.string()).default([]),
  /** 稿件可见性备注（如"稿件已不可见（B站删除/屏蔽）"）；缺失表示本次采集时可见 */
  availability: z.string().optional(),
  /** 采集侧的播放/互动统计（views/likes/coins/favorites/shares/comment_count）；缺失表示未采到，不是零 */
  stat: z.object({
    view: z.number().nonnegative().optional(),
    like: z.number().nonnegative().optional(),
    coin: z.number().nonnegative().optional(),
    favorite: z.number().nonnegative().optional(),
    share: z.number().nonnegative().optional(),
    reply: z.number().nonnegative().optional(),
    danmaku: z.number().nonnegative().optional(),
  }).optional(),
});

export const AuthorSchema = z.object({
  mid: z.union([z.string(), z.number()]).optional(),
  /** 上游作者语义档（author-semantic/v5）：只用于评论字符预算分档，不代表作者风险结论；缺失按 unknown */
  semantic_level: z.enum(["high", "medium", "low", "clean", "unknown"]).optional(),
  name: z.string().default(""),
  fans: z.number().optional(),
  attention: z.number().optional(),
  /** B 站口径：0 无认证、1 个人认证、2 机构认证（其余值按"认证类型 N"处理） */
  official_type: z.number().optional(),
  official_desc: z.string().optional(),
  sign: z.string().default(""),
  /** 已投稿件数（采集侧 card.archive_count） */
  video_count: z.number().optional(),
  /** 累计播放量（采集侧 statistics.archive.view） */
  total_views: z.number().optional(),
  /** 按发布时间倒序、标题去重后的最近最多 50 条作品元数据 */
  recent_videos: z.array(AuthorVideoSchema).max(50).optional(),
});

export const DanmakuEntrySchema = z.object({
  t: z.number(),
  text: z.string(),
});

export const ReplyEntrySchema = z.object({
  /** 原始回复 ID：用于父子关系与证据引用 */
  rpid: z.string().optional(),
  /** 直接父节点 rpid（主楼或另一条回复）；缺失或未采集时保留未知关系，不推断为主楼子回复 */
  parent: z.string().optional(),
  mid: z.union([z.string(), z.number()]).optional(),
  uname: z.string().optional(),
  like: z.number().optional(),
  t: z.number().optional(),
  message: z.string(),
  /** 该回复由 UP 发布（采集侧 is_up） */
  is_up: z.boolean().optional(),
  reply_count: z.number().optional(),
});

export const CommentEntrySchema = z.object({
  /** 主楼 rpid：树形输出里线程的唯一标识，楼内回复同时保留原始 rpid */
  rpid: z.string().optional(),
  mid: z.union([z.string(), z.number()]).optional(),
  uname: z.string().optional(),
  like: z.number().optional(),
  /** 评论时间（Unix 秒或视频相对秒，仅参考） */
  t: z.number().optional(),
  message: z.string(),
  /** 置顶评论：作者置顶通常指向联系方式/资料/站外导流，是核心证据位 */
  is_pinned: z.boolean().optional(),
  /** API 声明的楼中楼总数，用来标注本次抓取是否完整 */
  reply_count: z.number().optional(),
  /** UP 主回复过该楼 */
  upreply: z.boolean().optional(),
  /** 评论附图本地相对路径（相对数据集根，如 images/BV.../xxx.jpg），供 read_image 查看 */
  localPicPath: z.array(z.string()).optional(),
  /** 评论附图原始 URL。采集侧新格式给对象（url/asset_id/local_path/status…）、旧格式给字符串，
   *  统一归一成 URL 字符串：否则单个字段形态不符会让整份快照校验失败、整个视频被静默跳过。 */
  pics: z.array(
    z.union([z.string(), z.object({ url: z.string() })]).transform((p) => typeof p === "string" ? p : p.url),
  ).optional(),
  /** 平铺的楼中楼，parent 字段用于重建树；上限 500 条/楼 */
  replies: z.array(ReplyEntrySchema).max(500).optional(),
});

export const TranscriptSchema = z.object({
  source: z.enum(["cc", "srt", "asr", "none"]).default("none"),
  /** 结构化分段（与 srt 二选一；同时存在时优先 segments） */
  segments: z.array(TimedSegmentSchema).optional(),
  /** 原始 SRT 文本（loader 会解析成 segments） */
  srt: z.string().optional(),
});

export const SnapshotSchema = z.object({
  schema: z.string().default("bili-snapshot/v1"),
  bvid: z.string().min(1),
  /** 快照时间：论文里"数据截至"的依据，必填 */
  fetched_at: z.string().min(1),
  video: VideoMetaSchema.optional(),
  author: AuthorSchema.optional(),
  danmaku: z.array(DanmakuEntrySchema).default([]),
  comments: z.array(CommentEntrySchema).default([]),
  transcript: TranscriptSchema.optional(),
});

export type VideoMeta = z.infer<typeof VideoMetaSchema>;
export type AuthorInfo = z.infer<typeof AuthorSchema>;
export type DanmakuEntry = z.infer<typeof DanmakuEntrySchema>;
export type CommentEntry = z.infer<typeof CommentEntrySchema>;
export type ReplyEntry = z.infer<typeof ReplyEntrySchema>;
export type TimedSegment = z.infer<typeof TimedSegmentSchema>;
export type VideoSnapshot = z.infer<typeof SnapshotSchema>;

/** 快照文件名：一个视频一个 JSON */
export function snapshotPath(datasetDir: string, bvid: string): string {
  return path.join(datasetDir, `${bvid}.json`);
}

/** 读取并校验快照；缺失或格式非法都抛带明确指引的错误（工具观察直接可读） */
export async function loadSnapshot(datasetDir: string, bvid: string): Promise<VideoSnapshot> {
  const file = snapshotPath(datasetDir, bvid);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(
      `快照不存在：${file}\n` +
      `扫描前需要先由采集流程生成快照（dataset/<BV号>.json，格式见 docs/视频诈骗扫描.md），` +
      `或确认 BILI_DATASET_DIR 指向正确的数据集目录。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`快照不是合法 JSON：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const result = SnapshotSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `快照格式不符合 bili-snapshot/v1 约定：${file}\n` +
      `首个问题：${first?.path.join(".")} — ${first?.message}`,
    );
  }
  const snapshot = result.data;
  // 采集快照可以刷新；本地转写独立保存，供 scanner 与抽帧共用。
  if (normalizeTranscript(snapshot).length === 0) {
    const transcriptDir = path.join(datasetDir, "transcripts");
    // 不用未校验的快照字段拼接路径。
    if (/^BV[0-9A-Za-z]{10}$/.test(snapshot.bvid)) {
      for (const extension of ["json", "srt"]) {
        const transcriptPath = path.join(transcriptDir, `${snapshot.bvid}.${extension}`);
        try {
          snapshot.transcript = await loadTranscriptFile(transcriptPath, snapshot.bvid);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  return snapshot;
}

/** 外部转写只接受当前首 P 的 SRT 或标准 transcript JSON，不猜测服务商格式。 */
export async function loadTranscriptFile(file: string, bvid: string): Promise<z.infer<typeof TranscriptSchema>> {
  const text = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
  let transcript: z.infer<typeof TranscriptSchema>;
  if (path.extname(file).toLowerCase() === ".srt") {
    transcript = { source: "srt", segments: parseSrt(text) };
  } else if (path.extname(file).toLowerCase() === ".json") {
    const input = TranscriptSchema.extend({
      bvid: z.literal(bvid).optional(),
      page: z.literal(1).optional(),
    }).parse(JSON.parse(text));
    transcript = { source: input.source, ...(input.segments ? { segments: input.segments } : {}),
      ...(input.srt === undefined ? {} : { srt: input.srt }) };
    if (transcript.source === "none") throw new Error(`转写 JSON 必须声明 source=asr|srt|cc：${file}`);
  } else {
    throw new Error(`转写文件只支持 .srt / .json：${file}`);
  }
  const segments = transcript.segments?.length ? transcript.segments : parseSrt(transcript.srt ?? "");
  if (segments.length === 0 || segments.some((s) =>
    !Number.isFinite(s.start_s) || !Number.isFinite(s.end_s) || s.start_s < 0 || s.end_s <= s.start_s || !s.text.trim())) {
    throw new Error(`转写没有有效分段或时间戳非法：${file}`);
  }
  return { source: transcript.source, segments: segments.slice().sort((a, b) => a.start_s - b.start_s) };
}

/** 归一化转写：只有原始 SRT 时解析成结构化分段；返回分段列表（可能为空） */
export function normalizeTranscript(snapshot: VideoSnapshot): TimedSegment[] {
  const transcript = snapshot.transcript;
  if (!transcript) return [];
  if (transcript.segments && transcript.segments.length > 0) return transcript.segments;
  if (transcript.srt) return parseSrt(transcript.srt);
  return [];
}

export function describeOfficial(officialType?: number): string {
  if (officialType === undefined || officialType === 0) return "无认证";
  if (officialType === 1) return "个人认证";
  if (officialType === 2) return "机构认证";
  return `认证(类型${officialType})`;
}
