import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { createAgentStack } from "./bootstrap";
import { TeamCoordinator, type TeamEvent } from "./core/team_coordinator";
import { createTeamChildFactory, loadTeamOptions, TEAM_CAPABILITIES } from "./team_runtime";

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log('用法：bun run team "任务目标"\n或：echo "任务目标" | bun run team\n' +
      '第一版：协调规划 → 独立只读子 Agent 按依赖执行 → 汇总。配置和边界见 docs/子Agent运行时.md。');
    return;
  }
  const goal = args.length ? args.join(" ").trim() : process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
  if (!goal || goal.length > 12000) throw new Error('请提供 1–12000 字符的任务目标：bun run team "目标"');
  const options = loadTeamOptions();
  const runId = randomUUID();
  const runDirectory = path.resolve(process.env.AGENT_SESSION_DIR ?? ".agent-sessions", "teams", runId);
  await fs.mkdir(runDirectory, { recursive: true });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("用户取消"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let stack: Awaited<ReturnType<typeof createAgentStack>> | undefined;
  try {
    // Read-only workers never require an interactive approval channel. MCP ask policies remain denied.
    stack = await createAgentStack({ disableRunScript: true });
    const client = new OpenAI({ maxRetries: 0 });
    const onEvent = (event: TeamEvent) => {
      appendFileSync(path.join(runDirectory, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
      if (event.type === "team_plan") console.log(`计划：${event.plan.tasks.length} 个子任务，并发 ${options.concurrency}`);
      if (event.type === "team_task") console.log(`[${event.task.task.id}] ${event.task.state}${event.task.reason ? ` · ${event.task.reason}` : ""}`);
      if (event.type === "team_summary") console.log("正在汇总子任务结果…");
    };
    console.log(`团队运行记录：${runDirectory}`);
    const coordinator = new TeamCoordinator({ model: stack.config.model, client, options, onEvent,
      capabilities: TEAM_CAPABILITIES + "\n当前已挂载工具会由宿主白名单筛选。",
      createChild: createTeamChildFactory(stack, { client, runDirectory }),
    });
    const report = await coordinator.run(goal, { signal: controller.signal, runId });
    await fs.writeFile(path.join(runDirectory, "result.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(`\n${report.finalAnswer}\n\n状态：${report.status}；累计 token：${report.totalTokens}`);
    if (report.status !== "answered") process.exitCode = report.status === "cancelled" ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    await stack?.mcp.closeAll();
  }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
