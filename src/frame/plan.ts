// src/frame/plan.ts
/**
 * 抽帧窗口规划：大模型读 ASR + 弹幕，决定"哪些时间段值得抽帧"。
 *
 * 分工：
 * - 确定性代码先把全量数据整理成带时间戳的紧凑文本和候选窗口（localizeRisks），
 *   模型只做"看哪段"的语义判断，不接触原始视频；
 * - 这里只产出窗口，不抽帧、不下风险结论；解析层负责夹取、合并、限流，
 *   模型输出越界/重叠/超长都不会把下游管道打崩。
 */
import {
  normalizeTranscript,
  type VideoSnapshot,
  type DanmakuEntry,
} from "../bili/snapshot";
import { extractLinks } from "../bili/links";
import { localizeRisks, type RiskWindow } from "../bili/localize";
import { scanKeywords } from "../core/scam_lexicon";
import {
  FRAME_POLICY_VERSION,
  PLANNER_PROMPT_VERSION,
  type FramePlan,
  type FrameWindow,
} from "./types";

export interface PlannerMessages {
  system: string;
  user: string;
}

export interface PlannerOptions {
  /** 最多保留几个窗口；默认不限，只有显式限流时才截断 */
  maxWindows?: number;
  /** 单窗口最长秒数（默认 120） */
  maxWindowSeconds?: number;
  /** 送进提示词的字幕字符上限（默认 12000） */
  maxAsrChars?: number;
  /** 送进提示词的弹幕条数上限（默认 240） */
  maxDanmaku?: number;
}

const DEFAULTS = {
  maxWindows: Number.POSITIVE_INFINITY,
  maxWindowSeconds: 120,
  maxAsrChars: 12_000,
  maxDanmaku: 240,
} as const;

/** 从快照估计时长：video.duration_s 优先，其次字幕/弹幕的最大时间戳 */
export function estimateDuration(snapshot: VideoSnapshot): number {
  const declared = snapshot.video?.duration_s;
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) return declared;
  const transcriptEnd = snapshot.transcript?.segments?.at(-1)?.end_s ?? 0;
  const danmakuEnd = snapshot.danmaku.reduce((max, d) => (d.t > max ? d.t : max), 0);
  return Math.max(transcriptEnd, danmakuEnd);
}

const fmtTime = (seconds: number): string => `${seconds.toFixed(1)}s`;

function insideWindow(t: number, windows: RiskWindow[]): boolean {
  return windows.some((w) => t >= w.start_s && t <= w.end_s);
}

/** 选中窗口内的条目优先，其余按时间顺序补齐到字符上限 */
function selectTranscriptLines(
  snapshot: VideoSnapshot,
  candidateWindows: RiskWindow[],
  maxChars: number,
): string[] {
  const segments = normalizeTranscript(snapshot).filter((segment) => segment.text.trim());
  if (segments.length === 0) return [];
  const prioritized = [
    ...segments.filter((segment) => insideWindow(segment.start_s, candidateWindows)),
    ...segments.filter((segment) => !insideWindow(segment.start_s, candidateWindows)),
  ];
  const lines: string[] = [];
  let used = 0;
  for (const segment of prioritized) {
    const line = `[${fmtTime(segment.start_s)}-${fmtTime(segment.end_s)}] ${segment.text.trim()}`;
    if (used + line.length > maxChars) continue;
    lines.push(line);
    used += line.length;
  }
  // 优先条目被拼接后顺序会乱；按起始时间还原，模型读起来与视频时间轴一致
  return lines.sort((a, b) => {
    const ta = Number.parseFloat(a.slice(1));
    const tb = Number.parseFloat(b.slice(1));
    return ta - tb;
  });
}

function selectDanmakuLines(
  snapshot: VideoSnapshot,
  candidateWindows: RiskWindow[],
  maxLines: number,
): string[] {
  const entries = snapshot.danmaku.filter((entry) => entry.text.trim());
  if (entries.length === 0) return [];
  const inWindows = entries.filter((entry) => insideWindow(entry.t, candidateWindows));
  const outside = entries.filter((entry) => !insideWindow(entry.t, candidateWindows));
  return [...inWindows, ...outside]
    .slice(0, maxLines)
    .sort((a, b) => a.t - b.t)
    .map((entry) => `[${fmtTime(entry.t)}] ${entry.text.trim()}`);
}

