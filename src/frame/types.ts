// src/frame/types.ts
/**
 * 抽帧阶段的数据结构：窗口规划 → 确定性采样 → 九宫格拼图。
 * 抽帧与视觉判读分离：这里只生产帧和拼图，不下任何风险结论。
 */

/** 规划器给出的待看时间窗（秒） */
export interface FrameWindow {
  start_s: number;
  end_s: number;
  reason: string;
  /** 0~1，规划器认为的优先级；用于窗口过多时截断 */
  priority?: number;
}

export interface FramePlan {
  bvid: string;
  /** 采样策略版本：换策略必须改它，否则旧结果不可复现 */
  policy_version: string;
  /** 窗口规划提示词版本：换提示词必须改它 */
  planner_version: string;
  windows: FrameWindow[];
  notes?: string;
}

export type PlanSource = "plan_file" | "heuristic" | "model";

export type FrameReason = "scene" | "interval" | "edge";

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
  /** 只包含真实帧的格位；空格位不列出 */
  cells: GridCell[];
}

/** CLI/批次产物：一份 manifest 足够复现与下游消费 */
export interface FrameBundle {
  bvid: string;
  policy_version: string;
  planner_version: string;
  plan_source: PlanSource;
  plan_notes?: string;
  video_path: string;
  duration_s: number;
  generated_at: string;
  windows: FrameWindow[];
  frames: ExtractedFrame[];
  grids: FrameGrid[];
}

export const FRAME_POLICY_VERSION = "frames/v1";
export const PLANNER_PROMPT_VERSION = "planner/v1";

/** 一个窗口最多拼几张（九宫格上限） */
export const MAX_FRAMES_PER_GRID = 9;
