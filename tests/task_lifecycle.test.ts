import { afterEach, describe, expect, test, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Agent } from "../src/core/agent";
import { PlanStore } from "../src/core/plan_store";
import { SessionStore } from "../src/core/session_store";
import { TaskStore } from "../src/core/task_store";
import { verifyTask } from "../src/core/task_verifier";
import { runOutcome } from "../src/core/run_outcome";
import { ToolRegistry } from "../src/core/registry";
import { createSetAcceptanceCriteriaTool, createReadTaskStateTool } from "../src/tools/set_acceptance_criteria";
import { createUpdatePlanTool } from "../src/tools/update_plan";
import { AcceptanceCriteriaSchema, type AcceptanceCriterion } from "../src/core/task_types";
import { SessionManager } from "../src/server/sessions";
import { ServerEventSchema } from "../src/server/protocol";

const dirs: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-lifecycle-"));
  dirs.push(root); return root;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const reply = (content = "已完成") => ({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const call = (name: string, args: unknown = {}) => ({ choices: [{ finish_reason: "tool_calls", message: {
  content: null, tool_calls: [{ id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } }],
} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
type Config = ConstructorParameters<typeof Agent>[0];
function setup(script: unknown[], config: Partial<Config> = {}) {
  let count = 0;
  const payloads: any[] = [];
  const client = { chat: { completions: { create: async (params: unknown) => {
    payloads.push(params);
    const item = script[count++];
    if (item === undefined) throw new Error("unexpected request");
    return item;
  } } } };
  const agent = new Agent({ model: "test", systemPrompt: "test", maxRetries: 0, ...config, client: client as any });
  return { agent, payloads, count: () => count };
}
const criterion: AcceptanceCriterion = { kind: "text_contains", path: "report.txt", description: "报告包含指定结果", text: "verified content" };
const pending = { status: "not_configured" as const, checks: [] };

describe("independent acceptance", () => {
  test("a completion claim cannot pass a missing-file check", async () => {
    const root = await fixture();
    const { agent } = setup([reply()], { verificationRoot: root, acceptanceCriteria: [criterion], maxIterations: 1 });
    const result = await agent.run("生成报告");
    expect(result).toMatchObject({ success: false, stopReason: "verification_failed", taskStatus: "incomplete" });
    expect(result.task?.state).toBe("incomplete");
    expect(result.verification?.checks[0]?.passed).toBe(false);
  });
  test("real files produce a hash-backed result and matching durable history", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "report.txt"), "verified content");
    const sessionStore = new SessionStore({ dir: root, sessionId: "s" });
    const { agent } = setup([reply()], { sessionStore, verificationRoot: root, acceptanceCriteria: [criterion] });
    const result = await agent.run("生成报告");
    expect(result).toMatchObject({ success: true, stopReason: "verified_answer", taskStatus: "verified" });
    expect(result.verification?.checks[0]?.sha256).toBe(createHash("sha256").update("verified content").digest("hex"));
    const manager = new SessionManager({ sessionDir: root } as any);
    const detail = await manager.history("s");
    expect(detail.task?.state).toBe("completed");
    expect(detail.messages.at(-1)?.outcome?.taskStatus).toBe("verified");
    expect(ServerEventSchema.parse({ type: "task_update", task: detail.task }).type).toBe("task_update");
  });
  test("verifier failure is fed back for one repair and reread before completion", async () => {
    const root = await fixture();
    const tools = new ToolRegistry();
    tools.register({ name: "repair", description: "repair", execute: async () => {
      await fs.writeFile(path.join(root, "report.txt"), "verified content"); return { ok: true };
    } });
    const { agent, payloads } = setup([reply(), call("repair"), reply()], { tools, verificationRoot: root, acceptanceCriteria: [criterion] });
    const result = await agent.run("生成报告");
    expect(result.stopReason).toBe("verified_answer");
    expect(payloads[1].messages.some((m: any) => String(m.content).includes("独立验收尚未通过"))).toBe(true);
    expect(result.task?.actions[0]?.state).toBe("returned");
  });
  test("no criteria and completed plan still do not constitute verified completion", async () => {
    const planStore = new PlanStore();
    const tools = new ToolRegistry(); tools.register(createUpdatePlanTool(planStore));
    const { agent } = setup([call("update_plan", { steps: [{ content: "工作", status: "completed" }] }), reply()], { tools, planStore });
    const result = await agent.run("工作");
    expect(result.taskStatus).toBe("answered");
    expect(result.task?.state).toBe("answered");
  });
  test("incomplete plans and refusals are never upgraded by matching files", async () => {
    const root = await fixture(); await fs.writeFile(path.join(root, "report.txt"), "verified content");
    const planStore = new PlanStore(); const tools = new ToolRegistry(); tools.register(createUpdatePlanTool(planStore));
    const { agent } = setup([call("update_plan", { steps: [{ content: "另一个要求", status: "pending" }] }), reply()],
      { tools, planStore, verificationRoot: root, acceptanceCriteria: [criterion] });
    expect((await agent.run("工作")).stopReason).toBe("plan_incomplete");
    const refused = setup([{ choices: [{ finish_reason: "stop", message: { content: null, refusal: "拒绝" } }] }],
      { verificationRoot: root, acceptanceCriteria: [criterion] });
    expect((await refused.agent.run("工作")).stopReason).toBe("model_refusal");
  });
  test("model can declare checks but cannot mark them passed or weaken them", async () => {
    const root = await fixture(); const tools = new ToolRegistry(); tools.register(createSetAcceptanceCriteriaTool());
    const { agent } = setup([call("set_acceptance_criteria", { criteria: [criterion] }),
      call("set_acceptance_criteria", { criteria: [{ ...criterion, text: "x" }] }), reply()],
      { tools, verificationRoot: root, maxIterations: 3 });
    const result = await agent.run("生成报告");
    expect(result.task?.criteria).toEqual([criterion]);
    expect(result.task?.criteriaSource).toBe("agent");
    expect(result.task?.actions[1]?.resultPreview).toContain("不可由模型删除或降低");
    expect(result.stopReason).toBe("verification_failed");
  });
  test("late criteria are rejected instead of fitted to an existing output", async () => {
    const root = await fixture(); const store = new TaskStore(); store.begin("报告", { workspace: root });
    const id = store.startAction("write", "{}"); store.endAction(id, "ok");
    expect(() => store.setCriteria([criterion])).toThrow("之前定义");
  });
  test("file size, exact JSON values and hash checks use actual content", async () => {
    const root = await fixture(); const bytes = '{"ok":true,"items":[1,2]}';
    await fs.writeFile(path.join(root, "a.json"), bytes);
    const criteria = AcceptanceCriteriaSchema.parse([
      { kind: "file_exists", path: "a.json", description: "存在", minBytes: 1 },
      { kind: "json_equals", path: "a.json", description: "结构", keys: ["items"], expected: [1,2] },
      { kind: "sha256", path: "a.json", description: "内容", digest: createHash("sha256").update(bytes).digest("hex") },
    ]);
    expect((await verifyTask(root, criteria)).status).toBe("passed");
    await fs.writeFile(path.join(root, "a.json"), '{"items":[2,1]}');
    expect((await verifyTask(root, criteria)).checks.map(c => c.passed)).toEqual([true, false, false]);
  });
  test("verifier rejects escapes, credentials, directory links and oversized files", async () => {
    const root = await fixture(); const outside = await fixture();
    await fs.writeFile(path.join(outside, "report.txt"), "verified content");
    await fs.symlink(outside, path.join(root, "link"), "junction");
    await fs.writeFile(path.join(root, "large.txt"), Buffer.alloc(5_000_001));
    for (const filename of ["../report.txt", "C:/secret", ".env", ".env.", ".git /config", ".git/config", "link/report.txt", "large.txt"]) {
      expect((await verifyTask(root, [{ ...criterion, path: filename }])).status).toBe("failed");
    }
  });
});

describe("durable tasks and recovery", () => {
  test("new Agent instance restores the same task, goal, plan and action result", async () => {
    const root = await fixture(); const sessionStore = new SessionStore({ dir: root, sessionId: "s" });
    const firstPlan = new PlanStore(); const tools = new ToolRegistry(); tools.register(createUpdatePlanTool(firstPlan));
    const first = setup([call("update_plan", { steps: [{ content: "生成报告", status: "pending" }] }), reply("部分完成")], { sessionStore, tools, planStore: firstPlan });
    const a = await first.agent.run("目标：生成报告");
    const secondPlan = new PlanStore();
    const next = setup([reply("继续执行")], { sessionStore, planStore: secondPlan });
    const b = await next.agent.run("补充要求：中文");
    expect(b.taskId).toBe(a.taskId);
    expect(b.runId).not.toBe(a.runId);
    expect(b.task?.runs).toHaveLength(2);
    expect(secondPlan.getSteps()).toEqual([{ content: "生成报告", status: "pending" }]);
    expect(next.payloads[0].messages.some((m: any) => String(m.content).includes("目标：生成报告"))).toBe(true);
    expect(next.payloads[0].messages.every((m: any) => !("outcome" in m))).toBe(true);
  });
  test("restored task data never precedes or becomes a system template", async () => {
    const taskStore = new TaskStore(); taskStore.begin("原目标"); taskStore.finish(runOutcome("answer"), "答", pending);
    const { agent, payloads } = setup([reply()], { taskStore, untrustedContext: "外部资料",
      promptTemplate: { label: "host", messages: [{ role: "system", text: "宿主选定的规则" }] } });
    await agent.run("继续");
    const messages = payloads[0].messages;
    expect(messages.slice(0, 2).map((m: any) => m.role)).toEqual(["system", "system"]);
    expect(messages.slice(2).every((m: any) => m.role !== "system")).toBe(true);
    expect(messages.find((m: any) => String(m.content).includes("持久化任务记录"))?.role).toBe("user");
  });
  test("restoring without an injected PlanStore still enforces the saved pending plan", async () => {
    const taskStore = new TaskStore(); taskStore.begin("原目标");
    taskStore.setPlan([{ content: "未完成工作", status: "pending" }]); taskStore.finish(runOutcome("plan_incomplete"), "部分", pending);
    const { agent } = setup([reply()], { taskStore });
    const result = await agent.run("继续");
    expect(result.stopReason).toBe("plan_incomplete"); expect(result.task?.plan[0]?.status).toBe("pending");
  });
  test("explicit new task retains previous records but resets its plan and criteria", async () => {
    const store = new TaskStore(); const root = await fixture();
    const first = store.begin("旧目标", { workspace: root, criteria: [criterion] });
    store.setPlan([{ content: "旧计划", status: "pending" }]); store.finish(runOutcome("plan_incomplete"), "部分", pending);
    const second = store.begin("新目标", { fresh: true, workspace: root });
    expect(second.id).not.toBe(first.id); expect(second.plan).toEqual([]); expect(second.criteria).toEqual([]);
    expect(store.list()[0]?.state).toBe("superseded");
  });
  test("same session cannot run twice, separate sessions do not share state", async () => {
    const root = await fixture(); const file = path.join(root, "task.sqlite");
    const one = new TaskStore(file); const two = new TaskStore(file);
    one.begin("one"); expect(() => two.begin("two")).toThrow("另一个执行器");
    const separate = new TaskStore(path.join(root, "other.sqlite"));
    separate.begin("other"); expect(separate.current()?.goal).toBe("other");
    one.finish(runOutcome("answer"), "ok", pending);
    expect(two.begin("继续").goal).toBe("one");
  });
  test("workspace switch cannot silently reuse old acceptance criteria", async () => {
    const store = new TaskStore(); store.begin("one", { workspace: "A:/one" }); store.finish(runOutcome("answer"), "ok", pending);
    expect(() => store.begin("继续", { workspace: "A:/two" })).toThrow("工作区已变化");
  });
  test("process dies after a side effect: unknown action blocks model execution until reconciled", async () => {
    const root = await fixture();
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/task_crash.ts"), root], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(23);
    const taskStore = new TaskStore(path.join(root, "task.sqlite"));
    const task = taskStore.current()!;
    expect(task.state).toBe("interrupted"); expect(task.actions[0]?.state).toBe("unknown");
    const { agent, count } = setup([], { taskStore, verificationRoot: root });
    expect((await agent.run("继续")).stopReason).toBe("recovery_required"); expect(count()).toBe(0);
    expect(() => taskStore.begin("新任务", { fresh: true, workspace: root })).toThrow("结果未知");
    const action = task.actions[0]!;
    await agent.run(`/task resolve ${action.id} applied 已核对文件存在且只写入一次`);
    taskStore.begin("继续", { workspace: root });
    expect(() => taskStore.startAction("write_once", action.arguments)).toThrow("不能原样重放");
    expect(await fs.readFile(path.join(root, "marker.txt"), "utf8")).toBe("executed\n");
  });
  test("human wait is recorded before the callback and clears after answer", async () => {
    const store = new TaskStore(); const tools = new ToolRegistry();
    tools.register({ name: "ask", description: "ask", execute: async (_, runtime) => runtime?.askUser?.("选择版本", new AbortController().signal) });
    const { agent } = setup([call("ask"), reply()], { tools, taskStore: store });
    await agent.run("问", { askUser: async () => {
      expect(store.current()?.state).toBe("waiting_input");
      expect(store.current()?.waiting?.prompt).toBe("选择版本"); return "版本二";
    } });
    expect(store.current()?.waiting).toBeUndefined();
    expect(store.current()?.state).toBe("answered");
  });
  test("history is available through bounded task-state reads after restart", async () => {
    const root = await fixture(); const file = path.join(root, "task.sqlite");
    const first = new TaskStore(file);
    for (let i = 0; i < 3; i++) { first.begin(`要求${i}`); first.finish(runOutcome("answer"), "回答", pending); }
    const tools = new ToolRegistry(); tools.register(createReadTaskStateTool());
    const { agent } = setup([call("read_task_state", { offset: 0, limit: 2 }), reply()], { taskStore: new TaskStore(file), tools });
    const result = await agent.run("继续");
    const observation = JSON.parse(result.steps[0]!.toolCalls[0]!.result);
    expect(observation.runs.map((run: any) => run.input)).toEqual(["要求0", "要求1"]);
    expect(observation.totalRuns).toBe(4); expect(observation.nextOffset).toBe(2);
  });
  test("failed final task write reports failure and releases abandoned ownership", async () => {
    const store = new TaskStore(); const { agent } = setup([reply()], { taskStore: store });
    const fault = spyOn(store, "finish").mockImplementation(() => { throw new Error("disk failure"); });
    try { expect((await agent.run("工作")).success).toBe(false); }
    finally { fault.mockRestore(); }
    expect(store.current()?.state).toBe("interrupted");
    expect(store.begin("继续").goal).toBe("工作");
  });
  test("history write failure cannot leave a task marked completed", async () => {
    const root = await fixture(); await fs.writeFile(path.join(root, "report.txt"), "verified content");
    const sessionStore = new SessionStore({ dir: root });
    const original = sessionStore.append.bind(sessionStore);
    const fault = spyOn(sessionStore, "append").mockImplementation(async message => {
      if (message.role === "assistant") throw new Error("history full");
      return original(message);
    });
    const { agent } = setup([reply()], { sessionStore, verificationRoot: root, acceptanceCriteria: [criterion] });
    try {
      const result = await agent.run("工作");
      expect(result.success).toBe(false); expect(result.task?.state).toBe("failed");
    } finally { fault.mockRestore(); }
  });
  test("a second Agent sharing the same task store cannot release the active owner", async () => {
    const store = new TaskStore(); const tools = new ToolRegistry();
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    let proceed!: () => void; const wait = new Promise<void>(resolve => { proceed = resolve; });
    tools.register({ name: "wait", description: "wait", execute: async () => { entered(); await wait; return "ok"; } });
    const one = setup([call("wait"), reply()], { taskStore: store, tools });
    const two = setup([], { taskStore: store });
    const running = one.agent.run("原任务"); await ready;
    try {
      expect((await two.agent.run("第二个任务")).success).toBe(false);
      expect(store.current()?.state).toBe("running");
    } finally { proceed(); }
    expect((await running).success).toBe(true);
  });
  test("cancellation during a tool records uncertain effects and does not verify", async () => {
    const root = await fixture(); const controller = new AbortController(); const tools = new ToolRegistry();
    tools.register({ name: "write", description: "write", execute: async () => { controller.abort(); return "may have written"; } });
    const { agent } = setup([call("write")], { tools, verificationRoot: root, acceptanceCriteria: [criterion] });
    const result = await agent.run("工作", { signal: controller.signal });
    expect(result.stopReason).toBe("cancelled"); expect(result.task?.state).toBe("interrupted");
    expect(result.verification?.status).toBe("pending");
  });
  test("measured evidence survives endings that are not answers", async () => {
    const root = await fixture(); await fs.writeFile(path.join(root, "report.txt"), "verified content");
    const planStore = new PlanStore(); const tools = new ToolRegistry(); tools.register(createUpdatePlanTool(planStore));
    const { agent } = setup([call("update_plan", { steps: [{ content: "报告", status: "pending" }] }), reply()],
      { tools, planStore, verificationRoot: root, acceptanceCriteria: [criterion] });
    const result = await agent.run("生成报告");
    expect(result.stopReason).toBe("plan_incomplete");
    expect(result.verification?.status).toBe("passed");
    expect(result.task?.state).toBe("incomplete");
    expect(result.task?.verification.checks[0]?.sha256).toBe(createHash("sha256").update("verified content").digest("hex"));
  });
  test("host policy refuses to certify criteria the model wrote itself", async () => {
    const root = await fixture(); await fs.writeFile(path.join(root, "report.txt"), "verified content");
    const lenient: AcceptanceCriterion = { kind: "file_exists", path: "report.txt", description: "文件存在即可", minBytes: 1 };
    const tools = new ToolRegistry(); tools.register(createSetAcceptanceCriteriaTool());
    const selfGraded = setup([call("set_acceptance_criteria", { criteria: [lenient] }), reply()],
      { tools, verificationRoot: root, requireHostAcceptanceCriteria: true });
    const result = await selfGraded.agent.run("生成报告");
    expect(result.verification?.status).toBe("passed");
    expect(result.task?.criteriaSource).toBe("agent");
    expect(result.taskStatus).toBe("answered");
    expect(result.task?.state).toBe("answered");
    const hostGraded = setup([reply()], { verificationRoot: root, requireHostAcceptanceCriteria: true, acceptanceCriteria: [lenient] });
    expect((await hostGraded.agent.run("生成报告")).task?.state).toBe("completed");
  });
  test("cancelling a side-effect-free tool settles without asking for reconciliation", async () => {
    const root = await fixture(); const controller = new AbortController(); const tools = new ToolRegistry();
    tools.register({ name: "peek", description: "peek", needsReconciliation: false,
      execute: async () => { controller.abort(); return "只读采到的内容"; } });
    const store = new TaskStore();
    const { agent } = setup([call("peek")], { tools, taskStore: store, verificationRoot: root });
    const result = await agent.run("工作", { signal: controller.signal });
    expect(result.task?.state).toBe("cancelled");
    expect(result.task?.actions[0]?.state).toBe("no_effect");
    expect(store.begin("继续", { workspace: root }).runs).toHaveLength(2);
  });
  test("a run that dies after a side effect returned still blocks silent replay", async () => {
    const root = await fixture();
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/task_crash_after_return.ts"), root], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(24);
    const taskStore = new TaskStore(path.join(root, "task.sqlite"));
    const task = taskStore.current()!;
    expect(task.actions[0]?.state).toBe("unknown");
    expect(task.actions[0]?.resolution).toBe("process_interrupted_after_return");
    expect(() => taskStore.begin("继续", { workspace: root })).toThrow("结果未知");
    const { agent, count } = setup([], { taskStore, verificationRoot: root });
    await agent.run("/task resolve all applied 已核对 marker.txt 只写入一次");
    expect(count()).toBe(0);
    expect(taskStore.current()?.actions[0]?.state).toBe("applied");
    expect(taskStore.begin("继续", { workspace: root }).runs).toHaveLength(2);
    expect(() => taskStore.startAction("write_once", '{"path":"marker.txt"}')).toThrow("不能原样重放");
  });
  test("all settles every pending action with one command", async () => {
    const root = await fixture(); const store = new TaskStore();
    store.begin("批量写入", { workspace: root });
    const one = store.startAction("write", '{"n":1}'); const two = store.startAction("write", '{"n":2}');
    store.endAction(one, "中断", true); store.endAction(two, "中断", true);
    store.finish(runOutcome("cancelled"), null, pending);
    expect(store.current()?.actions.filter(a => a.state === "unknown")).toHaveLength(2);
    expect(store.resolveAction("all", "not_applied", "两条都确认没有落盘").actions.every(a => a.state === "not_applied")).toBe(true);
    expect(store.begin("继续", { workspace: root }).runs).toHaveLength(2);
  });
});
