import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import type { AgentStack } from "../src/bootstrap";
import { loadAgentConfig } from "../src/config";
import { AgentScheduler, TeamTokenBudget, validateTeamPlan, type ChildFactory, type ChildExecution,
  type ChildRecord, type TeamTask } from "../src/core/team_scheduler";
import { TeamCoordinator, type TeamEvent } from "../src/core/team_coordinator";
import { createTeamChildFactory, createTeamRegistry, loadTeamOptions } from "../src/team_runtime";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { runOutcome, type StopReason } from "../src/core/run_outcome";
import type { AgentResult } from "../src/core/types";
import type { Submission, TeamReview } from "../src/core/team_contracts";

const task = (id: string, dependsOn: string[] = []): TeamTask => ({ id, role: "analyst", goal: `分析 ${id}`, dependsOn,
  deliverables: ["分析结论"], checks: [{ id: "c1", description: "有证据支持结论" }] });
const submission = (summary: string): Submission => ({ summary, deliverables: [{ index: 0, content: summary }],
  findings: [{ id: "f1", claim: summary, evidenceIds: ["e1"] }],
  evidence: [{ id: "e1", source: "src/example.ts:1", excerpt: "source" }],
  coverage: [{ checkId: "c1", status: "covered", findingIds: ["f1"], note: "已核对" }], unresolved: [] });
