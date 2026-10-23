import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { TeamCoordinator, type TeamEvent } from "../src/core/team_coordinator";
import { parseSubmission, parseReview, type Submission, type TeamReview } from "../src/core/team_contracts";
import { validateTeamPlan, type ChildExecution, type ChildFactory, type ChildRecord, type TeamTask } from "../src/core/team_scheduler";
import { runOutcome } from "../src/core/run_outcome";
import type { AgentResult } from "../src/core/types";
import { loadTeamOptions } from "../src/team_runtime";

const task = (id: string, dependsOn: string[] = []): TeamTask => ({ id, role: "analyst", goal: `检查 ${id}`, dependsOn,
  deliverables: ["调用链和证据"], checks: [{ id: "logout", description: "检查退出后旧 token 是否失效" }] });
const submission = (summary = "已检查退出流程"): Submission => ({
  summary, deliverables: [{ index: 0, content: summary }],
  findings: [{ id: "f1", claim: summary, evidenceIds: ["e1"] }],
  evidence: [{ id: "e1", source: "src/auth.ts:20", excerpt: "revoke(token)" }],
  coverage: [{ checkId: "logout", status: "covered", findingIds: ["f1"], note: "已覆盖退出逻辑" }], unresolved: [],
});
const answer = (value: unknown, tokens = 10): AgentResult => ({ ...runOutcome("answer"), finalAnswer: JSON.stringify(value),
  totalTokens: tokens, toolCallsCount: 0, messages: [], steps: [], citations: [] });
const record = (t: TeamTask, data = submission()): ChildRecord => ({ parentRunId: "p", task: t, state: "answered", round: 0, mode: "work",
  result: { ...answer(data), submission: data } });
function review(targets: TeamTask[], gaps: string[] = [], blocked: string[] = []): TeamReview {
  return { summary: gaps.length || blocked.length ? "发现缺口" : "所有检查项有支持证据", checks: targets.flatMap(t => t.checks.map(c => ({
    taskId: t.id, checkId: c.id, verdict: blocked.includes(t.id) ? "blocked" : gaps.includes(t.id) ? "needs_work" : "pass",
    rationale: "核对了对应实现；需要确认退出后的旧 token 行为",
    evidenceRefs: [{ taskId: t.id, evidenceId: "e1" }],
    followUp: blocked.includes(t.id) ? "需要用户提供私有部署配置" : gaps.includes(t.id) ? "读取退出接口和 token 撤销逻辑，补充对应代码证据" : "",
  }))) };
}
function model(tasks: TeamTask[], onSummary?: (request: any) => void): OpenAI {
  return { chat: { completions: { create: async (request: any) => {
    expect(request.tools).toBeUndefined();
    if (!request.response_format) onSummary?.(request);
    return { choices: [{ finish_reason: "stop", message: { content: request.response_format ? JSON.stringify({ tasks }) : "最终答复" } }],
      usage: { total_tokens: 10 } };
  } } } } as unknown as OpenAI;
}
function harness(tasks: TeamTask[], execute: (execution: ChildExecution) => Promise<AgentResult> | AgentResult, options = {}) {
  const started: ChildExecution[] = [], events: TeamEvent[] = [];
  let closed = 0;
  const createChild: ChildFactory = execution => {
    started.push(execution);
    return { run: async () => execute(execution), shutdown: async () => { closed++; } };
  };
  const coordinator = new TeamCoordinator({ model: "test", client: model(tasks), capabilities: "只读代码分析", createChild,
    options, onEvent: event => events.push(event) });
  return { coordinator, started, events, closed: () => closed };
}

