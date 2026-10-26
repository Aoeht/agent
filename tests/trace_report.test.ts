import { describe, expect, test } from "bun:test";
import { assembleRuns, buildReport, isToolFailure, parseTraceLines, percentile, renderMarkdown } from "../benchmarks/trace_report";

const line = (event: object) => JSON.stringify(event);

/** 两个 step 上报缓存字段、两个不上报，用于验证命中率的分母只取覆盖子集。 */
function mixedCacheTrace(): string {
  return [
    line({ ts: "2026-10-01T00:00:00.000Z", type: "run_start", userMessage: "任务甲", promptHash: "aaaa11112222" }),
    // 覆盖：prompt 1000，其中缓存 800
    line({ ts: "2026-10-01T00:00:01.000Z", type: "step", step: { iteration: 1, tokens: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedPromptTokens: 800 }, toolCalls: [] } }),
    // 覆盖：prompt 1000，其中缓存 200
    line({ ts: "2026-10-01T00:00:02.000Z", type: "step", step: { iteration: 2, tokens: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedPromptTokens: 200 }, toolCalls: [] } }),
    // 未覆盖：prompt 8000，不上报 cachedPromptTokens。若被算进分母，命中率会从 50% 掉到 10%
    line({ ts: "2026-10-01T00:00:03.000Z", type: "step", step: { iteration: 3, tokens: { promptTokens: 8000, completionTokens: 50, totalTokens: 8050 }, toolCalls: [] } }),
    line({ ts: "2026-10-01T00:00:04.000Z", type: "step", step: { iteration: 4, tokens: { promptTokens: 8000, completionTokens: 50, totalTokens: 8050 }, toolCalls: [] } }),
    line({ ts: "2026-10-01T00:00:05.000Z", type: "run_end", success: true, totalTokens: 18250, toolCallsCount: 0, iterations: 4, stopReason: "answer" }),
  ].join("\n");
}

describe("trace 报告：解析与 run 装配", () => {
  test("坏行计入 badLines 且不中断解析", () => {
    const { events, badLines } = parseTraceLines(`${line({ type: "run_start" })}\n{不是 JSON}\n\n${line({ type: "run_end" })}\n`);
    expect(badLines).toBe(1);
    expect(events.length).toBe(2);
  });

  test("run_start 到 run_end 之间的 step 与 compact 归入同一个 run", () => {
    const text = [
      line({ ts: "2026-10-01T00:00:00.000Z", type: "run_start", userMessage: "任务甲", promptHash: "h1" }),
      line({ ts: "2026-10-01T00:00:01.000Z", type: "step", step: { iteration: 1, tokens: { promptTokens: 10, completionTokens: 1, totalTokens: 11 }, toolCalls: [] } }),
      line({ ts: "2026-10-01T00:00:02.000Z", type: "compact", action: "fold_summary", tokens: 500, detail: "折叠" }),
      line({ ts: "2026-10-01T00:00:03.000Z", type: "run_end", success: true, totalTokens: 11, toolCallsCount: 0, iterations: 1, stopReason: "answer" }),
    ].join("\n");
    const runs = assembleRuns("a.jsonl", parseTraceLines(text).events);
    expect(runs.length).toBe(1);
    expect(runs[0]!.hasStart).toBe(true);
    expect(runs[0]!.terminated).toBe(true);
    expect(runs[0]!.steps.length).toBe(1);
    expect(runs[0]!.compactions).toEqual([{ action: "fold_summary", tokens: 500, detail: "折叠" }]);
  });

  test("started 但未收尾计入中断信号；无 run_start 的孤儿组不计入", () => {
    const crashed = [
      line({ ts: "2026-10-01T00:00:00.000Z", type: "run_start", userMessage: "崩了", promptHash: "h1" }),
      line({ ts: "2026-10-01T00:00:01.000Z", type: "step", step: { iteration: 1, tokens: { promptTokens: 5, completionTokens: 1, totalTokens: 6 }, toolCalls: [] } }),
    ].join("\n");
    const orphan = [
      line({ ts: "2026-10-01T00:00:00.000Z", type: "step", step: { iteration: 1, tokens: { promptTokens: 5, completionTokens: 1, totalTokens: 6 }, toolCalls: [] } }),
    ].join("\n");

    const crashRuns = assembleRuns("crash.jsonl", parseTraceLines(crashed).events);
    expect(crashRuns.length).toBe(1);
    expect(crashRuns[0]!.hasStart).toBe(true);
    expect(crashRuns[0]!.terminated).toBe(false);

    const orphanRuns = assembleRuns("orphan.jsonl", parseTraceLines(orphan).events);
    expect(orphanRuns.length).toBe(1);
    expect(orphanRuns[0]!.hasStart).toBe(false);

    const report = buildReport(".traces", [
      { name: "crash.jsonl", text: crashed },
      { name: "orphan.jsonl", text: orphan },
    ], 1);
    expect(report.corpus.startedRuns).toBe(1);
    expect(report.corpus.startedButUnterminated).toBe(1);
    expect(report.corpus.orphanGroups).toBe(1);
    // 孤儿组虽然有 step，但绝不能被当成"崩溃"
    expect(report.corpus.terminatedRuns).toBe(0);
  });
});