/**
 * 构造窗口规划提示词。候选窗口来自 deterministic 粗定位，只作为提示，
 * 最终窗口由模型结合字幕/弹幕语义决定。
 */
export function buildWindowPlannerMessages(
  snapshot: VideoSnapshot,
  options: PlannerOptions = {},
): PlannerMessages {
  const maxWindows = options.maxWindows ?? DEFAULTS.maxWindows;
  const maxWindowSeconds = options.maxWindowSeconds ?? DEFAULTS.maxWindowSeconds;
  const maxAsrChars = options.maxAsrChars ?? DEFAULTS.maxAsrChars;
  const maxDanmaku = options.maxDanmaku ?? DEFAULTS.maxDanmaku;

  const duration = estimateDuration(snapshot);
  const segments = normalizeTranscript(snapshot);
  const localization = localizeRisks(snapshot.danmaku, segments, { topK: 6 });
  const candidateWindows = localization.windows;
  const transcriptLines = selectTranscriptLines(snapshot, candidateWindows, maxAsrChars);
  const danmakuLines = selectDanmakuLines(snapshot, candidateWindows, maxDanmaku);

  const video = snapshot.video;
  const metaLines = [
    `BV 号：${snapshot.bvid}`,
    `标题：${video?.title ?? "（无）"}`,
    `简介：${(video?.desc ?? "（无）").slice(0, 600)}`,
    `时长：${duration > 0 ? fmtTime(duration) : "未知"}`,
    `字幕段：${segments.length}，弹幕：${snapshot.danmaku.length}，评论：${snapshot.comments.length}`,
  ];

  const candidateLines = candidateWindows.length === 0
    ? ["（无确定性粗定位候选；请主要依据字幕与弹幕语义决定）"]
    : candidateWindows.map(
        (w) =>
          `- ${fmtTime(w.start_s)}-${fmtTime(w.end_s)}，得分 ${w.score}` +
          `${w.has_link ? "，含链接" : ""}` +
          `${w.transcript_excerpt ? `，字幕摘录：${w.transcript_excerpt.slice(0, 80)}` : ""}`,
      );

  const maxWindowLimit = Math.min(
    maxWindowSeconds,
    Math.max(5, Math.round(duration || maxWindowSeconds)),
  );
  const windowCountRule = Number.isFinite(maxWindows)
    ? `- 最多 ${maxWindows} 个窗口，单窗口不超过 ${maxWindowLimit} 秒，互不重叠；\n`
    : `- 窗口数量不设上限，按实际需要核对的画面给足；单窗口不超过 ${maxWindowLimit} 秒，互不重叠；\n`;

  const system =
    "你是短视频诈骗审查的抽帧窗口规划器。你只决定“看哪几段画面”，不做最终风险定性。\n" +
    "目标：选出最可能包含可核查视觉证据的时间窗，让后续视觉模型按九宫格看清关键帧。\n" +
    "优先画面：聊天记录、转账/收款码、平台/客服界面、二维码、联系方式、收益或中奖截图、屏幕共享、仿冒官方页面。\n" +
    "纪律：\n" +
    "- 只依据给你的字幕、弹幕和元信息，不要臆测没出现的内容；\n" +
    "- 窗口必须落在视频时长内，按时长上限截短；\n" +
    windowCountRule +
    "- 没有值得看画面的段落时返回空数组，不要为了凑数给窗口；\n" +
    "- 纯口播、无视觉证据的段落优先级要低；\n" +
    "只输出一个 JSON 对象，不要前后解释。格式：\n" +
    `{"windows":[{"start_s":0,"end_s":30,"reason":"为什么这段值得看画面","priority":0.9}],"notes":"可选"}`;

  const user =
    `【视频元信息】\n${metaLines.join("\n")}\n\n` +
    `【确定性粗定位候选（仅供参考）】\n${candidateLines.join("\n")}\n\n` +
    `【字幕/ASR】\n${transcriptLines.length > 0 ? transcriptLines.join("\n") : "（无字幕/转写）"}\n\n` +
    `【弹幕样本（按时间）】\n${danmakuLines.length > 0 ? danmakuLines.join("\n") : "（无弹幕数据）"}\n\n` +
    (Number.isFinite(maxWindows)
      ? `请给出最多 ${maxWindows} 个抽帧窗口的 JSON。`
      : "请给出需要核对的抽帧窗口 JSON（数量不限）。");

  return { system, user };
}

