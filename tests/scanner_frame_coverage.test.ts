// 抽帧窗口覆盖率评测：窗口分类、覆盖判定（半开区间/格号）、汇总口径（评论区单列、缺 manifest 不进分母）。
// 运行: bun test tests/scanner_frame_coverage.test.ts
import { describe, expect, test } from "bun:test";
import {
  classifyWindow,
  coverWindow,
  frameGridIndex,
  summarizeFrameCoverage,
  type CoverageCase,
} from "../benchmarks/scanner_frame_coverage";

describe("窗口分类", () => {
  test("评论区/弹幕/置顶归 comment 类，画面类与空 note 归 visual", () => {
    expect(classifyWindow("添加评论区置顶联系方式获得资料")).toBe("comment");
    expect(classifyWindow("弹幕引导私聊")).toBe("comment");
    expect(classifyWindow("展示了群聊二维码")).toBe("visual");
    expect(classifyWindow("")).toBe("visual");
    expect(classifyWindow(undefined)).toBe("visual");
  });
});

describe("覆盖判定", () => {
  const frames = [{ t: 1 }, { t: 4 }, { t: 7 }, { t: 10 }, { t: 13 }];

  test("半开区间 [start,end)：帧落在起点算覆盖，落在终点不算", () => {
    expect(coverWindow(frames, { start_s: 4, end_s: 7 }).covered).toBe(true);
    const atEnd = coverWindow([{ t: 7 }], { start_s: 4, end_s: 7 });
    expect(atEnd.covered).toBe(false);
  });

  test("未覆盖返回 null 格号；覆盖帧按数组顺序定九宫格序号", () => {
    const miss = coverWindow(frames, { start_s: 20, end_s: 30 });
    expect(miss).toEqual({ covered: false, first_grid: null, frame_t: null });
    // 第 10 帧（序 10）在第 2 格（每格 9 帧）
    expect(frameGridIndex(1)).toBe(1);
    expect(frameGridIndex(9)).toBe(1);
    expect(frameGridIndex(10)).toBe(2);
    const deep = coverWindow(Array.from({ length: 10 }, (_, i) => ({ t: i + 1 })), { start_s: 9.5, end_s: 10.5 });
    expect(deep.first_grid).toBe(2);
  });
});

describe("汇总口径", () => {
  const cases: CoverageCase[] = [
    {
      bv: "BV1a", risk: "high",
      windows: [
        { start_s: 0, end_s: 5, note: "展示了群聊二维码" },
        { start_s: 10, end_s: 15, note: "评论区置顶联系方式" },
        { start_s: 30, end_s: 35, note: "宣称月入过万" },
      ],
      manifest: { frames: [{ t: 2 }, { t: 12 }], author_level: "low" },
    },
    { bv: "BV1b", risk: "medium", windows: [{ start_s: 0, end_s: 5, note: "引导加微信" }], manifest: null },
  ];

  test("visual 为主指标；comment 单列；缺 manifest 不进分母", () => {
    const report = summarizeFrameCoverage(cases);
    // BV1b 缺 manifest → 其窗口不进分母；BV1a 剩 visual 2 + comment 1
    expect(report.totals).toMatchObject({
      videos: 2, videos_missing_manifest: 1,
      windows: 3, visual_windows: 2, visual_covered: 1, comment_windows: 1, comment_covered: 1,
    });
    expect(report.visual.overall).toEqual({ windows: 2, covered: 1, coverage: 1 / 2 });
    expect(report.comment).toEqual({ windows: 1, covered: 1, coverage: 1 });
    expect(report.missing_manifest).toEqual(["BV1b"]);
  });

  test("recall@k 按覆盖帧格号计；未覆盖窗口如实列出", () => {
    const report = summarizeFrameCoverage(cases);
    // visual：BV1a@0-5 覆盖于格 1；BV1a@30-35 未覆盖 → @1=@5=1/2
    expect(report.visual.recall_at_k["@1"]).toBe(1 / 2);
    expect(report.visual.recall_at_k["@5"]).toBe(1 / 2);
    expect(report.uncovered.map((r) => r.bv)).toEqual(["BV1a"]);
    expect(report.uncovered[0]!.level).toBe("low");
  });

  test("按实际预算档位分组", () => {
    const report = summarizeFrameCoverage(cases);
    expect(report.visual.by_level.low).toEqual({ windows: 2, covered: 1, coverage: 1 / 2 });
  });
});