describe("trace 报告：指标口径", () => {
  test("前缀缓存命中率的分母只取上报了 cachedPromptTokens 的 step", () => {
    const report = buildReport(".traces", [{ name: "a.jsonl", text: mixedCacheTrace() }], 1);
    const c = report.prefixCache;
    expect(c.totalSteps).toBe(4);
    expect(c.coveredSteps).toBe(2);
    expect(c.coverage).toBe(0.5);
    expect(c.coveredPromptTokens).toBe(2000);
    expect(c.coveredCachedTokens).toBe(1000);
    // 若错误地把全部 4 个 step 的 18000 prompt token 当分母，这里会得到 0.0556
    expect(c.hitRate).toBe(0.5);
  });

  test("没有任何 step 上报缓存字段时命中率为 null，不是 0", () => {
    const text = [
      line({ type: "run_start", userMessage: "x", promptHash: "h1" }),
      line({ type: "step", step: { iteration: 1, tokens: { promptTokens: 100, completionTokens: 10, totalTokens: 110 }, toolCalls: [] } }),
      line({ type: "run_end", success: true, totalTokens: 110, toolCallsCount: 0, iterations: 1 }),
    ].join("\n");
    const report = buildReport(".traces", [{ name: "a.jsonl", text }], 1);
    expect(report.prefixCache.hitRate).toBeNull();
    expect(report.prefixCache.coveredSteps).toBe(0);
  });

  test("工具失败只认 {\"error\":...} 形状；非 JSON 与正常结果都不计失败", () => {
    expect(isToolFailure('{"error":"boom"}')).toBe(true);
    expect(isToolFailure('{"content":"ok"}')).toBe(false);
    expect(isToolFailure("纯文本，不是 JSON")).toBe(false);
    expect(isToolFailure(undefined)).toBe(false);
    // 嵌套的 error 字段不算：只有顶层 error 才是 runTool 序列化的失败形状
    expect(isToolFailure('{"content":{"error":"内层"}}')).toBe(false);
  });

  test("工具错误率按调用数门槛过滤，避免小样本噪声上榜", () => {
    const call = (name: string, result: string) =>
      line({ type: "step", step: { iteration: 1, tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, toolCalls: [{ id: "c", name, arguments: "{}", result, resultPreview: result }] } });
    const text = [
      line({ type: "run_start", userMessage: "x", promptHash: "h1" }),
      call("flaky", '{"error":"boom"}'),
      call("stable", '{"content":"ok"}'),
      call("stable", '{"content":"ok"}'),
      call("stable", '{"content":"ok"}'),
      line({ type: "run_end", success: true, totalTokens: 8, toolCallsCount: 4, iterations: 1 }),
    ].join("\n");

    expect(buildReport(".traces", [{ name: "a.jsonl", text }], 1).tools.worst.map((t) => t.name)).toContain("flaky");
    // 门槛提到 2 后，只调用过 1 次的 flaky 不再进入榜单
    expect(buildReport(".traces", [{ name: "a.jsonl", text }], 2).tools.worst.map((t) => t.name)).not.toContain("flaky");
    // 但总体失败率仍然统计它，不因榜单门槛而丢数据
    expect(buildReport(".traces", [{ name: "a.jsonl", text }], 2).tools.failures).toBe(1);
  });

  test("promptHash 分组只统计正常收尾的 run，避免把崩溃 run 的成本记进某一版提示词", () => {
    const text = [
      line({ type: "run_start", userMessage: "甲", promptHash: "h1" }),
      line({ type: "run_end", success: true, totalTokens: 1000, toolCallsCount: 2, iterations: 2, stopReason: "answer" }),
      line({ type: "run_start", userMessage: "乙", promptHash: "h1" }),
      line({ type: "step", step: { iteration: 1, tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, toolCalls: [] } }),
      // 这个 run 没有 run_end
    ].join("\n");
    const report = buildReport(".traces", [{ name: "a.jsonl", text }], 1);
    expect(report.promptHashGroups.length).toBe(1);
    expect(report.promptHashGroups[0]!.runs).toBe(1);
    expect(report.promptHashGroups[0]!.avgTokens).toBe(1000);
    expect(report.corpus.runsWithPromptHash).toBe(2);
  });

  test("stopReason 分布的分母是正常收尾的 run，不是全部事件组", () => {
    const text = [
      line({ type: "run_start", userMessage: "甲", promptHash: "h1" }),
      line({ type: "run_end", success: true, totalTokens: 10, toolCallsCount: 0, iterations: 1, stopReason: "answer" }),
      line({ type: "run_start", userMessage: "乙", promptHash: "h1" }),
      line({ type: "run_end", success: false, totalTokens: 10, toolCallsCount: 0, iterations: 1, stopReason: "budget_exceeded" }),
    ].join("\n");
    const report = buildReport(".traces", [{ name: "a.jsonl", text }], 1);
    expect(report.stopReasons).toEqual([
      { reason: "answer", count: 1 },
      { reason: "budget_exceeded", count: 1 },
    ]);
    const md = renderMarkdown(report);
    expect(md).toContain("占 2 个正常收尾 run 的 100.0%");
  });

  test("percentile 在空样本、单样本与偶数长度上都不越界", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([5, 1, 3], 50)).toBe(3);
  });
});

