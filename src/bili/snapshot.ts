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
});

export const AuthorSchema = z.object({
  mid: z.union([z.string(), z.number()]).optional(),
  name: z.string().default(""),
  fans: z.number().optional(),
  attention: z.number().optional(),
  /** B 站口径：0 无认证、1 个人认证、2 机构认证（其余值按"认证类型 N"处理） */
  official_type: z.number().optional(),
  official_desc: z.string().optional(),
  sign: z.string().default(""),
});

export const DanmakuEntrySchema = z.object({
  t: z.number(),
  text: z.string(),
});

export const ReplyEntrySchema = z.object({
  uname: z.string().optional(),
  like: z.number().optional(),
  message: z.string(),
});

export const CommentEntrySchema = z.object({
  uname: z.string().optional(),
  like: z.number().optional(),
  /** 评论时间（Unix 秒或视频相对秒，仅参考） */
  t: z.number().optional(),
  message: z.string(),
  replies: z.array(ReplyEntrySchema).max(200).optional(),
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
  return result.data;
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
