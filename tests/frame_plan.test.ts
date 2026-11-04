import { describe, expect, test } from "bun:test";
import type { VideoSnapshot } from "../src/bili/snapshot";
import {
  buildWindowPlannerMessages,
  estimateDuration,
  FramePlanError,
  heuristicWindows,
  parseFramePlan,
  attachFocusTimes,
  collectFocusTimes,
} from "../src/frame/plan";
import { selectFrameCandidates } from "../src/frame/select";
import { frameBudgetFor } from "../src/frame/policy";

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
    // “加我微信”不命中当前精确词表，不能把弹幕命中归到 ASR。
    expect(messages.user).toContain("ASR/字幕 0.00，弹幕 2.00，密度 0");
    expect(messages.system).toContain("弹幕是观众留言");
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
    expect(plan.planner_version).toBe("planner/v3");
  });

  test("超长窗口按上限从起点截断", () => {
    const plan = parseFramePlan(
      JSON.stringify({ windows: [{ start_s: 10, end_s: 600, reason: "整段" }] }),
      { bvid: "BV1FRAMETEST", durationS: 900, maxWindowSeconds: 120 },
    );
    expect(plan.windows[0]!.start_s).toBe(10);
    expect(plan.windows[0]!.end_s).toBe(130);
  });

  test("空计划合法，格式错误或全非法窗口仍报错", () => {
    expect(parseFramePlan('{"windows":[]}', { bvid: "BV1FRAMETEST", durationS: 120 }).windows).toEqual([]);
    expect(() => parseFramePlan('{"windows":[{"start_s":"abc"}]}', { bvid: "BV1FRAMETEST" })).toThrow(FramePlanError);
    expect(() => parseFramePlan('{}', { bvid: "BV1FRAMETEST" })).toThrow(FramePlanError);
    expect(() => parseFramePlan("没有 JSON", { bvid: "BV1FRAMETEST", durationS: 120 }))
      .toThrow(FramePlanError);
  });

  test("合并后的长窗口重新拆分，完整覆盖原区间且不突破长度上限", () => {
    const plan = parseFramePlan(JSON.stringify({ windows: [
      { start_s: 0, end_s: 120, priority: 0.8, reason: "前段" },
      { start_s: 119, end_s: 239, priority: 0.9, reason: "后段" },
    ] }), { bvid: "BV1FRAMETEST", durationS: 300, maxWindows: 2 });
    expect(plan.windows).toHaveLength(2);
    expect(plan.windows[0]!.start_s).toBe(0);
    expect(plan.windows.at(-1)!.end_s).toBe(239);
    expect(plan.windows[0]!.end_s).toBe(plan.windows[1]!.start_s);
    expect(plan.windows.every((w) => w.end_s - w.start_s <= 120 && w.priority === 0.9)).toBe(true);
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
  test("无弹幕 ASR 产生 focus，启发式与模型窗口共用且重复挂载幂等", () => {
    const input = snapshot({ transcript: { source: "asr", segments: [
      { start_s: 20, end_s: 24, text: "加微信领资料" },
    ] } });
    const heuristic = heuristicWindows(input);
    expect(heuristic[0]!.focus_times).toEqual([22]);
    const model = attachFocusTimes(input, [{ start_s: 10, end_s: 30, reason: "核对" }]);
    expect(model[0]!.focus_times).toEqual([22]);
    expect(attachFocusTimes(input, model)).toEqual(model);
    const selected = selectFrameCandidates({ windows: model, budget: { ...frameBudgetFor("clean"), max_frames: 1 } });
    expect(selected.selected[0]).toMatchObject({ t: 22, reason: "focus" });
  });

  test("ASR focus 在重叠区间内部取点，长段最多三点，边界与无关文本不产生点", () => {
    const points = collectFocusTimes([], { start_s: 20, end_s: 60 }, [
      { start_s: 0, end_s: 90, text: "加微信" },
      { start_s: 0, end_s: 20, text: "贷款" },
      { start_s: 60, end_s: 70, text: "贷款" },
      { start_s: 25, end_s: 30, text: "正常讲解" },
      { start_s: 30, end_s: 28, text: "贷款" },
    ]);
    expect(points).toHaveLength(3);
    expect(points[0]).toBeGreaterThan(20);
    expect(points.at(-1)).toBeLessThan(60);
    expect(points[1]).toBe(40);
    expect(collectFocusTimes([{ t: 22, text: "加微信" }], { start_s: 20, end_s: 30 }, [
      { start_s: 20, end_s: 24, text: "https://example.com" },
    ])).toEqual([22]);
  });

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