export interface ParsePlanContext {
  bvid: string;
  /** 已知时长时用于夹取；未知传 0 表示不夹上界 */
  durationS?: number;
  maxWindows?: number;
  /** 单窗口最长秒数（默认 120），模型输出超长时从起点截断 */
  maxWindowSeconds?: number;
}

export class FramePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramePlanError";
  }
}

/** 从模型回执里摘出第一个完整 JSON 对象（允许代码块、前后说明） */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const MIN_WINDOW_S = 1;
const MERGE_GAP_S = 1;

interface RawWindow {
  start_s: number;
  end_s: number;
  reason: string;
  priority: number;
}

function normalizeWindows(
  raw: unknown,
  durationS: number,
  maxWindows: number,
  maxWindowSeconds: number,
): FrameWindow[] {
  if (!Array.isArray(raw)) throw new FramePlanError("规划结果缺少 windows 数组");
  const windows: RawWindow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const start = toNumber(record.start_s);
    const end = toNumber(record.end_s);
    if (start === null || end === null) continue;
    let lo = Math.min(start, end);
    let hi = Math.max(start, end);
    if (durationS > 0) {
      lo = Math.max(0, Math.min(lo, durationS));
      hi = Math.max(0, Math.min(hi, durationS));
    } else {
      lo = Math.max(0, lo);
      hi = Math.max(0, hi);
    }
    // 模型可能给整个视频一个窗口；从起点截到上限，避免单窗口抽帧失控
    hi = Math.min(hi, lo + maxWindowSeconds);
    if (hi - lo < MIN_WINDOW_S) {
      if (durationS > 0) {
        if (lo + MIN_WINDOW_S <= durationS) hi = lo + MIN_WINDOW_S;
        else {
          hi = durationS;
          lo = Math.max(0, durationS - MIN_WINDOW_S);
        }
      } else {
        hi = lo + MIN_WINDOW_S;
      }
    }
    if (hi - lo < MIN_WINDOW_S) continue;
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    const priorityRaw = toNumber(record.priority);
    windows.push({
      start_s: lo,
      end_s: hi,
      reason: reason || "规划器未给理由",
      priority: priorityRaw === null ? 0.5 : Math.max(0, Math.min(1, priorityRaw)),
    });
  }
  if (windows.length === 0) throw new FramePlanError("规划结果没有可用的时间窗");

  // 按优先级保留前 N 个，再按时间合并重叠/近邻窗口
  const chosen = windows
    .slice()
    .sort((a, b) => b.priority - a.priority || a.start_s - b.start_s)
    .slice(0, Math.max(1, maxWindows));
  chosen.sort((a, b) => a.start_s - b.start_s);

  const merged: RawWindow[] = [];
  for (const window of chosen) {
    const last = merged.at(-1);
    if (last && window.start_s - last.end_s <= MERGE_GAP_S) {
      last.end_s = Math.max(last.end_s, window.end_s);
      last.priority = Math.max(last.priority, window.priority);
      if (window.reason !== last.reason) last.reason = `${last.reason}；${window.reason}`;
    } else {
      merged.push({ ...window });
    }
  }
  return merged.map(({ start_s, end_s, reason, priority }) => ({ start_s, end_s, reason, priority }));
}

