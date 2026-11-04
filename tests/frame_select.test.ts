import { describe, expect, test } from "bun:test";
import { frameBudgetFor } from "../src/frame/policy";
import {
  allocateQuotas,
  appendCoverageWindows,
  capFocusPerSegment,
  dedupeByHash,
  dedupeByTime,
  selectFrameCandidates,
  type FrameCandidate,
} from "../src/frame/select";
import type { FrameWindow } from "../src/frame/types";
import type { VideoProfile } from "../src/frame/profile";

function candidate(
  t: number,
  reason: FrameCandidate["reason"],
  score: number,
  hash?: string,
  windowIndex = 1,
): FrameCandidate {
  return {
    t,
    window_index: windowIndex,
    reason,
    score,
    ...(hash === undefined ? {} : { hash }),
  };
}

describe("覆盖窗口", () => {
  test("长空档按预算步长补窗口，起点偏移 0.5s", () => {
    const windows = appendCoverageWindows(
      [{ start_s: 0, end_s: 2, reason: "命中", source: "plan" }],
      600,
      frameBudgetFor("low"),
    );
    const coverage = windows.filter((window) => window.source === "coverage");
    expect(coverage.length).toBe(5);
    expect(coverage[0]!.start_s).toBe(2.5);
    expect(coverage.at(-1)!.end_s).toBe(599.5);
  });

  test("空档短于阈值时不补窗口", () => {
    const windows = appendCoverageWindows(
      [
        { start_s: 0, end_s: 2, reason: "a", source: "plan" },
        { start_s: 100, end_s: 110, reason: "b", source: "plan" },
      ],
      110,
      frameBudgetFor("high"),
      { coverageMinGapS: 180 },
    );
    expect(windows).toHaveLength(2);
  });
});

describe("召回回归", () => {
  test("短视频未规划的后半段也有覆盖，空计划按全片分段", () => {
    const budget = frameBudgetFor("medium");
    const windows = appendCoverageWindows([{ start_s: 0, end_s: 10, reason: "重点" }], 120, budget);
    expect(windows.some((window) => window.source === "coverage" && window.end_s > 100)).toBe(true);
    const empty = appendCoverageWindows([], 120, budget);
    expect(empty).toHaveLength(4);
    expect(selectFrameCandidates({ windows: empty, budget }).selected).toHaveLength(4);
  });

  test("覆盖预留不被大量重点窗口挤掉，且覆盖跨越全片", () => {
    const planned: FrameWindow[] = Array.from({ length: 20 }, (_, i) => ({
      start_s: i * 10, end_s: i * 10 + 2, reason: "重点", priority: 1,
    }));
    const coverage: FrameWindow[] = Array.from({ length: 20 }, (_, i) => ({
      start_s: 200 + i * 10, end_s: 210 + i * 10, reason: "覆盖", source: "coverage",
    }));
    const windows = [...planned, ...coverage];
    const result = selectFrameCandidates({ windows, budget: { ...frameBudgetFor("clean"), max_frames: 10 } });
    expect(result.selected).toHaveLength(10);
    expect(result.selected.filter((item) => item.window_index > 20).map((item) => item.t)).toEqual([205, 395]);
    const single = selectFrameCandidates({ windows, budget: { ...frameBudgetFor("clean"), max_frames: 1 } });
    expect(single.selected).toHaveLength(1);
    expect(single.selected[0]!.window_index).toBeLessThanOrEqual(20);
  });

  test("覆盖选变化峰值，同哈希的不同覆盖段仍保留", () => {
    const profile = fakeProfile(Array.from({ length: 20 }, (_, t) => ({
      t, change: t === 8 || t === 18 ? 0.5 : 0, text: 0, hash: "0000000000000000",
    })));
    const result = selectFrameCandidates({
      windows: [0, 10].map((start_s) => ({ start_s, end_s: start_s + 10, reason: "覆盖", source: "coverage" })),
      budget: frameBudgetFor("clean"), profile,
    });
    expect(result.selected.map((item) => item.t)).toEqual([8, 18]);
  });

  test("文字变化不被整图哈希抹掉，限额覆盖文字变化的首尾", () => {
    const profile = fakeProfile(Array.from({ length: 120 }, (_, t) => ({
      t, change: 0.01, text: t % 2 === 0 ? 0.5 : 0, hash: "0000000000000000",
    })));
    const result = selectFrameCandidates({
      windows: [{ start_s: 0, end_s: 120, reason: "聊天记录" }],
      budget: frameBudgetFor("medium"), profile,
    });
    const text = result.selected.filter((item) => item.reason === "text");
    expect(text).toHaveLength(6);
    expect(text[0]!.t).toBe(0);
    expect(text.at(-1)!.t).toBe(118);
  });

  test("两次同分截断仍保留窗口后半段的硬切", () => {
    const result = selectFrameCandidates({
      windows: [{ start_s: 0, end_s: 120, reason: "快切" }],
      budget: frameBudgetFor("clean"),
      sceneTimes: new Map([[1, Array.from({ length: 23 }, (_, i) => (i + 1) * 5)]]),
    });
    expect(result.selected).toHaveLength(4);
    expect(result.selected[0]!.t).toBe(5);
    expect(result.selected.at(-1)!.t).toBe(115);
  });
});