describe("固定任务契约和证据引用", () => {
  test("计划缺少交付/检查项或检查 ID 重复时拒绝", () => {
    expect(() => validateTeamPlan({ tasks: [{ id: "a", role: "analyst", goal: "分析", dependsOn: [] }] })).toThrow();
    expect(() => validateTeamPlan({ tasks: [{ ...task("a"), checks: [task("a").checks[0], task("a").checks[0]] }] })).toThrow("重复");
  });

  test("结果必须覆盖完整原始要求，引用必须闭合；不能伪造 covered", () => {
    expect(parseSubmission(JSON.stringify(submission()), task("a"))).toEqual(submission());
    const mutations: Array<(s: Submission) => void> = [
      s => { s.deliverables = []; }, s => { s.deliverables[0]!.index = 1; },
      s => { s.coverage[0]!.checkId = "easier"; },
      s => { s.coverage.push(s.coverage[0]!); },
      s => { s.findings[0]!.evidenceIds = ["invented"]; },
      s => { s.coverage[0]!.findingIds = ["invented"]; },
      s => { s.coverage[0]!.findingIds = []; },
      s => { s.evidence.push(s.evidence[0]!); },
    ];
    for (const mutate of mutations) {
      const s = submission(); mutate(s);
      expect(() => parseSubmission(JSON.stringify(s), task("a"))).toThrow();
    }
    const missing = submission(); missing.coverage[0]!.status = "missing";
    missing.coverage[0]!.findingIds = []; missing.unresolved = ["缺少撤销配置"];
    expect(parseSubmission(JSON.stringify(missing), task("a")).unresolved).toHaveLength(1);
  });

  test("容错提取：接受围栏与前后说明文字，提取后仍走完整校验", () => {
    const valid = JSON.stringify(submission());
    for (const raw of [
      "```json\n" + valid + "\n```",
      "以下是结果：\n```\n" + valid + "\n```\n请查收。",
      "前言 " + valid + " 后记",
    ]) {
      expect(parseSubmission(raw, task("a")).summary).toBe("已检查退出流程");
    }
    expect(() => parseSubmission("```json\n{\"summary\":\"残缺\"}\n```", task("a"))).toThrow();
    expect(parseReview("说明文字\n```json\n" + JSON.stringify(review([task("a")])) + "\n```",
      [record(task("a"))]).summary).toBe("所有检查项有支持证据");
  });

  test("复核不能遗漏检查项、引用虚构证据、修改标准或提出空泛返工", () => {
    const tasks = [task("a"), task("b")];
    const targets = tasks.map(t => record(t));
    const mutations: Array<(r: TeamReview) => void> = [
      r => { r.checks.pop(); }, r => { r.checks[1] = r.checks[0]!; },
      r => { r.checks[0]!.taskId = "invented"; }, r => { r.checks[0]!.checkId = "easier"; },
      r => { r.checks[0]!.evidenceRefs[0]!.evidenceId = "invented"; },
      r => { r.checks[0]!.verdict = "needs_work"; r.checks[0]!.followUp = ""; },
    ];
    for (const mutate of mutations) {
      const r = review(tasks); mutate(r);
      expect(() => parseReview(JSON.stringify(r), targets)).toThrow();
    }
    expect(() => parseReview(JSON.stringify({ ...review(tasks), tasks: [] }), targets)).toThrow();
  });

  test("宿主拒绝把未解决问题、失败任务或不相关证据洗成通过", () => {
    const t = task("a");
    for (const target of [
      { ...record(t), state: "failed" },
      record(t, { ...submission(), unresolved: ["未确认旧 token"] }),
      record(t, { ...submission(), coverage: [{ checkId: "logout", status: "missing", findingIds: [], note: "缺数据" }] }),
    ]) {
      const r = parseReview(JSON.stringify(review([t])), [target]);
      expect(r.checks[0]!.verdict).toBe("needs_work");
      expect(r.checks[0]!.followUp).toContain("logout");
    }
    const s = submission(); s.evidence.push({ id: "irrelevant", source: "README.md", excerpt: "项目简介" });
    const r = review([t]); r.checks[0]!.evidenceRefs = [{ taskId: "a", evidenceId: "irrelevant" }];
    expect(parseReview(JSON.stringify(r), [record(t, s)]).checks[0]!.verdict).toBe("needs_work");
  });
});

