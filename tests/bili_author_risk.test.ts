import { test, expect } from "bun:test";
import { AUTHOR_MAX_GRIDS, levelFromScore, raiseToHistory, scoreAuthor } from "../src/bili/author_risk";
import { frameBudgetFor } from "../src/frame/policy";

test("保留分档阈值与手动预算接口", () => {
  expect([29, 30, 49, 50, 69, 70].map(levelFromScore)).toEqual(["clean", "low", "low", "medium", "medium", "high"]);
  expect(AUTHOR_MAX_GRIDS).toEqual({ high: 20, medium: 10, low: 5, clean: 3, unknown: 10 });
});

test("账号规模只能弱加分：小号不单独进高档，大号不自动缩减覆盖", () => {
  for (const fans of [0, 9, 50, 500, 5000, 50_000, 500_000, 5_000_000]) {
    for (const official_type of [undefined, 0, 1, 2]) {
      const result = scoreAuthor({ fans, official_type, attention: 100, video_count: 200, total_views: 100 });
      expect(result.level).toBe("medium");
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.score).toBeLessThanOrEqual(60);
      expect(frameBudgetFor(result.level).max_frames).toBe(90);
    }
  }
  expect(scoreAuthor({ fans: 5, attention: 0, official_type: 0 }).level).toBe("medium");
  expect(scoreAuthor({ fans: 1_000_000, official_type: 2, total_views: 200_000_000 }).level).toBe("medium");
});

test("大号背书不能抵消文本线索；缺粉丝时文本照样提高预算", () => {
  for (const account of [{}, { fans: 1000 }, { fans: 1_000_000, official_type: 2, total_views: 200_000_000 }]) {
    expect(scoreAuthor({ ...account, sign: "加微信 稳赚 带单" })).toMatchObject({ score: 74, level: "high" });
    expect(scoreAuthor({ ...account, sign: "加微信" })).toMatchObject({ score: 62, level: "medium" });
    expect(scoreAuthor({ ...account, name: "刷单 稳赚 返利" }).score).toBe(62);
  }
});

test("缺失与非法数值不是低风险或小号证据；认证缺失不加分", () => {
  for (const fans of [undefined, -1, NaN, Infinity]) {
    expect(scoreAuthor({ fans, official_type: 2 })).toMatchObject({ level: "unknown", score: null });
    expect(scoreAuthor({ fans, sign: "加微信 稳赚" }).score).toBe(68);
  }
  expect(scoreAuthor({ fans: 1000 }).score).toBe(scoreAuthor({ fans: 1000, official_type: 0 }).score);
  expect(scoreAuthor({ fans: 1000, attention: -1, video_count: -1, total_views: -1 }).score).toBe(50);
});

test("历史仅提高预算，尤其历史 clean/low 不能降低 unknown 的默认覆盖", () => {
  for (const history_level of ["clean", "low", "unknown"] as const) {
    expect(scoreAuthor({ history_level }).level).toBe("unknown");
    expect(scoreAuthor({ fans: 1_000_000, history_level }).level).toBe("medium");
  }
  expect(scoreAuthor({ history_level: "high" })).toMatchObject({ level: "high", score: null });
  expect(scoreAuthor({ fans: 1_000_000, history_level: "high" })).toMatchObject({ level: "high", score: 50 });
  expect(raiseToHistory("high", "medium")).toBe("high");
  expect(raiseToHistory("low", "medium")).toBe("medium");
});

test("reasons 解释限幅、缺失及文本线索，不将预算分称为风险概率", () => {
  const result = scoreAuthor({ fans: 50, attention: 0, sign: "加微信" });
  for (const reason of ["非风险概率", "粉丝 <100", "零关注", "联系方式", "限幅后"]) {
    expect(result.reasons.some((r) => r.includes(reason))).toBe(true);
  }
});

test("最近作品标题词典只在规则路径计分：每条命中 +3、封顶 +6，标题线索也算文本线索", () => {
  const videos = [{ title: "加微信领取福利" }, { title: "私信领福利" }, { title: "普通日常" }];
  const result = scoreAuthor({ fans: 1000, recent_videos: videos });
  expect(result.score).toBe(56);
  expect(result.reasons.some((r) => r.includes("2 条标题含联系方式"))).toBe(true);
  const capped = scoreAuthor({ fans: 1000, recent_videos: Array.from({ length: 5 }, (_, i) => ({ title: `加微信 第${i}期` })) });
  expect(capped.score).toBe(56);
  const noFans = scoreAuthor({ recent_videos: [{ title: "加微信领取福利" }] });
  expect(noFans).toMatchObject({ score: 53, level: "medium" });
  expect(noFans.reasons.some((r) => r.includes("缺少粉丝数"))).toBe(true);
  expect(scoreAuthor({ fans: 1000, sign: "加微信", recent_videos: videos }).score).toBe(68);
});
