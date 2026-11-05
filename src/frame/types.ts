// src/frame/types.ts
/**
 * 抽帧阶段的数据结构：窗口规划 → 视觉画像 → 确定性采样 → 九宫格拼图。
 * 抽帧与视觉判读分离：这里只生产帧和拼图，不下任何风险结论。
 */
import type { AuthorRiskLevel, AuthorRiskScore } from "../bili/author_risk";
import type { VideoProfileSummary } from "./profile";
import type { AuthorHistory } from "../bili/author_history";
import type { measureDataCoverage } from "../bili/coverage";
import type { associateContacts } from "../bili/contacts";

/** 规划器给出的待看时间窗（秒） */
export interface FrameWindow {
  start_s: number;
  end_s: number;
  reason: string;
  /** 0~1，规划器认为的优先级；预算紧张时优先保高优先级窗口 */
  priority?: number;
  /** 可疑弹幕时间点与 ASR/字幕命中区间代表点（秒），供重点取帧 */
  focus_times?: number[];
  /** 窗口来源：模型/人工规划、启发式、全片覆盖探针 */
  source?: "plan" | "heuristic" | "coverage";
}

export interface FramePlan {
  bvid: string;
  /** 采样策略版本：换策略必须改它，以便区分历史产物 */
  policy_version: string;
  /** 窗口规划提示词版本：换提示词必须改它 */
  planner_version: string;
  windows: FrameWindow[];
  notes?: string;
}

export type PlanSource = "plan_file" | "heuristic" | "model";

export type FrameReason = "scene" | "focus" | "interval" | "state" | "text";

export interface ExtractedFrame {
  /** 原分辨率帧文件（供 OCR / 单帧放大用） */
  path: string;
  /** 帧在视频中的秒数 */
  t: number;
  /** 属于第几个窗口（1 起） */
  window_index: number;
  reason: FrameReason;
  sha256: string;
}

export interface GridCell {
  /** 九宫格内的格位，1~9，行优先 */
  index: number;
  t: number;
  frame_path: string;
}

export interface FrameGrid {
  path: string;
  width: number;
  height: number;
  /** 本张图覆盖的窗口编号；跨窗口连续填充时可能有多个 */
  window_indexes: number[];
  /** 只包含真实帧的格位；空格位不列出 */
  cells: GridCell[];
}

/** 本次抽帧采用的预算与来源，便于复现和解释"为什么只看了这么多张" */
export interface FramePolicyInfo {
  /** 以下作者档位/分数仅控制抽帧预算，不是 scanner 的作者风险结论 */
  author_level: AuthorRiskLevel;
  author_score: number | null;
  author_reasons: string[];
  author_scoring?: AuthorRiskScore["semantic"] | { status: "rules" };
  max_grids: number;
  per_window_max: number;
  selected_frames: number;
  /** 是否因预算不足丢弃了候选 */
  truncated: boolean;
}

/** CLI/批次产物：一份 manifest 足够复现与下游消费 */
export interface FrameBundle {
  bvid: string;
  /** 只识别首个分 P（B 站 page=1 / 代码 0 基下标 0） */
  page: 1;
  policy_version: string;
  planner_version: string;
  plan_source: PlanSource;
  plan_notes?: string;
  video_path: string;
  duration_s: number;
  generated_at: string;
  inputs?: {
    data_coverage?: ReturnType<typeof measureDataCoverage>;
    contact_associations?: ReturnType<typeof associateContacts>;
    transcript_source: "cc" | "srt" | "asr" | "none";
    transcript_segments: number;
    author_history: AuthorHistory;
  };
  windows: FrameWindow[];
  frames: ExtractedFrame[];
  grids: FrameGrid[];
  profile?: VideoProfileSummary;
  policy: FramePolicyInfo;
}

export const FRAME_POLICY_VERSION = "frames/v10";
export const PLANNER_PROMPT_VERSION = "planner/v4";

/** 一个窗口最多拼几张（九宫格上限） */
export const MAX_FRAMES_PER_GRID = 9;
