// tests/team_task.test.ts
// 主对话内的重 DAG 团队工具：
//   - 注册：需要 delegateEnabled 与 teamToolEnabled 同时为真
//   - 一次调用跑完整链路，汇总答复套围栏回注，运行目录可复盘
//   - 取消后返回取消前的部分结果，不抛穿到主循环
// 运行: bun test ./tests/team_task.test.ts
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { registerSessionTools } from "../src/bootstrap";
import { createTeamTaskTool } from "../src/tools/team_task";
import { runOutcome } from "../src/core/run_outcome";
import type { AgentResult, ToolRuntime } from "../src/core/types";
import type { ChildFactory, TeamTask } from "../src/core/team_scheduler";
import type { Submission, TeamReview } from "../src/core/team_contracts";

const task = (id: string, dependsOn: string[] = []): TeamTask => ({
  id, role: "analyst", goal: `分析 ${id}`, dependsOn,
  deliverables: ["分析结论"], checks: [{ id: "c1", description: "有证据支持结论" }],
});
const submission = (summary: string): Submission => ({
  summary, deliverables: [{ index: 0, content: summary }],
  findings: [{ id: "f1", claim: summary, evidenceIds: ["e1"] }],
  evidence: [{ id: "e1", source: "src/example.ts:1", excerpt: "source" }],
  coverage: [{ checkId: "c1", status: "covered", findingIds: ["f1"], note: "已核对" }], unresolved: [],
});
const review = (tasks: TeamTask[]): TeamReview => ({
  summary: "逐项核对完成",
  checks: tasks.flatMap(item => item.checks.map(check => ({
    taskId: item.id, checkId: check.id, verdict: "pass" as const, rationale: "已核对原始来源", followUp: "",
    evidenceRefs: [{ taskId: item.id, evidenceId: "e1" }],
  }))),
});
const answered = (answer: string, tokens = 10): AgentResult => ({
  ...runOutcome("answer"), finalAnswer: JSON.stringify(submission(answer)), totalTokens: tokens, toolCallsCount: 0,
  messages: [], steps: [], citations: [],
});
const instant: ChildFactory = execution => ({
  run: async () => execution.mode === "review"
    ? { ...answered("review"), finalAnswer: JSON.stringify(review(execution.reviewTargets.map(target => target.task))) }
    : answered(execution.task.id),
  shutdown: async () => {},
});

const reply = (content: string) => ({
  choices: [{ finish_reason: "stop", message: { content } }], usage: { total_tokens: 10 },
});
function clientWith(fn: (request: any) => Promise<any>): OpenAI {
  return { chat: { completions: { create: fn } } } as unknown as OpenAI;
}

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function registryWith(config: { model: string; delegateEnabled?: boolean; teamToolEnabled?: boolean }): ToolRegistry {
  const registry = new ToolRegistry();
  registerSessionTools(registry, {
    skills: [], planStore: new PlanStore(), sandbox: { backend: "host", reason: "test" }, config,
  });
  return registry;
}

const hasTeamTool = (registry: ToolRegistry) => registry.list().some(definition => definition.name === "team_task");

describe("team_task 注册条件", () => {
  test("默认注册；委派或团队开关关闭时不注册", () => {
    expect(hasTeamTool(registryWith({ model: "test" }))).toBe(true);
    expect(hasTeamTool(registryWith({ model: "test", teamToolEnabled: false }))).toBe(false);
    expect(hasTeamTool(registryWith({ model: "test", delegateEnabled: false }))).toBe(false);
  });
});

describe("team_task 一次调用跑完整链路", () => {
  test("规划 → 子任务 → 复核 → 汇总，答复套围栏回注并留下运行记录", async () => {
    const dir = await tempDir("team-task-");
    const requests: any[] = [];
    const tool = createTeamTaskTool({
      sourceRegistry: new ToolRegistry(),
      config: { model: "test" },
      sandboxRoot: dir,
      teamDir: path.join(dir, "teams"),
      client: clientWith(async request => {
        requests.push(request);
        return request.response_format
          ? reply(JSON.stringify({ tasks: [task("a"), task("b", ["a"])] }))
          : reply("最终结论");
      }),
      createChild: instant,
    });

    const output = await tool.execute({ goal: "分析项目" }, {} as ToolRuntime) as string;

    expect(output).toContain("团队任务完成：answered");
    expect(output).toContain("复核 passed");
    expect(output).toContain("子任务 2/2");
    expect(output).toContain("- a answered");
    expect(output).toContain("- b answered");
    expect(output).toContain("<UNTRUSTED_MCP_DATA>");
    expect(output).toContain("最终结论");
    // 协调调用不带 tools：规划与汇总都不会越权调用工具
    expect(requests.every(request => request.tools === undefined)).toBe(true);

    const runs = await fs.readdir(path.join(dir, "teams"));
    expect(runs).toHaveLength(1);
    const runDirectory = path.join(dir, "teams", runs[0]!);
    const result = JSON.parse(await fs.readFile(path.join(runDirectory, "result.json"), "utf8"));
    expect(result.status).toBe("answered");
    expect(result.reviewStatus).toBe("passed");
    const events = (await fs.readFile(path.join(runDirectory, "events.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toContain("team_plan");
    expect(events.at(-1).type).toBe("team_end");
  });

  test("取消后返回取消前的部分结果，不抛穿到主循环", async () => {
    const dir = await tempDir("team-task-cancel-");
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));
    const tool = createTeamTaskTool({
      sourceRegistry: new ToolRegistry(),
      config: { model: "test" },
      sandboxRoot: dir,
      teamDir: path.join(dir, "teams"),
      client: clientWith(async () => reply("不该被调用")),
      createChild: instant,
    });

    const output = await tool.execute({ goal: "分析项目" },
      { signal: controller.signal } as ToolRuntime) as string;

    expect(output).toContain("已取消");
    expect(output).toContain("团队任务未完成：cancelled");
    expect(output).toContain("团队任务未完整结束");
  });
});