describe("候选去重", () => {
  test("0.5s 内保留分数更高的候选", () => {
    const kept = dedupeByTime([candidate(1, "interval", 40), candidate(1.2, "focus", 100)]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.reason).toBe("focus");
  });

  test("相同画面的普通候选被去重，focus 永远保留", () => {
    const kept = dedupeByHash([
      candidate(1, "interval", 40, "0000000000000000"),
      candidate(2, "interval", 40, "0000000000000000"),
      candidate(3, "focus", 100, "0000000000000000"),
    ]);
    expect(kept.map((item) => item.reason).sort()).toEqual(["focus", "interval"]);
  });

  test("硬切只去近乎相同的帧，普通帧允许更大距离", () => {
    const base = "0".repeat(16);
    const near = `${"0".repeat(15)}f`;
    const normal = dedupeByHash([
      candidate(1, "interval", 40, base),
      candidate(2, "interval", 40, near),
    ]);
    expect(normal).toHaveLength(1);
    const withScene = dedupeByHash([
      candidate(1, "interval", 40, base),
      candidate(2, "scene", 80, near),
    ]);
    expect(withScene).toHaveLength(2);
  });
});

describe("预算分配", () => {
  test("每窗先保 1 张，再按优先级加权，总数不超过预算", () => {
    const windows: FrameWindow[] = [
      { start_s: 0, end_s: 10, reason: "a", priority: 0.9 },
      { start_s: 10, end_s: 20, reason: "b", priority: 0.5 },
      { start_s: 20, end_s: 30, reason: "c", priority: 0.1 },
    ];
    const quotas = allocateQuotas(windows, [10, 10, 10], 20);
    expect(quotas.reduce((sum, item) => sum + item, 0)).toBe(20);
    expect(quotas[0]!).toBeGreaterThan(quotas[1]!);
    expect(quotas[1]!).toBeGreaterThan(quotas[2]!);
    expect(quotas.every((item) => item >= 1)).toBe(true);
  });

  test("容量耗尽后预算不再分配", () => {
    const quotas = allocateQuotas(
      [
        { start_s: 0, end_s: 10, reason: "a", priority: 0.9 },
        { start_s: 10, end_s: 20, reason: "b", priority: 0.1 },
      ],
      [1, 10],
      5,
    );
    expect(quotas[0]).toBe(1);
    expect(quotas[1]).toBe(4);
  });
});

function fakeProfile(
  samples: Array<{ t: number; change: number; text: number; hash: string; luminance?: number }>,
): VideoProfile {
  const visual = samples.map((sample) => ({
    t: sample.t,
    change: sample.change,
    mean_delta: sample.change,
    text_change: sample.text,
    luminance: sample.luminance ?? 0.5,
    edge: 0.1,
    hash: sample.hash,
  }));
  return {
    meta: { duration_s: 60, width: 640, height: 360, rotation: 0, has_audio: true, fps: 25, bit_depth: 8, hdr: false },
    orientation: "landscape",
    kind: "mixed",
    text_heavy: true,
    repetitive: false,
    step_s: 1,
    samples: visual,
    summary: {
      kind: "mixed",
      orientation: "landscape",
      text_heavy: true,
      repetitive: false,
      sample_count: visual.length,
      static_ratio: 0,
      big_change_ratio: 0,
      text_active_ratio: 0,
      avg_edge: 0.1,
      cut_count: 0,
      duplicate_ratio: 0,
    },
    notes: [],
  };
}