describe("独立复核与最多两轮定向补查", () => {
  test("补查缺口及所有下游，保留无关分支；完整保留原始标准、反馈和每轮结果", async () => {
    const tasks = [task("auth"), task("conclusion", ["auth"]), task("unrelated")];
    const h = harness(tasks, e => e.mode === "review"
      ? answer(review(tasks, e.round === 0 ? ["auth"] : []))
      : answer(submission(`${e.task.id}-round-${e.round}`)));
    const report = await h.coordinator.run("分析退出流程");
    expect(report.status).toBe("answered");
    expect(report.reviewStatus).toBe("passed");
    expect(report.reworkRounds).toBe(1);
    expect(report.tasks.map(t => `${t.task.id}/${t.round}`)).toEqual([
      "auth/0", "conclusion/0", "unrelated/0", "auth/1", "conclusion/1",
    ]);
    expect(report.reviews).toHaveLength(2);
    expect(report.totalTokens).toBe(90); // plan + 5 workers + 2 reviewers + summary
    const reruns = h.started.filter(e => e.mode === "work" && e.round === 1);
    expect(reruns[0]!.task).toEqual(tasks[0]!);
    expect(reruns[0]!.feedback[0]!.followUp).toContain("撤销逻辑");
    expect(reruns[0]!.previous!.result!.submission!.summary).toBe("auth-round-0");
    expect(reruns[1]!.dependencies[0]!.result!.submission!.summary).toBe("auth-round-1");
    expect(reruns[1]!.feedback).toEqual([]); // Downstream is invalidated even though review passed it earlier.
    expect(h.closed()).toBe(7);
    expect(h.events.filter(e => e.type === "team_rework")).toHaveLength(1);
  });

  test("重复缺口最多两轮，汇总不得抹掉未通过状态", async () => {
    const tasks = [task("auth")];
    const h = harness(tasks, e => answer(e.mode === "review" ? review(tasks, ["auth"]) : submission()));
    const report = await h.coordinator.run("检查退出");
    expect(report.status).toBe("incomplete");
    expect(report.reviewStatus).toBe("needs_work");
    expect(report.reworkRounds).toBe(2);
    expect(report.tasks.map(t => t.round)).toEqual([0, 1, 2]);
    expect(report.reviews).toHaveLength(3);
    expect(report.error).toContain("轮数");
    expect(report.totalTokens).toBe(80);
  });

  test("blocked 返回外部条件，不盲目重跑；允许关闭补查但仍进行复核", async () => {
    const tasks = [task("auth")];
    const blocked = harness(tasks, e => answer(e.mode === "review" ? review(tasks, [], ["auth"]) : submission()));
    const r = await blocked.coordinator.run("test");
    expect(r.reviewStatus).toBe("blocked"); expect(r.status).toBe("incomplete");
    expect(r.reworkRounds).toBe(0); expect(r.tasks).toHaveLength(1);
    const disabled = harness(tasks, e => answer(e.mode === "review" ? review(tasks, ["auth"]) : submission()), { maxReworkRounds: 0 });
    const d = await disabled.coordinator.run("test");
    expect(d.reviews).toHaveLength(1); expect(d.tasks).toHaveLength(1); expect(d.status).toBe("incomplete");
  });

  test("返工预算与初始运行共享，独立复核及最终汇总保留配额", async () => {
    const tasks = [task("auth")];
    const h = harness(tasks, e => answer(e.mode === "review" ? review(tasks, ["auth"]) : submission(), 24000),
      { totalTokens: 84000 }); // minimum = 2*24000 + 2*18000
    const report = await h.coordinator.run("test");
    expect(report.status).toBe("incomplete");
    expect(report.tasks).toHaveLength(1); expect(report.reviews).toHaveLength(1);
    expect(report.totalTokens).toBe(48020);
    expect(report.error).toContain("预算");
    expect(h.events.some(e => e.type === "team_summary")).toBe(true);
  });

  test("复核阶段取消：保留已完成任务和取消记录，不开始补查或汇总", async () => {
    const tasks = [task("auth")];
    const controller = new AbortController();
    const h = harness(tasks, e => {
      if (e.mode === "work") return answer(submission());
      controller.abort();
      return { ...answer({}), ...runOutcome("cancelled") };
    });
    const report = await h.coordinator.run("test", { signal: controller.signal });
    expect(report.status).toBe("cancelled"); expect(report.tasks[0]!.state).toBe("answered");
    expect(report.reviews[0]!.state).toBe("cancelled");
    expect(h.events.some(e => e.type === "team_summary" || e.type === "team_rework")).toBe(false);
    expect(h.closed()).toBe(2);
  });

  test("结构化结果损坏不会被当成功，复核可提出定向格式修复", async () => {
    const tasks = [task("auth")];
    const h = harness(tasks, e => {
      if (e.mode === "work") return e.round === 0 ? answer({ summary: "没有提供交付和证据" }) : answer(submission());
      const r = review(tasks, e.round === 0 ? ["auth"] : []);
      if (e.round === 0) { r.checks[0]!.evidenceRefs = []; r.checks[0]!.followUp = "按原始检查项补交结构化证据和覆盖情况"; }
      return answer(r);
    });
    const report = await h.coordinator.run("test");
    expect(report.status).toBe("answered");
    expect(report.tasks.map(t => t.state)).toEqual(["failed", "answered"]);
    expect(report.tasks[0]!.result?.finalAnswer).toContain("没有提供");
  });

  test("复核输出非法直接报告失败，不能补造一个通过结果", async () => {
    const h = harness([task("auth")], e => answer(e.mode === "review" ? { summary: "看起来没问题", checks: [] } : submission()));
    const report = await h.coordinator.run("test");
    expect(report.reviewStatus).toBe("failed"); expect(report.status).toBe("incomplete");
    expect(report.reworkRounds).toBe(0); expect(report.tasks).toHaveLength(1);
    expect(report.reviews).toHaveLength(2); // 失败先原样重试一次，两次都失败才判 failed
    expect(report.reviews.every(review => review.state === "failed")).toBe(true);
  });

  test("复核首次失败重试成功则闭环继续，保留两份复核记录", async () => {
    const tasks = [task("auth")];
    let attempts = 0;
    const h = harness(tasks, e => {
      if (e.mode !== "review") return answer(submission());
      if (e.repair) return answer({ summary: "修复也失败", checks: [] });
      attempts++;
      return attempts === 1 ? answer({ summary: "首次复核坏格式", checks: [] }) : answer(review(tasks));
    });
    const report = await h.coordinator.run("test");
    expect(report.status).toBe("answered");
    expect(report.reviewStatus).toBe("passed");
    expect(attempts).toBe(2);
    expect(report.reviews.map(review => review.state)).toEqual(["failed", "answered"]);
  });

  test("复核重试受预算约束，余额不足时只跑一次", async () => {
    const tasks = [task("auth")];
    let attempts = 0;
    const h = harness(tasks, e => {
      if (e.mode !== "review") return answer(submission(), 10);
      if (e.repair) return answer({ summary: "修复也失败", checks: [] }, 10);
      attempts++;
      return answer({ summary: "坏格式", checks: [] }, 2060); // 消耗掉几乎全部预算
    }, { totalTokens: 2_100, childTokens: 50, coordinationTokens: 1_000 });
    const report = await h.coordinator.run("test");
    expect(report.reviewStatus).toBe("failed");
    expect(report.status).toBe("incomplete");
    expect(attempts).toBe(1);
    expect(report.reviews).toHaveLength(1);
  });

  test("最终汇总只收到最新版本与最终反馈，不能混用旧结果", async () => {
    const tasks = [task("auth")];
    let summaryInput = "";
    const createChild: ChildFactory = e => ({ run: async () => answer(e.mode === "review"
      ? review(tasks, e.round === 0 ? ["auth"] : []) : submission(e.round === 0 ? "OUTDATED" : "CORRECTED")), shutdown: async () => {} });
    const c = new TeamCoordinator({ model: "test", client: model(tasks, r => { summaryInput = r.messages[1].content; }),
      capabilities: "read only", createChild });
    const report = await c.run("test");
    expect(report.status).toBe("answered");
    expect(summaryInput).toContain("CORRECTED"); expect(summaryInput).not.toContain("OUTDATED");
    expect(summaryInput).toContain("<UNTRUSTED_MCP_DATA>");
  });

  test("补查配置受宿主 0–2 上限约束", () => {
    expect(loadTeamOptions({}).maxReworkRounds).toBe(2);
    expect(loadTeamOptions({ AGENT_TEAM_MAX_REWORK_ROUNDS: "0" }).maxReworkRounds).toBe(0);
    expect(() => loadTeamOptions({ AGENT_TEAM_MAX_REWORK_ROUNDS: "3" })).toThrow();
    expect(() => loadTeamOptions({ AGENT_TEAM_MAX_REWORK_ROUNDS: "-1" })).toThrow();
  });
});
