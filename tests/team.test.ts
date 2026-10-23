import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import type { AgentStack } from "../src/bootstrap";
import { loadAgentConfig } from "../src/config";
import { AgentScheduler, TeamTokenBudget, validateTeamPlan, type ChildFactory, type ChildExecution,
  type TeamTask } from "../src/core/team_scheduler";
import { TeamCoordinator, type TeamEvent } from "../src/core/team_coordinator";
import { createTeamChildFactory, createTeamRegistry, loadTeamOptions } from "../src/team_runtime";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { runOutcome, type StopReason } from "../src/core/run_outcome";
import type { AgentResult } from "../src/core/types";

const task = (id: string, dependsOn: string[] = []): TeamTask => ({ id, role: "analyst", goal: `分析 ${id}`, dependsOn });
const result = (answer: string, tokens = 10, reason: StopReason = "answer"): AgentResult => ({
  ...runOutcome(reason), finalAnswer: answer, totalTokens: tokens, toolCallsCount: 0,
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
const instant: ChildFactory = execution => ({ run: async () => result(execution.task.id), shutdown: async () => {} });

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
    expect(started[2]!.dependencies[0]!.result!.finalAnswer).toBe("A result");
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
    expect(report.totalTokens).toBe(40);
    expect(report.finalAnswer).toBe("最终结论");
    expect(requests[1].messages[1].content).toContain("<UNTRUSTED_MCP_DATA>");
    expect(events.map(event => event.type)).toEqual([
      "team_start", "team_plan", "team_task", "team_task", "team_task", "team_task", "team_summary", "team_end",
    ]);
  });

  test("规划格式错误和输出截断不会启动子任务", async () => {
    for (const response of [reply("invalid JSON"), reply(JSON.stringify({ tasks: [task("a")] }), "length")]) {
      let created = 0;
      const report = await new TeamCoordinator({ model: "test", capabilities: "只读",
        client: clientWith(async () => response), createChild: execution => { created++; return instant(execution); },
      }).run("test");
      expect(report.status).toBe("failed");
      expect(created).toBe(0);
      expect(report.totalTokens).toBe(10);
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
        return reply("已读取资料的结论");
      });
      const stack = { registry: source, config: { ...loadAgentConfig(), model: "test", summaryModel: "test" },
        sandboxRoot: dir, untrustedContext: "" } as AgentStack;
      const report = await new TeamCoordinator({ model: "test", client, capabilities: "只读",
        createChild: createTeamChildFactory(stack, { client, runDirectory: dir }),
      }).run("分析项目");
      expect(report.status).toBe("answered");
      expect(reads).toBe(2);
      expect(report.totalTokens).toBe(60);
      expect(report.tasks[0]!.result!.taskId).not.toBe(report.tasks[1]!.result!.taskId);
      const bInitial = childRequests[2];
      expect(JSON.stringify(bInitial)).toContain("已读取资料的结论");
      expect(JSON.stringify(bInitial)).not.toContain("PRIVATE_TOOL_DETAIL");
      expect((await fs.readdir(path.join(dir, "tasks"))).sort()).toEqual(["a.sqlite", "b.sqlite"]);
      expect(await fs.readdir(path.join(dir, "traces"))).toHaveLength(2);
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