describe("文字带取样", () => {
  test("画面基本静止时按文字带补帧", () => {
    const profile = fakeProfile([
      { t: 2, change: 0.01, text: 0.5, hash: "0000000000000000" },
      { t: 3, change: 0.5, text: 0.7, hash: "ffffffffffffffff" },
    ]);
    const result = selectFrameCandidates({
      windows: [{ start_s: 0, end_s: 12, reason: "口播", source: "plan" }],
      budget: frameBudgetFor("medium"),
      profile,
      sceneTimes: new Map(),
    });
    const text = result.selected.filter((item) => item.reason === "text").map((item) => item.t);
    expect(text).toEqual([2]);
  });
});

describe("focus 分段限流", () => {
  test("同一视觉段落最多 3 个，按首尾+中间均匀保留", () => {
    expect(capFocusPerSegment([1, 2, 3, 4, 5, 6], [], 3)).toEqual([1, 4, 6]);
  });

  test("硬切把 focus 分成不同段落，各自独立限流", () => {
    expect(capFocusPerSegment([1, 2, 3, 4, 5, 6], [2.5], 3)).toEqual([1, 2, 3, 5, 6]);
  });

  test("不足上限时全部保留", () => {
    expect(capFocusPerSegment([2, 4, 6], [3], 3)).toEqual([2, 4, 6]);
  });

  test("选帧入口对同一窗口的 focus 生效", () => {
    const result = selectFrameCandidates({
      windows: [{ start_s: 0, end_s: 10, reason: "片头", source: "plan", focus_times: [1, 2, 3, 4, 5, 6] }],
      budget: frameBudgetFor("medium"),
      sceneTimes: new Map([[1, []]]),
    });
    expect(result.selected.filter((item) => item.reason === "focus").map((item) => item.t)).toEqual([1, 4, 6]);
  });
});

describe("黑屏过滤", () => {
  test("黑屏帧不取样，覆盖窗口顺延到第一个可见点", () => {
    const profile = fakeProfile([
      { t: 0.5, change: 0, text: 0, hash: "0000000000000000", luminance: 0 },
      { t: 2, change: 0, text: 0, hash: "ffffffffffffffff", luminance: 0.5 },
      { t: 6, change: 0, text: 0, hash: "aaaaaaaaaaaaaaaa", luminance: 0.5 },
    ]);
    const result = selectFrameCandidates({
      windows: [{ start_s: 0, end_s: 8, reason: "覆盖", source: "coverage" }],
      budget: frameBudgetFor("low"),
      profile,
      sceneTimes: new Map(),
    });
    expect(result.selected.map((item) => item.t)).toEqual([2]);
  });
});

describe("选帧入口", () => {
  test("预算只够一帧时优先给命中可疑弹幕的窗口", () => {
    const result = selectFrameCandidates({
      windows: [
        { start_s: 0, end_s: 10, reason: "普通", source: "plan" },
        { start_s: 20, end_s: 30, reason: "可疑", source: "plan", focus_times: [25] },
      ],
      budget: {
        level: "clean",
        max_grids: 1,
        max_frames: 1,
        per_window_max: 4,
        coverage_step_s: 240,
      },
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]!.t).toBe(25);
    expect(result.selected[0]!.reason).toBe("focus");
  });

  test("无画像时窗口仍有探针候选，且总数受预算限制", () => {
    const budget = frameBudgetFor("clean");
    const result = selectFrameCandidates({
      windows: [
        { start_s: 0, end_s: 10, reason: "a", source: "plan" },
        { start_s: 20, end_s: 30, reason: "b", source: "plan" },
      ],
      budget,
    });
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected.length).toBeLessThanOrEqual(budget.max_frames);
    expect(result.selected.every((item) => item.reason === "interval")).toBe(true);
  });
});
