// tests/bili_localize.test.ts
// 风险窗口粗定位：关键词/链接/密度打分、相邻与隔桶合并、topK 不重叠
// 运行: bun test ./tests/bili_localize.test.ts
import { test, expect } from "bun:test";
import { localizeRisks } from "../src/bili/localize";

test("关键词与链接命中的窗口粗定位", () => {
  const result = localizeRisks(
    [
      { t: 5, text: "加微信领福利" },
      { t: 15, text: "今天天气不错" },
    ],
    [{ start_s: 0, end_s: 30, text: "主页链接 example点com 加粉丝群" }],
  );
  expect(result.windows).toHaveLength(1);
  const w = result.windows[0]!;
  expect(w.start_s).toBe(0);
  expect(w.end_s).toBe(30);
  expect(w.has_link).toBe(true);
  expect(w.danmaku_hits.map((h) => h.text)).toContain("加微信领福利");
  expect(w.transcript_hits[0]?.terms).toContain("粉丝群");
  expect(w.transcript_excerpt).toContain("粉丝群");
  const terms = result.keyword_totals.map((k) => k.term);
  expect(terms).toContain("加微信");
  expect(terms).toContain("粉丝群");
});

test("长 ASR 覆盖完整区间，词频和链接权重不因分桶数膨胀", () => {
  for (const bucketS of [5, 10, 20]) {
    const result = localizeRisks([], [{ start_s: 0, end_s: 35, text: "加微信 https://example.com" }], { bucketS });
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.start_s).toBe(0);
    expect(result.windows[0]!.end_s).toBe(Math.ceil(35 / bucketS) * bucketS);
    expect(result.windows[0]!.score).toBeCloseTo(4, 10);
    expect(result.windows[0]!.has_link).toBe(true);
    expect(result.windows[0]!.transcript_hits).toHaveLength(1);
    expect(result.keyword_totals.find((hit) => hit.term === "加微信")!.count).toBe(1);
  }
});

test("跨桶窄区间与整桶边界采用半开区间，非法时间不参与定位", () => {
  expect(localizeRisks([], [{ start_s: 9, end_s: 11, text: "贷款" }]).windows[0])
    .toMatchObject({ start_s: 0, end_s: 20, score: 3 });
  expect(localizeRisks([], [{ start_s: 10, end_s: 20, text: "贷款" }]).windows[0])
    .toMatchObject({ start_s: 10, end_s: 20, score: 3 });
  expect(localizeRisks([], [
    { start_s: -1, end_s: 5, text: "贷款" }, { start_s: 5, end_s: 5, text: "贷款" },
    { start_s: 8, end_s: 2, text: "贷款" }, { start_s: 0, end_s: Infinity, text: "贷款" },
  ]).windows).toEqual([]);
  expect(() => localizeRisks([], [], { bucketS: 0 })).toThrow();
});

test("同桶 ASR 与弹幕独立计分和限流，原始词频完整保留", () => {
  const result = localizeRisks([{ t: 1, text: "贷款贷款贷款" }], [{ start_s: 1, end_s: 9, text: "贷款贷款" }]);
  expect(result.windows[0]!.score).toBe(15);
  expect(result.windows[0]!.score_breakdown).toEqual({ transcript: 6, danmaku: 9, density: 0 });
  expect(result.keyword_totals[0]!.count).toBe(5);
});

test("弹幕刷屏不能挤掉 ASR 分数，ASR 重复不能突破自身上限", () => {
  const transcript = [{ start_s: 1, end_s: 9, text: "贷款贷款" }];
  const spam = [{ t: 1, text: "贷款".repeat(100) }];
  const solo = localizeRisks([], transcript).windows[0]!;
  const mixed = localizeRisks(spam, transcript).windows[0]!;
  expect(mixed.score_breakdown.transcript).toBe(solo.score_breakdown.transcript);
  expect(mixed.score_breakdown.danmaku).toBe(9);
  const repeated = localizeRisks(spam, Array.from({ length: 100 }, () => transcript[0]!)).windows[0]!;
  expect(repeated.score_breakdown).toEqual({ transcript: 9, danmaku: 9, density: 0 });
});

test("链接分按来源保留，长字幕分摊及合并窗口的分项总和可核对", () => {
  const mixed = localizeRisks([{ t: 5, text: "https://example.com" }], [
    { start_s: 0, end_s: 35, text: "https://example.com" },
  ]).windows[0]!;
  expect(mixed.score_breakdown.transcript).toBeCloseTo(2);
  expect(mixed.score_breakdown.danmaku).toBe(2);
  expect(mixed.score_breakdown.density).toBe(0);
  expect(mixed.score).toBeCloseTo(4);
  const merged = localizeRisks([{ t: 21, text: "加微信" }], [{ start_s: 0, end_s: 10, text: "贷款" }]).windows[0]!;
  expect(merged).toMatchObject({ start_s: 0, end_s: 30, score: 5,
    score_breakdown: { transcript: 3, danmaku: 2, density: 0 } });
});

test("相邻命中与隔一桶的命中都合并进同一窗口", () => {
  const result = localizeRisks(
    [
      { t: 1, text: "加微信" },       // 桶 0
      { t: 21, text: "加qq" },        // 桶 2（隔 1 桶）
      { t: 301, text: "扫码领奖" },   // 桶 30（远处独立窗口）
    ],
    [],
  );
  expect(result.windows).toHaveLength(2);
  expect(result.windows[0]).toMatchObject({ start_s: 0, end_s: 30 });
  expect(result.windows[1]).toMatchObject({ start_s: 300, end_s: 310 });
});

test("topK 上限且窗口互不重叠", () => {
  const danmaku = Array.from({ length: 8 }, (_, i) => ({ t: i * 100 + 1, text: "加微信" }));
  const result = localizeRisks(danmaku, [], { topK: 6 });
  expect(result.windows).toHaveLength(6);
  const sorted = result.windows.slice().sort((a, b) => a.start_s - b.start_s);
  for (let i = 1; i < sorted.length; i += 1) {
    expect(sorted[i]!.start_s).toBeGreaterThanOrEqual(sorted[i - 1]!.end_s);
  }
});

test("弹幕密度突增单独成窗（无关键词也值得看）", () => {
  const danmaku = [
    ...Array.from({ length: 40 }, (_, i) => ({ t: i * 0.02, text: "哈哈哈哈哈" })),
    ...Array.from({ length: 60 }, (_, i) => ({ t: 100 + i, text: "哈哈" })),
  ];
  const result = localizeRisks(danmaku, []);
  expect(result.windows).toHaveLength(1);
  expect(result.windows[0]!.score).toBe(2); // 只有密度加分
  expect(result.windows[0]!.score_breakdown).toEqual({ transcript: 0, danmaku: 0, density: 2 });
  expect(result.windows[0]!.danmaku_hits).toHaveLength(0);
});

test("无任何命中：空窗口但 keyword_totals 为空", () => {
  const result = localizeRisks([{ t: 3, text: "正常弹幕" }], [{ start_s: 0, end_s: 5, text: "正常内容" }]);
  expect(result.windows).toHaveLength(0);
  expect(result.keyword_totals).toHaveLength(0);
});