/** 解析模型回执；越界、重叠、超量都在这里收敛，抛 FramePlanError 表示不可用 */
export function parseFramePlan(text: string, context: ParsePlanContext): FramePlan {
  const json = extractJsonObject(text);
  if (json === null) throw new FramePlanError("回执里没有 JSON 对象");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new FramePlanError(`规划 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FramePlanError("规划 JSON 不是对象");
  }
  const record = parsed as Record<string, unknown>;
  const durationS = context.durationS ?? 0;
  const maxWindows = context.maxWindows ?? DEFAULTS.maxWindows;
  const maxWindowSeconds = context.maxWindowSeconds ?? DEFAULTS.maxWindowSeconds;
  const windows = normalizeWindows(record.windows, durationS, maxWindows, maxWindowSeconds);
  const notes = typeof record.notes === "string" && record.notes.trim() ? record.notes.trim() : undefined;
  return {
    bvid: context.bvid,
    policy_version: FRAME_POLICY_VERSION,
    planner_version: PLANNER_PROMPT_VERSION,
    windows,
    ...(notes === undefined ? {} : { notes }),
  };
}

export type PlannerChat = (
  messages: Array<{ role: "system" | "user"; content: string }>,
) => Promise<string>;

/** 走注入的 chat 完成一次规划调用；调用方决定模型与重试 */
export async function planWindowsWithModel(
  chat: PlannerChat,
  snapshot: VideoSnapshot,
  options: PlannerOptions & { durationS?: number } = {},
): Promise<FramePlan> {
  const messages = buildWindowPlannerMessages(snapshot, options);
  const reply = await chat([
    { role: "system", content: messages.system },
    { role: "user", content: messages.user },
  ]);
  const durationS = options.durationS ?? estimateDuration(snapshot);
  return parseFramePlan(reply, {
    bvid: snapshot.bvid,
    durationS: durationS > 0 ? durationS : 0,
    maxWindows: options.maxWindows ?? DEFAULTS.maxWindows,
    maxWindowSeconds: options.maxWindowSeconds ?? DEFAULTS.maxWindowSeconds,
  });
}

/** 命中关键词或链接的弹幕时间点：这些点会作为抽帧中心 */
export function collectFocusTimes(
  danmaku: DanmakuEntry[],
  window: { start_s: number; end_s: number },
): number[] {
  return danmaku
    .filter(
      (entry) =>
        entry.t >= window.start_s &&
        entry.t <= window.end_s &&
        (scanKeywords(entry.text).length > 0 || extractLinks(entry.text, "frame_focus").length > 0),
    )
    .map((entry) => entry.t);
}

/** 把窗口内命中的可疑弹幕时间点挂到窗口上；已有 focus_times 时合并去重 */
export function attachFocusTimes(
  snapshot: VideoSnapshot,
  windows: FrameWindow[],
): FrameWindow[] {
  return windows.map((window) => {
    const merged = [
      ...new Set([
        ...(window.focus_times ?? []),
        ...collectFocusTimes(snapshot.danmaku, window),
      ]),
    ].sort((a, b) => a - b);
    return { ...window, ...(merged.length === 0 ? {} : { focus_times: merged }) };
  });
}

/**
 * 无模型时的冒烟窗口：按得分取粗定位 top-K，再按时间回排。
 * 只用于本地验证抽帧链路，不替代大模型规划；没有命中时试看开头 30 秒。
 */
export function heuristicWindows(
  snapshot: VideoSnapshot,
  options: { maxWindows?: number } = {},
): FrameWindow[] {
  const maxWindows = options.maxWindows ?? DEFAULTS.maxWindows;
  const segments = normalizeTranscript(snapshot);
  const localization = localizeRisks(snapshot.danmaku, segments, {
    topK: Number.isFinite(maxWindows) ? Math.max(maxWindows, 6) : Number.POSITIVE_INFINITY,
  });
  if (localization.windows.length > 0) {
    const byScore = localization.windows
      .slice()
      .sort((a, b) => b.score - a.score || a.start_s - b.start_s);
    const limited = Number.isFinite(maxWindows)
      ? byScore.slice(0, Math.max(1, maxWindows))
      : byScore;
    return limited
      .sort((a, b) => a.start_s - b.start_s)
      .map((window) => ({
        start_s: window.start_s,
        end_s: window.end_s,
        reason: `启发式粗定位：得分 ${window.score}${window.has_link ? "，含链接" : ""}`,
        priority: Math.min(1, window.score / 10),
        focus_times: collectFocusTimes(snapshot.danmaku, window),
      }));
  }
  const duration = estimateDuration(snapshot);
  if (duration <= 0) return [];
  return [{
    start_s: 0,
    end_s: Math.min(30, duration),
    reason: "无关键词命中，试看开头（仅冒烟用）",
    priority: 0.1,
  }];
}
