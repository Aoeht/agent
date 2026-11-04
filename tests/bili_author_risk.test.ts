// tests/bili_author_risk.test.ts
// 作者账号分：粉丝/认证/关注/关键词/投稿与播放的加减分、阈值分档、历史只向上覆盖
// 运行: bun test ./tests/bili_author_risk.test.ts
import { test, expect } from "bun:test";
import {
  AUTHOR_MAX_GRIDS,
  AUTHOR_RISK_THRESHOLDS,
  levelFromScore,
  raiseToHistory,
  scoreAuthor,
} from "../src/bili/author_risk";

test("阈值：70/50/30 为档位下界", () => {
  expect(AUTHOR_RISK_THRESHOLDS).toEqual({ high: 70, medium: 50, low: 30 });
  expect(levelFromScore(70)).toBe("high");
  expect(levelFromScore(69)).toBe("medium");
  expect(levelFromScore(50)).toBe("medium");
  expect(levelFromScore(49)).toBe("low");
  expect(levelFromScore(30)).toBe("low");
  expect(levelFromScore(29)).toBe("clean");
});

test("粉丝分档：基线 50 上的七段", () => {
  const score = (fans: number) => scoreAuthor({ fans, official_type: 3 }).score;
  expect(score(1_000_000)).toBe(25);
  expect(score(100_000)).toBe(32);
  expect(score(10_000)).toBe(40);
  expect(score(1000)).toBe(47);
  expect(score(100)).toBe(58);
  expect(score(10)).toBe(65);
  expect(score(9)).toBe(70);
});

test("认证：无 +3、个人 -5、机构 -10；未知类型不加不减", () => {
  expect(scoreAuthor({ fans: 1000 }).score).toBe(50);
  expect(scoreAuthor({ fans: 1000, official_type: 0 }).score).toBe(50);
  expect(scoreAuthor({ fans: 1000, official_type: 1 }).score).toBe(42);
  expect(scoreAuthor({ fans: 1000, official_type: 2 }).score).toBe(37);
  expect(scoreAuthor({ fans: 1000, official_type: 3 }).score).toBe(47);
});

test("关注结构：关注多粉丝少 +8、零关注小号 +4、粉丝/关注 >20 -3", () => {
  expect(scoreAuthor({ fans: 100, attention: 300 }).score).toBe(69);
  expect(scoreAuthor({ fans: 50, attention: 0 }).score).toBe(72);
  expect(scoreAuthor({ fans: 5000, attention: 100 }).score).toBe(47);
  // 关注略多于粉丝但不足 50，不触发 +8
  expect(scoreAuthor({ fans: 100, attention: 150 }).score).toBe(61);
});

test("昵称/签名关键词：联系方式 +12，套路词每个 +6 上限 +12", () => {
  expect(scoreAuthor({ fans: 1000, official_type: 0, sign: "加微信" }).score).toBe(62);
  expect(scoreAuthor({ fans: 1000, official_type: 0, sign: "刷单 稳赚 返利" }).score).toBe(62);
  expect(scoreAuthor({ fans: 1000, official_type: 0, sign: "加微信 刷单 稳赚" }).score).toBe(74);
  expect(scoreAuthor({ fans: 1000, official_type: 0, name: "加微信领资料" }).score).toBe(62);
});

test("投稿数/累计播放：新号、矩阵号、僵尸粉、大号背书", () => {
  expect(scoreAuthor({ fans: 150, official_type: 1, video_count: 2, total_views: 5000 })).toMatchObject({
    score: 56,
    level: "medium",
  });
  expect(scoreAuthor({ fans: 1000, official_type: 1, video_count: 200, total_views: 50_000 }).score).toBe(46);
  expect(scoreAuthor({ fans: 1000, official_type: 1, video_count: 10, total_views: 500 }).score).toBe(46);
  expect(scoreAuthor({ fans: 1000, official_type: 1, video_count: 100, total_views: 20_000_000 }).score).toBe(40);
  expect(scoreAuthor({ fans: 1000, official_type: 1, video_count: 100, total_views: 200_000_000 }).score).toBe(38);
  // 有播放的新号不按一次性小号处理
  expect(scoreAuthor({ fans: 150, official_type: 1, video_count: 2, total_views: 50_000 }).score).toBe(53);
});

test("缺粉丝数 → unknown；历史结论可把 unknown 抬上来", () => {
  expect(scoreAuthor({ sign: "加微信" })).toMatchObject({ level: "unknown", score: null });
  expect(scoreAuthor({ history_level: "high" })).toMatchObject({ level: "high", score: null });
  expect(scoreAuthor({ history_level: "unknown" }).level).toBe("unknown");
});

test("历史覆盖只向上，不向下", () => {
  const cleanAccount = { fans: 1_000_000, official_type: 2, total_views: 200_000_000 };
  expect(scoreAuthor(cleanAccount).level).toBe("clean");
  expect(scoreAuthor({ ...cleanAccount, history_level: "medium" })).toMatchObject({ level: "medium", score: 11 });
  expect(scoreAuthor({ ...cleanAccount, history_level: "clean" }).level).toBe("clean");
  expect(scoreAuthor({ fans: 1000, official_type: 0, history_level: "low" }).level).toBe("medium");

  expect(raiseToHistory("low", "medium")).toBe("medium");
  expect(raiseToHistory("high", "medium")).toBe("high");
  expect(raiseToHistory("unknown", "high")).toBe("high");
  expect(raiseToHistory("medium", "unknown")).toBe("medium");
});

test("预算：high 20 / medium 10 / low 5 / clean 3 / unknown 10", () => {
  expect(AUTHOR_MAX_GRIDS).toEqual({ high: 20, medium: 10, low: 5, clean: 3, unknown: 10 });
});

test("reasons 记录每一笔加减分，便于排查分档", () => {
  const result = scoreAuthor({ fans: 50, attention: 0, sign: "加微信" });
  expect(result.reasons.some((r) => r.includes("粉丝 <100"))).toBe(true);
  expect(result.reasons.some((r) => r.includes("零关注"))).toBe(true);
  expect(result.reasons.some((r) => r.includes("联系方式"))).toBe(true);
});
