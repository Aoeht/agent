// src/frame/policy.ts
/**
 * 抽帧预算：作者风险档位只决定"看多少张九宫格"，不决定结论。
 * 预算跨窗口共享，避免一个多窗口视频把单窗上限累加成失控总量。
 */
import type { AuthorRiskLevel } from "../bili/author_risk";
import { AUTHOR_MAX_GRIDS } from "../bili/author_risk";
import { MAX_FRAMES_PER_GRID } from "./types";

export interface FrameBudget {
  level: AuthorRiskLevel;
  /** 全局九宫格张数上限 */
  max_grids: number;
  /** 换算成帧数上限（最后一张允许不满） */
  max_frames: number;
  /** 单窗口帧数上限 */
  per_window_max: number;
  /** 低信号长视频的覆盖探针间隔（秒） */
  coverage_step_s: number;
}

const PER_WINDOW_MAX: Record<AuthorRiskLevel, number> = {
  high: 15,
  medium: 10,
  low: 6,
  clean: 4,
  unknown: 10,
};

const COVERAGE_STEP_S: Record<AuthorRiskLevel, number> = {
  high: 60,
  medium: 120,
  low: 180,
  clean: 240,
  unknown: 120,
};

export function frameBudgetFor(level: AuthorRiskLevel, overrides: { maxGrids?: number } = {}): FrameBudget {
  const max_grids = overrides.maxGrids ?? AUTHOR_MAX_GRIDS[level];
  if (!Number.isInteger(max_grids) || max_grids < 1) {
    throw new Error(`maxGrids 必须是正整数：${max_grids}`);
  }
  return {
    level,
    max_grids,
    max_frames: max_grids * MAX_FRAMES_PER_GRID,
    per_window_max: PER_WINDOW_MAX[level],
    coverage_step_s: COVERAGE_STEP_S[level],
  };
}
