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
  expect(w.end_s).toBe(10);
  expect(w.has_link).toBe(true);
  expect(w.danmaku_hits.map((h) => h.text)).toContain("加微信领福利");
  expect(w.transcript_hits[0]?.terms).toContain("粉丝群");
  expect(w.transcript_excerpt).toContain("粉丝群");
  const terms = result.keyword_totals.map((k) => k.term);
  expect(terms).toContain("加微信");
  expect(terms).toContain("粉丝群");
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
  expect(result.windows[0]!.danmaku_hits).toHaveLength(0);
});

test("无任何命中：空窗口但 keyword_totals 为空", () => {
  const result = localizeRisks([{ t: 3, text: "正常弹幕" }], [{ start_s: 0, end_s: 5, text: "正常内容" }]);
  expect(result.windows).toHaveLength(0);
  expect(result.keyword_totals).toHaveLength(0);
});
