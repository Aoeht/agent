import { describe, expect, test } from "bun:test";
import type { VideoSnapshot } from "../src/bili/snapshot";
import {
  buildWindowPlannerMessages,
  estimateDuration,
  FramePlanError,
  heuristicWindows,
  parseFramePlan,
} from "../src/frame/plan";

function snapshot(overrides: Partial<VideoSnapshot> = {}): VideoSnapshot {
  return {
    schema: "bili-snapshot/v1",
    bvid: "BV1FRAMETEST",
    fetched_at: "2026-11-02T00:00:00Z",
    video: { title: "测试视频", desc: "简介", tags: [], duration_s: 120 },
    danmaku: [],
    comments: [],
    ...overrides,
  };
}

describe("窗口规划提示词", () => {
  test("带上字幕、弹幕与输出格式要求", () => {
    const messages = buildWindowPlannerMessages(
      snapshot({
        danmaku: [{ t: 12, text: "加微信领资料" }],
        transcript: {
          source: "srt",
          segments: [{ start_s: 10, end_s: 20, text: "想学的加我微信" }],
        },
      }),
    );
    expect(messages.system).toContain("抽帧窗口规划器");
    expect(messages.system).toContain("priority");
    expect(messages.user).toContain("【字幕/ASR】");
    expect(messages.user).toContain("[10.0s-20.0s] 想学的加我微信");
    expect(messages.user).toContain("[12.0s] 加微信领资料");
    expect(messages.system).toContain("窗口数量不设上限");
    expect(messages.user).toContain("数量不限");
  });

  test("显式限流时提示词给出窗口上限", () => {
    const messages = buildWindowPlannerMessages(snapshot(), { maxWindows: 2 });
    expect(messages.system).toContain("最多 2 个窗口");
    expect(messages.user).toContain("最多 2 个抽帧窗口");
  });

  test("时长未知时也不崩，提示词按未知处理", () => {
    const bare = snapshot();
    delete bare.video;
    const messages = buildWindowPlannerMessages(bare);
    expect(messages.user).toContain("时长：未知");
    expect(messages.user).toContain("（无字幕/转写）");
  });
});

describe("规划解析", () => {
  test("按优先级截断后合并重叠窗口", () => {
    const plan = parseFramePlan(
      "先说明一下：\n```json\n" +
        JSON.stringify({
          windows: [
            { start_s: 50, end_s: 80, reason: "后半段" },
            { start_s: 10, end_s: 30, reason: "前段", priority: 0.9 },
            { start_s: 28, end_s: 35, reason: "重叠段", priority: 0.8 },
          ],
        }) +
        "\n```",
      { bvid: "BV1FRAMETEST", durationS: 120, maxWindows: 2 },
    );
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.start_s).toBe(10);
    expect(plan.windows[0]!.end_s).toBe(35);
    expect(plan.windows[0]!.reason).toContain("前段");
    expect(plan.windows[0]!.reason).toContain("重叠段");
  });

  test("默认不限制数量，保留 plan 里的全部窗口", () => {
    const plan = parseFramePlan(
      JSON.stringify({
        windows: [
          { start_s: 10, end_s: 20, reason: "a" },
          { start_s: 30, end_s: 40, reason: "b" },
          { start_s: 50, end_s: 60, reason: "c" },
          { start_s: 70, end_s: 80, reason: "d" },
        ],
      }),
      { bvid: "BV1FRAMETEST", durationS: 120 },
    );
    expect(plan.windows).toHaveLength(4);
    expect(plan.windows.map((window) => window.start_s)).toEqual([10, 30, 50, 70]);
  });

  test("越界窗口夹到视频时长内，负数起点归零", () => {
    const plan = parseFramePlan(
      JSON.stringify({ windows: [{ start_s: -5, end_s: 999, reason: "全片" }] }),
      { bvid: "BV1FRAMETEST", durationS: 120 },
    );
    expect(plan.windows[0]!.start_s).toBe(0);
    expect(plan.windows[0]!.end_s).toBe(120);
    expect(plan.planner_version).toBe("planner/v2");
  });

  test("超长窗口按上限从起点截断", () => {
    const plan = parseFramePlan(
      JSON.stringify({ windows: [{ start_s: 10, end_s: 600, reason: "整段" }] }),
      { bvid: "BV1FRAMETEST", durationS: 900, maxWindowSeconds: 120 },
    );
    expect(plan.windows[0]!.start_s).toBe(10);
    expect(plan.windows[0]!.end_s).toBe(130);
  });

  test("空数组与无 JSON 都抛可读错误", () => {
    expect(() => parseFramePlan('{"windows":[]}', { bvid: "BV1FRAMETEST", durationS: 120 }))
      .toThrow(FramePlanError);
    expect(() => parseFramePlan("没有 JSON", { bvid: "BV1FRAMETEST", durationS: 120 }))
      .toThrow(FramePlanError);
  });

  test("非法窗口被跳过，剩余窗口仍可用", () => {
    const plan = parseFramePlan(
      JSON.stringify({ windows: [{ start_s: "abc", end_s: 10 }, { start_s: 5, end_s: 9, reason: "可用" }] }),
      { bvid: "BV1FRAMETEST", durationS: 120 },
    );
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.start_s).toBe(5);
  });
});

describe("启发式冒烟窗口", () => {
  test("命中弹幕/字幕时返回覆盖命中点的时间窗", () => {
    const windows = heuristicWindows(
      snapshot({
        danmaku: [{ t: 12, text: "加微信领福利" }],
        transcript: {
          source: "srt",
          segments: [{ start_s: 10, end_s: 20, text: "加我微信领福利" }],
        },
      }),
    );
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.some((window) => window.start_s <= 12 && window.end_s >= 12)).toBe(true);
    expect(windows.flatMap((window) => window.focus_times ?? [])).toContain(12);
  });

  test("显式限流时按得分取窗口，再按时间返回", () => {
    const windows = heuristicWindows(
      snapshot({
        danmaku: [
          { t: 5, text: "加微信领资料" },
          { t: 55, text: "贷款贷款" },
          { t: 105, text: "贷款贷款贷款 稳赚稳赚稳赚" },
        ],
      }),
      { maxWindows: 2 },
    );
    // 得分最高的是 100-110s，其次是 50-60s；旧实现会错误地取最早的 0-10s
    expect(windows.map((window) => window.start_s)).toEqual([50, 100]);
  });

  test("默认保留全部候选窗口，不设数量上限", () => {
    const danmaku = Array.from({ length: 8 }, (_, index) => ({
      t: index * 30 + 5,
      text: "贷款贷款贷款",
    }));
    const windows = heuristicWindows(snapshot({ danmaku }));
    expect(windows).toHaveLength(8);
  });

  test("没有命中时试看开头，没有时长则返回空", () => {
    const withDuration = heuristicWindows(snapshot());
    expect(withDuration[0]!.start_s).toBe(0);
    expect(withDuration[0]!.end_s).toBe(30);

    const withoutVideo = snapshot();
    delete withoutVideo.video;
    expect(heuristicWindows(withoutVideo)).toEqual([]);
  });

  test("estimateDuration 优先元数据，其次时间戳", () => {
    expect(estimateDuration(snapshot())).toBe(120);

    const withoutVideo = snapshot({
      danmaku: [{ t: 42, text: "x" }],
      transcript: { source: "srt", segments: [{ start_s: 50, end_s: 60, text: "y" }] },
    });
    delete withoutVideo.video;
    expect(estimateDuration(withoutVideo)).toBe(60);
  });
});