const review = (tasks: TeamTask[]): TeamReview => ({ summary: "逐项核对完成", checks: tasks.flatMap(task => task.checks.map(check => ({
  taskId: task.id, checkId: check.id, verdict: "pass" as const, rationale: "已核对原始来源", followUp: "",
  evidenceRefs: [{ taskId: task.id, evidenceId: "e1" }],
}))) });
const result = (answer: string, tokens = 10, reason: StopReason = "answer"): AgentResult => ({
  ...runOutcome(reason), finalAnswer: JSON.stringify(submission(answer || "未完成")), totalTokens: tokens, toolCallsCount: 0,
  messages: [], steps: [], citations: [],
});
const rawResult = (finalAnswer: string, tokens = 10): AgentResult => ({
  ...runOutcome("answer"), finalAnswer, totalTokens: tokens, toolCallsCount: 0,
  messages: [], steps: [], citations: [],
});
const schedulerOptions = { concurrency: 2, maxTasks: 6, childTokens: 100, childToolCalls: 5 };
const signal = () => new AbortController().signal;
async function until(predicate: () => boolean) {
  for (let n = 0; n < 1000; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("等待调度事件超时");
}
const reply = (content: string, finish_reason = "stop", usage: object | undefined = { total_tokens: 10 }) => ({
  choices: [{ finish_reason, message: { content } }], ...(usage ? { usage } : {}),
});
function clientWith(fn: (request: any, options: any) => Promise<any>): OpenAI {
  return { chat: { completions: { create: fn } } } as unknown as OpenAI;
}
const instant: ChildFactory = execution => ({ run: async () => execution.mode === "review"
  ? { ...result("review"), finalAnswer: JSON.stringify(review(execution.reviewTargets.map(target => target.task))) }
  : result(execution.task.id), shutdown: async () => {} });

describe("团队计划与运行时调度", () => {
  test("完整校验 DAG：重复 ID、缺失依赖、自依赖、循环、越权字段、超量任务均拒绝", () => {
    for (const tasks of [[task("a"), task("a")], [task("a", ["missing"])], [task("a", ["a"])],
      [task("a", ["b"]), task("b", ["a"])], [task("a", ["b", "b"]), task("b")],
      [{ ...task("a"), tools: ["run_script"] }], Array.from({ length: 7 }, (_, i) => task(`a${i}`))]) {
      expect(() => validateTeamPlan({ tasks })).toThrow();
    }
    expect(validateTeamPlan({ tasks: [task("b", ["a"]), task("a")] }).tasks).toHaveLength(2);
  });

  test("无效计划不会创建子 Agent", async () => {
    let created = 0;
    const scheduler = new AgentScheduler(schedulerOptions, execution => { created++; return instant(execution); });
    await expect(scheduler.run({ parentRunId: "root", userGoal: "test", plan: { tasks: [task("a", ["a"])] },
      budget: new TeamTokenBudget(1000), signal: signal() })).rejects.toThrow("循环");
    expect(created).toBe(0);
  });

  test("按依赖解锁并及时复用并发槽位，只传直接依赖结果", async () => {
    const started: ChildExecution[] = [];
    const finishes = new Map<string, (value: AgentResult) => void>();
    let active = 0, peak = 0, closed = 0;
    const scheduler = new AgentScheduler(schedulerOptions, execution => {
      started.push(execution);
      active++; peak = Math.max(peak, active);
      return { run: () => new Promise(resolve => finishes.set(execution.task.id, resolve)),
        shutdown: async () => { active--; closed++; } };
    });
    const budget = new TeamTokenBudget(1000);
    const pending = scheduler.run({ parentRunId: "root", userGoal: "goal",
      plan: { tasks: [task("a"), task("b"), task("c", ["a"]), task("d", ["b", "c"])] }, budget, signal: signal() });
    await until(() => started.length === 2);
    finishes.get("a")!(result("A result"));
    await until(() => started.length === 3);
    expect(started[2]!.task.id).toBe("c"); // b still running: no wave barrier.
    expect(started[2]!.dependencies.map(dep => dep.task.id)).toEqual(["a"]);
    expect(started[2]!.dependencies[0]!.result!.submission!.summary).toBe("A result");
    finishes.get("c")!(result("C result"));
    finishes.get("b")!(result("B result"));
    await until(() => started.length === 4);
    finishes.get("d")!(result("D result"));
    const records = await pending;
    expect(peak).toBe(2);
    expect(closed).toBe(4);
    expect(records.every(record => record.state === "answered")).toBe(true);
    expect(records.every(record => record.parentRunId === "root")).toBe(true);
    expect(budget.used).toBe(40);
    expect(budget.available).toBe(960);
    expect(Object.keys(started[0]!.runtime)).toEqual(["signal"]);
  });

  test("失败只阻断下游，保留失败原因，其他分支继续", async () => {
    const created: string[] = [];
    const scheduler = new AgentScheduler(schedulerOptions, execution => {
      created.push(execution.task.id);
      return { run: async () => {
        if (execution.task.id === "bad") throw new Error("network failed");
        return result("done");
      }, shutdown: async () => {} };
    });
    const records = await scheduler.run({ parentRunId: "root", userGoal: "test",
      plan: { tasks: [task("bad"), task("dependent", ["bad"]), task("independent")] },
      budget: new TeamTokenBudget(1000), signal: signal() });
    expect(created).toEqual(["bad", "independent"]);
    expect(records.map(record => record.state)).toEqual(["failed", "skipped", "answered"]);
    expect(records[0]!.reason).toBe("network failed");
  });

  test("预算先预留再结算，运行中的额度不可重复分配，剩余不足则跳过", async () => {
    const started: string[] = [];
    const scheduler = new AgentScheduler(schedulerOptions, execution => {
      started.push(execution.task.id);
      return { run: async () => result("done", 80), shutdown: async () => {} };
    });
    const budget = new TeamTokenBudget(150);
    const records = await scheduler.run({ parentRunId: "root", userGoal: "test",
      plan: { tasks: [task("a"), task("b")] }, budget, signal: signal() });
    expect(started).toEqual(["a"]);
    expect(records[1]!.state).toBe("skipped");
    expect(records[1]!.reason).toContain("预算");
    expect(budget.available).toBe(70);
  });

  test("取消传播到所有活动任务，等待清理完成，未启动的任务不再创建", async () => {
    const controller = new AbortController();
    let created = 0, closed = 0;
    const scheduler = new AgentScheduler(schedulerOptions, execution => {
      created++;
      return { run: () => new Promise(resolve => execution.runtime.signal!.addEventListener("abort",
        () => resolve(result("", 5, "cancelled")), { once: true })),
      shutdown: async () => { await Promise.resolve(); closed++; } };
    });
    const pending = scheduler.run({ parentRunId: "root", userGoal: "test",
      plan: { tasks: [task("a"), task("b"), task("c")] }, budget: new TeamTokenBudget(1000), signal: controller.signal });
    await until(() => created === 2);
    controller.abort();
    expect((await pending).map(record => record.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(created).toBe(2);
    expect(closed).toBe(2);
  });

  test("拒绝、截断、未完成计划均不能解锁下游", async () => {
    for (const reason of ["model_refusal", "output_truncated", "plan_incomplete"] as const) {
      const scheduler = new AgentScheduler(schedulerOptions, () => ({
        run: async () => result("partial", 10, reason), shutdown: async () => {},
      }));
      const records = await scheduler.run({ parentRunId: "root", userGoal: "test",
        plan: { tasks: [task("a"), task("b", ["a"])] }, budget: new TeamTokenBudget(1000), signal: signal() });
      expect(records.map(record => record.state)).toEqual(["failed", "skipped"]);
    }
  });

  test("结构化输出不合法时安排一次格式修复；修复成功保留结算、引用与下游", async () => {
    const repairs: ChildExecution[] = [];
    let closed = 0;
    const scheduler = new AgentScheduler(schedulerOptions, execution => {
      if (execution.repair) {
        repairs.push(execution);
        return { run: async () => result(`repaired-${execution.task.id}`), shutdown: async () => { closed++; } };
      }
      return { run: async () => rawResult("```json\n" + JSON.stringify({ summary: "只有摘要" }) + "\n```"),
        shutdown: async () => { closed++; } };
    });
    const budget = new TeamTokenBudget(1000);
    const records = await scheduler.run({ parentRunId: "root", userGoal: "test",
      plan: { tasks: [task("a"), task("b", ["a"])] }, budget, signal: signal() });
    expect(records.map(record => record.state)).toEqual(["answered", "answered"]);
    expect(records[0]!.reason).toContain("修复");
    expect(records[0]!.result!.finalAnswer).toContain("repaired-a");
    expect(records[0]!.result!.submission!.summary).toBe("repaired-a");
    expect(records[0]!.result!.totalTokens).toBe(20); // 原运行 + 修复运行
    expect(budget.used).toBe(40);
    expect(closed).toBe(4);
    expect(repairs.map(execution => execution.task.id)).toEqual(["a", "b"]);
    expect(repairs[0]!.repair!.previousAnswer).toContain("只有摘要");
    expect(repairs[0]!.repair!.validationError).toBeTruthy();
    expect(repairs[0]!.dependencies.map(dep => dep.task.id)).toEqual([]); // 修复沿用原执行上下文
  });

  test("修复仍不合法才判 failed，下游跳过并保留原始回答供复盘", async () => {
    const scheduler = new AgentScheduler(schedulerOptions, execution => ({
      run: async () => rawResult(execution.repair ? "还是不合法" : JSON.stringify({ summary: "缺少交付" })),
      shutdown: async () => {},
    }));
    const records = await scheduler.run({ parentRunId: "root", userGoal: "test",
      plan: { tasks: [task("a"), task("b", ["a"])] }, budget: new TeamTokenBudget(1000), signal: signal() });
    expect(records.map(record => record.state)).toEqual(["failed", "skipped"]);
    expect(records[0]!.reason).toContain("结构化结果无效");
    expect(records[0]!.reason).toContain("格式修复未成功");
    expect(records[0]!.result!.finalAnswer).toContain("缺少交付");
  });

  test("复核输出不合法同样先走一次修复", async () => {
    const target: ChildRecord = { parentRunId: "root", task: task("a"), state: "answered", round: 0, mode: "work",
      result: { ...result("A result"), submission: submission("A result") } };
    const repairs: ChildExecution[] = [];
    const scheduler = new AgentScheduler(schedulerOptions, execution => {
      if (execution.repair) {
        repairs.push(execution);
        return { run: async () => rawResult(JSON.stringify(review([task("a")]))), shutdown: async () => {} };
      }
      return { run: async () => rawResult("{ broken"), shutdown: async () => {} };
    });
    const records = await scheduler.run({ parentRunId: "root", userGoal: "test", mode: "review",
      plan: { tasks: [{ id: "team-review", role: "reviewer", goal: "复核", dependsOn: [],
        deliverables: ["复核报告"], checks: [{ id: "review", description: "覆盖全部检查项" }] }] },
      context: [target], budget: new TeamTokenBudget(1000), signal: signal() });
    expect(records[0]!.state).toBe("answered");
    expect(records[0]!.result!.review!.checks[0]!.verdict).toBe("pass");
    expect(repairs[0]!.mode).toBe("review");
    expect(repairs[0]!.reviewTargets.map(record => record.task.id)).toEqual(["a"]);
  });
});

describe("协调模型协议", () => {
  test("规划和汇总均不传 tools，完整流程聚合成本并保留来源边界", async () => {
    const requests: any[] = [];
    const events: TeamEvent[] = [];
    const client = clientWith(async request => {
      requests.push(request);
      expect(request.tools).toBeUndefined();
      return request.response_format ? reply(JSON.stringify({ tasks: [task("a"), task("b", ["a"])] })) : reply("最终结论");
    });
    const coordinator = new TeamCoordinator({ model: "test", client, createChild: instant, capabilities: "只读",
      onEvent: event => events.push(event) });
    const report = await coordinator.run("分析项目", { runId: "parent" });
    expect(report.status).toBe("answered");
    expect(report.totalTokens).toBe(50);
    expect(report.finalAnswer).toBe("最终结论");
    expect(requests[1].messages[1].content).toContain("<UNTRUSTED_MCP_DATA>");
    expect(events.map(event => event.type)).toEqual([
      "team_start", "team_plan", "team_task", "team_task", "team_task", "team_task",
      "team_task", "team_task", "team_review", "team_summary", "team_end",
    ]);
  });

  test("规划格式不合法重试一次，仍不合法则失败且不启动子任务", async () => {
    let created = 0, calls = 0;
    const report = await new TeamCoordinator({ model: "test", capabilities: "只读",
      client: clientWith(async () => { calls++; return reply("invalid JSON"); }),
      createChild: execution => { created++; return instant(execution); },
    }).run("test");
    expect(report.status).toBe("failed");
    expect(created).toBe(0);
    expect(calls).toBe(2);
    expect(report.totalTokens).toBe(20);
  });

  test("规划输出被截断不做重试，直接失败", async () => {
    let calls = 0;
    const report = await new TeamCoordinator({ model: "test", capabilities: "只读", createChild: instant,
      client: clientWith(async () => { calls++; return reply(JSON.stringify({ tasks: [task("a")] }), "length"); }),
    }).run("test");
    expect(report.status).toBe("failed");
    expect(calls).toBe(1);
    expect(report.totalTokens).toBe(10);
  });

  test("规划格式不合法时带校验错误重试，重试成功则继续执行", async () => {
    const planRequests: any[] = [];
    let planCalls = 0;
    const client = clientWith(async request => {
      if (!request.response_format) return reply("最终结论");
      planCalls++;
      planRequests.push(request);
      return planCalls === 1 ? reply("我想想，这个目标……") : reply(JSON.stringify({ tasks: [task("a")] }));
    });
    const report = await new TeamCoordinator({ model: "test", client, createChild: instant, capabilities: "只读" })
      .run("test");
    expect(report.status).toBe("answered");
    expect(planCalls).toBe(2);
    expect(planRequests[1]!.messages[1]!.content).toContain("校验错误");
    expect(planRequests[1]!.messages[1]!.content).toContain("我想想");
    expect(report.totalTokens).toBe(50); // 规划 2 次 + 工作 + 复核 + 汇总
  });

  test("预算不足时规划不做重试，保留原始格式错误", async () => {
    const report = await new TeamCoordinator({ model: "test", capabilities: "只读", createChild: instant,
      client: clientWith(async request => request.response_format ? reply("不是 JSON") : reply("汇总")),
      options: { totalTokens: 36_002, childTokens: 1, coordinationTokens: 18_000 },
    }).run("test");
    expect(report.status).toBe("failed");
    expect(report.error).not.toContain("预算");
  });

  test("汇总传输错误按退避重试，成功后不降级结果", async () => {
    let summaryCalls = 0;
    const client = clientWith(async request => {
      if (request.response_format) return reply(JSON.stringify({ tasks: [task("a")] }));
      summaryCalls++;
      if (summaryCalls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return reply("最终结论");
    });
    const report = await new TeamCoordinator({ model: "test", client, createChild: instant, capabilities: "只读",
      options: { retryBaseDelayMs: 0 } }).run("test");
    expect(report.status).toBe("answered");
    expect(report.finalAnswer).toBe("最终结论");
    expect(summaryCalls).toBe(2);
  });

  test("传输重试最多 3 次尝试，耗尽后仍明确失败并保守计费", async () => {
    let summaryCalls = 0;
    const client = clientWith(async request => {
      if (request.response_format) return reply(JSON.stringify({ tasks: [task("a")] }));
      summaryCalls++;
      throw Object.assign(new Error("server exploded"), { status: 500 });
    });
    const report = await new TeamCoordinator({ model: "test", client, createChild: instant, capabilities: "只读",
      options: { retryBaseDelayMs: 0 } }).run("test");
    expect(report.status).toBe("incomplete");
    expect(summaryCalls).toBe(3);
    expect(report.finalAnswer).toContain("server exploded");
    expect(report.coordinationUsageEstimated).toBe(true);
    expect(report.totalTokens).toBe(18_030); // 3 次尝试费用不可知，汇总按预留 18000 保守结算
  });

  test("汇总输入用紧凑投影：保留结论/交付/未解决项/来源定位，不复述 findings、证据片段与复核论证", async () => {
    let summaryInput = "";
    const dense: Submission = { summary: "SUMMARY-标记", deliverables: [{ index: 0, content: "DELIVERABLE-标记" }],
      findings: [{ id: "f1", claim: "FINDING-标记", evidenceIds: ["e1"] }],
      evidence: [{ id: "e1", source: "SRC-标记.ts:1", excerpt: "EXCERPT-标记" }],
      coverage: [{ checkId: "c1", status: "covered", findingIds: ["f1"], note: "COVERED-标记" }], unresolved: ["UNRESOLVED-标记"] };
    const createChild: ChildFactory = execution => ({
      run: async () => rawResult(execution.mode === "review"
        ? JSON.stringify(review(execution.reviewTargets.map(target => target.task)))
        : JSON.stringify(dense)),
      shutdown: async () => {},
    });
    const client = clientWith(async request => {
      if (request.response_format) return reply(JSON.stringify({ tasks: [task("a")] }));
      summaryInput = request.messages[1].content;
      return reply("汇总完成");
    });
    const report = await new TeamCoordinator({ model: "test", client, createChild, capabilities: "只读" }).run("test");
    // 带 unresolved 项的任务按设计不能复核通过，但仍应走到汇总
    expect(report.status).toBe("incomplete");
    expect(report.error).toContain("轮数");
    for (const kept of ["SUMMARY-标记", "DELIVERABLE-标记", "SRC-标记.ts:1", "UNRESOLVED-标记", "passedCount"]) {
      expect(summaryInput).toContain(kept);
    }
    for (const dropped of ["FINDING-标记", "EXCERPT-标记", "COVERED-标记", '"findings"', '"coverage"', '"evidenceRefs"', '"rationale"']) {
      expect(summaryInput).not.toContain(dropped);
    }
  });

  test("汇总投影逐级收紧直至装进协调预留，截断如实标注", async () => {
    const bulk = Array.from({ length: 12000 }, (_, i) => "字一二三四五六七八九十"[i % 10]).join("");
    const wide = { ...task("a"), deliverables: ["一", "二", "三", "四", "五", "六"] };
    const dense: Submission = { summary: bulk.slice(0, 2000),
      deliverables: wide.deliverables.map((_, index) => ({ index, content: bulk.slice(index * 200, index * 200 + 1200) })),
      findings: [{ id: "f1", claim: "CLAIM", evidenceIds: ["e1"] }],
      evidence: [{ id: "e1", source: bulk.slice(0, 1000), excerpt: "EXCERPT" }],
      coverage: [{ checkId: "c1", status: "covered", findingIds: ["f1"], note: "已覆盖" }],
      unresolved: [] };
    let summaryInput = "";
    const createChild: ChildFactory = execution => ({
      run: async () => rawResult(execution.mode === "review"
        ? JSON.stringify(review(execution.reviewTargets.map(target => target.task)))
        : JSON.stringify(dense)),
      shutdown: async () => {},
    });
    const client = clientWith(async request => {
      if (request.response_format) return reply(JSON.stringify({ tasks: [wide] }));
      summaryInput = request.messages[1].content;
      return reply("汇总完成");
    });
    const report = await new TeamCoordinator({ model: "test", client, createChild, capabilities: "只读",
      options: { totalTokens: 8_200, childTokens: 50, coordinationTokens: 4_000 } }).run("test");
    expect(report.status).toBe("answered"); // 不再因协调预留不足而整体失败
    expect(report.reviewStatus).toBe("passed");
    expect(summaryInput).toContain("…(截断)"); // 被裁内容如实标注
    expect(summaryInput).not.toContain("EXCERPT"); // 紧凑投影连降两级后不再含证据片段
    expect(summaryInput.length).toBeLessThan(6_000);
  });

  test("复核在汇总中压成结论与未通过项，通过项论证与 evidenceRefs 不复述", async () => {
    const tasks = [task("a"), task("b")];
    const compact: TeamReview = { summary: "REVIEW-SUMMARY-标记", checks: [
      { taskId: "a", checkId: "c1", verdict: "pass", rationale: "PASS-论证标记",
        evidenceRefs: [{ taskId: "a", evidenceId: "e1" }], followUp: "" },
      { taskId: "b", checkId: "c1", verdict: "blocked", rationale: "BLOCKED-理由标记",
        evidenceRefs: [], followUp: "需要用户提供材料" },
    ] };
    let summaryInput = "";
    const createChild: ChildFactory = execution => ({
      run: async () => rawResult(execution.mode === "review"
        ? JSON.stringify(compact) : JSON.stringify(submission(execution.task.id))),
      shutdown: async () => {},
    });
    const client = clientWith(async request => {
      if (request.response_format) return reply(JSON.stringify({ tasks }));
      summaryInput = request.messages[1].content;
      return reply("汇总完成");
    });
    const report = await new TeamCoordinator({ model: "test", client, createChild, capabilities: "只读" }).run("test");
    expect(report.status).toBe("incomplete"); // blocked 不重跑
    expect(report.reviewStatus).toBe("blocked");
    expect(summaryInput).toContain("REVIEW-SUMMARY-标记");
    expect(summaryInput).toContain('"passedCount":1');
    expect(summaryInput).toContain("需要用户提供材料");
    expect(summaryInput).toContain("有证据支持结论"); // 未通过项带原始检查项说明
    for (const dropped of ["PASS-论证标记", "BLOCKED-理由标记", "evidenceRefs"]) {
      expect(summaryInput).not.toContain(dropped);
    }
  });

  test("汇总失败保留子任务结论；部分失败不会被汇总文本变成成功", async () => {
    let calls = 0;
    const report = await new TeamCoordinator({ model: "test", capabilities: "只读", createChild: instant,
      client: clientWith(async () => {
        if (++calls === 1) return reply(JSON.stringify({ tasks: [task("a")] }));
        throw new Error("summary unavailable");
      }),
    }).run("test");
    expect(report.status).toBe("incomplete");
    expect(report.finalAnswer).toContain("a");
    expect(report.tasks[0]!.state).toBe("answered");
    const partial = await new TeamCoordinator({ model: "test", capabilities: "只读",
      createChild: () => ({ run: async () => result("拒绝", 10, "model_refusal"), shutdown: async () => {} }),
      client: clientWith(async request => request.response_format
        ? reply(JSON.stringify({ tasks: [task("a")] })) : reply("所有任务成功！")),
    }).run("test");
    expect(partial.status).toBe("incomplete");
  });

  test("预取消不调用模型；超时取消模型请求并输出记录", async () => {
    const controller = new AbortController(); controller.abort();
    let called = false;
    const coordinator = new TeamCoordinator({ model: "test", capabilities: "只读", createChild: instant,
      client: clientWith(async () => { called = true; return reply("{}"); }) });
    expect((await coordinator.run("test", { signal: controller.signal })).status).toBe("cancelled");
    expect(called).toBe(false);
    const timed = await new TeamCoordinator({ model: "test", capabilities: "只读", createChild: instant,
      options: { timeoutMs: 10 }, client: clientWith(async (_request, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })),
    }).run("test");
    expect(timed.status).toBe("incomplete");
    expect(timed.error).toBe("团队运行超时");
  });
});

describe("真实 Agent 接入", () => {
  test("工具白名单和计划仓独立，模型不能获得写文件、脚本或派发权限", async () => {
    const source = new ToolRegistry();
    for (const name of ["filesystem__read_text_file", "filesystem__write_file", "run_script", "spawn_agent", "other__read"]) {
      source.register({ name, description: "test", execute: async () => "ok", parallelSafe: true });
    }
    const a = new PlanStore(), b = new PlanStore();
    const ar = createTeamRegistry(source, a), br = createTeamRegistry(source, b);
    expect(ar.list().map(tool => tool.name)).toEqual(["filesystem__read_text_file", "update_plan", "read_task_state"]);
    expect(createTeamRegistry(source, new PlanStore(), false).list().map(tool => tool.name))
      .toEqual(["update_plan", "read_task_state"]); // 格式修复运行没有任何检索工具
    await ar.execute("update_plan", { steps: [{ content: "A plan", status: "pending" }] });
    expect(a.getSteps()).toHaveLength(1);
    expect(b.getSteps()).toHaveLength(0);
    ar.unregister("filesystem__read_text_file");
    expect(br.has("filesystem__read_text_file")).toBe(true);
  });

  test("真实 ReAct 子 Agent 读工具、独立任务账本、依赖结论和最终汇总贯通", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "team-runtime-"));
    try {
      const source = new ToolRegistry();
      let reads = 0;
      source.register({ name: "filesystem__read_text_file", description: "read", parameters: { type: "object" },
        parallelSafe: true, needsReconciliation: false, execute: async () => { reads++; return "PRIVATE_TOOL_DETAIL"; } });
      const childRequests: any[] = [];
      const client = clientWith(async request => {
        if (request.response_format) return reply(JSON.stringify({ tasks: [task("a"), task("b", ["a"])] }));
        if (request.messages[0].content.includes("你是任务协调者")) return reply("汇总结论");
        childRequests.push(request);
        if (!request.messages.some((message: any) => message.role === "tool")) {
          return { ...reply("", "tool_calls"), choices: [{ finish_reason: "tool_calls", message: { content: null,
            tool_calls: [{ id: "read", type: "function", function: { name: "filesystem__read_text_file", arguments: "{}" } }] } }] };
        }
        return reply(JSON.stringify(request.messages[0].content.includes("你是独立复核者")
          ? review([task("a"), task("b", ["a"])]) : submission("已读取资料的结论")));
      });
      const stack = { registry: source, config: { ...loadAgentConfig(), model: "test", summaryModel: "test" },
        sandboxRoot: dir, untrustedContext: "" } as AgentStack;
      const report = await new TeamCoordinator({ model: "test", client, capabilities: "只读",
        createChild: createTeamChildFactory(stack, { client, runDirectory: dir }),
      }).run("分析项目");
      expect(report.status).toBe("answered");
      expect(reads).toBe(3);
      expect(report.totalTokens).toBe(80);
      expect(report.tasks[0]!.result!.taskId).not.toBe(report.tasks[1]!.result!.taskId);
      const bInitial = childRequests[2];
      expect(JSON.stringify(bInitial)).toContain("已读取资料的结论");
      expect(JSON.stringify(bInitial)).not.toContain("PRIVATE_TOOL_DETAIL");
      expect((await fs.readdir(path.join(dir, "tasks"))).sort()).toEqual(["review-r0-team-review.sqlite", "work-r0-a.sqlite", "work-r0-b.sqlite"]);
      expect(await fs.readdir(path.join(dir, "traces"))).toHaveLength(3);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  test("配置拒绝非法并发和预算；help 不初始化网络服务", async () => {
    expect(loadTeamOptions({}).concurrency).toBe(2);
    expect(() => loadTeamOptions({ AGENT_TEAM_CONCURRENCY: "0" })).toThrow();
    expect(() => loadTeamOptions({ AGENT_TEAM_CONCURRENCY: "2x" })).toThrow();
    expect(() => loadTeamOptions({ AGENT_TEAM_TOTAL_TOKENS: "100" })).toThrow();
    const process = Bun.spawn(["bun", "run", "src/team.ts", "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(process.stdout).text()).toContain("协调规划");
    expect(await process.exited).toBe(0);
  });
});
