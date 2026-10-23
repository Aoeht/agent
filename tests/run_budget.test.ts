import { describe, expect, test } from "bun:test";
import { RunBudget } from "../src/core/run_budget";

describe("预算追加", () => {
  test("token 越线后追加一份原额度", () => {
    const budget = new RunBudget({ maxTotalTokens: 100 });
    budget.addTokens(120);
    expect(budget.check()).toBe("max_total_tokens");
    const next = budget.proposeExtension("max_total_tokens");
    expect(next.maxTotalTokens).toBe(220);
    budget.applyExtension(next);
    expect(budget.check()).toBeNull();
  });

  test("工具总次数越线后追加一份原额度", () => {
    const budget = new RunBudget({ maxToolCalls: 2 });
    budget.recordToolCall("a");
    budget.recordToolCall("b");
    expect(budget.check()).toBe("max_tool_calls");
    const next = budget.proposeExtension("max_tool_calls");
    expect(next.maxToolCalls).toBe(4);
    budget.applyExtension(next);
    expect(budget.check()).toBeNull();
  });

  test("单个工具次数上限翻倍", () => {
    const budget = new RunBudget({ maxToolCallsPerName: 3 });
    expect(budget.proposeExtension("max_tool_calls_per_name").maxToolCallsPerName).toBe(6);
  });

  test("墙钟按已用时长追加，而不是从开始时刻重新算", () => {
    let now = 0;
    const budget = new RunBudget({ maxWallClockMs: 1000 }, () => now);
    now = 1500;
    expect(budget.check()).toBe("max_wall_clock");
    const next = budget.proposeExtension("max_wall_clock");
    expect(next.maxWallClockMs).toBe(2500);
    budget.applyExtension(next);
    expect(budget.check()).toBeNull();
  });

  test("限额度缺失时也不会提出一个仍然越线的追加值", () => {
    const budget = new RunBudget({});
    budget.recordToolCall("a");
    expect(budget.proposeExtension("max_tool_calls").maxToolCalls!).toBeGreaterThan(budget.toolCalls);
  });
});
