import { describe, expect, test } from "bun:test";
import { runRecallEval, scoreCase } from "../benchmarks/memory_recall_eval";
import type { RecallFixtureCase } from "../benchmarks/memory_recall/fixtures";

describe("记忆召回评测", () => {
  test("评分检查实际证据、来源、多个事实和负例，不因会话命中就给分", () => {
    const fixture: RecallFixtureCase = { id: "scoring", category: "test", query: "test", expected: [
      { sessionId: "a", alternativeSessionIds: ["copy-a"], evidence: "事实甲" }, { sessionId: "b", evidence: "事实乙" },
    ] };
    const result = scoreCase(fixture, [
      { sessionId: "a", summary: "截断开头，没有证据" },
      { sessionId: "copy-a", summary: "事实甲" },
      { sessionId: "wrong", summary: "事实乙" },
      { sessionId: "b", summary: "事实乙" },
    ], 3);
    expect(result.recallAtK).toBe(0.5);
    expect(result.reciprocalRank).toBe(0.5);
    expect(result.precisionAtK).toBe(1 / 3);
    expect(scoreCase({ ...fixture, expected: [] }, [{ sessionId: "a", summary: "多余记忆" }], 3).falsePositive).toBe(true);
    expect(scoreCase({ ...fixture, expected: [] }, [], 3).falsePositive).toBe(false);
  });

  test("固定合成集：混合检索补足长摘要、编号与同义改写，负例不误召回，热缓存零调用", async () => {
    const report = await runRecallEval();
    expect(report.mode).toBe("mock");
    const hybrid = report.results.find(result => result.variant === "chunk-hybrid")!;
    const keyword = report.results.find(result => result.variant === "chunk-keyword")!;
    const vector = report.results.find(result => result.variant === "chunk-vector")!;
    const legacy = report.results.find(result => result.variant === "legacy-vector")!;
    expect(hybrid.recallAtK).toBe(1);
    expect(hybrid.negativeFalsePositiveRate).toBe(0);
    expect(hybrid.cases.find(row => row.id === "tail-id")!.recallAtK).toBe(1);
    expect(legacy.cases.find(row => row.id === "tail-id")!.recallAtK).toBe(0);
    expect(vector.cases.find(row => row.id === "exact-ticket")!.recallAtK).toBe(0);
    expect(keyword.cases.find(row => row.id === "paraphrase-backup")!.recallAtK).toBe(0);
    expect(hybrid.cases.find(row => row.id === "two-sections")!.recallAtK).toBe(1);
    expect(hybrid.cases.find(row => row.id === "exclude-current")!.hits.some(hit => hit.sessionId === "current")).toBe(false);
    expect(keyword.embeddingTexts).toBe(0);
    expect(report.results.every(result => result.warmEmbeddingTexts === 0)).toBe(true);
  });
});