describe("trace 报告：渲染", () => {
  test("报告显式披露 schema 覆盖与分母口径，不给出无样本的假精确结论", () => {
    const report = buildReport(".traces", [{ name: "a.jsonl", text: mixedCacheTrace() }], 1);
    const md = renderMarkdown(report);
    expect(md).toContain("# Agent 运行轨迹分析报告");
    expect(md).toContain("命中率（仅覆盖子集）");
    expect(md).toContain("50.00%");
    expect(md).toContain("孤儿事件组");
    expect(md).toContain("策略拒绝");
  });

  test("空语料渲染出「无可计算样本」而不是 0% 或 NaN", () => {
    const report = buildReport(".traces", [{ name: "empty.jsonl", text: "" }], 1);
    const md = renderMarkdown(report);
    expect(md).toContain("无可计算样本");
    expect(md).not.toContain("NaN");
    expect(report.corpus.events).toBe(0);
    expect(report.tokenCost.mean).toBe(0);
  });

  test("出现 summary_failed 时给出降级告警", () => {
    const text = [
      line({ type: "run_start", userMessage: "甲", promptHash: "h1" }),
      line({ type: "compact", action: "summary_failed", tokens: 0, detail: "摘要调用失败" }),
      line({ type: "run_end", success: true, totalTokens: 10, toolCallsCount: 0, iterations: 1 }),
    ].join("\n");
    expect(renderMarkdown(buildReport(".traces", [{ name: "a.jsonl", text }], 1))).toContain("summary_failed");
  });
});
