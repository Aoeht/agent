// tests/scanner_registry.test.ts
// scanner 子代理：白名单注册表、专属提示词（流程/判定纪律/报告 schema）、墙钟放宽
// 运行: bun test ./tests/scanner_registry.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { defineTool } from "../src/core/types";
import { createDelegateTaskTool, loadScannerBudget, resolveDelegateBudget, type DelegateTaskToolOptions } from "../src/tools/delegate_task";
import { createScannerRegistry } from "../src/team_runtime";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function fakeTool(name: string) {
  return defineTool({
    name,
    description: `${name} 假工具`,
    schema: z.object({}),
    parallelSafe: true,
    execute: async () => "结果",
  });
}

function sourceRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fakeTool("bili_collect"));
  registry.register(fakeTool("inspect_link"));
  registry.register(fakeTool("rag_search"));
  registry.register(fakeTool("ingest_findings"));
  registry.register(fakeTool("search_web"));
  registry.register(fakeTool("run_script"));
  return registry;
}

/** 与 delegate_task.test.ts 同款的假 client：记录请求、按脚本应答 */
function fakeClient(reply: (index: number) => { content: string; toolCalls?: Array<{ id: string; name: string }>; usage?: any }) {
  const requests: any[] = [];
  const client: any = {
    chat: {
      completions: {
        create: async (params: any) => {
          requests.push(params);
          const { content, toolCalls, usage } = reply(requests.length);
          return {
            choices: [{
              message: {
                content,
                ...(toolCalls
                  ? { tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: "{}" } })) }
                  : {}),
              },
              finish_reason: toolCalls ? "tool_calls" : "stop",
            }],
            usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          };
        },
      },
    },
  };
  return { client, requests };
}

test("createScannerRegistry：扫描白名单在，调研外工具与写类工具不在", () => {
  const registry = createScannerRegistry(sourceRegistry(), new PlanStore());
  for (const name of ["bili_collect", "inspect_link", "rag_search", "ingest_findings", "update_plan", "read_task_state"]) {
    expect(registry.get(name)).toBeDefined();
  }
  expect(registry.get("run_script")).toBeUndefined();
  expect(registry.get("search_web")).toBeUndefined();
  expect(registry.get("delegate_task")).toBeUndefined();
});

test("scanner 委派：专属提示词、扫描白名单、报告围栏", async () => {
  const dir = await tempDir("scanner-delegate-");
  const { client, requests } = fakeClient(() => ({
    content: "结论：低风险，无引流与套路话术。\n```json\n{\"bvid\":\"BV1AbCdEfGh2\",\"risk_level\":\"low\",\"confidence\":0.7}\n```",
  }));
  const tool = createDelegateTaskTool({
    sourceRegistry: sourceRegistry(), config: { model: "m" }, sandboxRoot: dir,
    traceDir: path.join(dir, "delegates"), client,
  });

  const observation = (await tool.execute({ goal: "扫描 BV1AbCdEfGh2 的诈骗风险", role: "scanner" })) as string;

  const childRequest = requests[0]!;
  const systemPrompt = childRequest.messages[0].content as string;
  expect(systemPrompt).toContain("诈骗风险扫描");
  expect(systemPrompt).toContain("采证≠终判");
  expect(systemPrompt).toContain("ingest_findings");
  expect(systemPrompt).toContain("risk_level");
  const childTools = childRequest.tools.map((t: any) => t.function.name) as string[];
  expect(childTools).toContain("bili_collect");
  expect(childTools).toContain("inspect_link");
  expect(childTools).not.toContain("search_web");
  expect(childTools).not.toContain("run_script");
  expect(childTools).not.toContain("delegate_task");

  expect(observation).toContain("scanner");
  expect(observation).toContain("低风险");
  expect(observation).toContain("UNTRUSTED_MCP_DATA");
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadScannerBudget：默认放宽 600s，环境变量覆盖，已更宽不收窄", () => {
  const base = { maxTotalTokens: 80_000, maxToolCalls: 30, maxWallClockMs: 300_000 };
  expect(loadScannerBudget(base, {}).maxWallClockMs).toBe(600_000);
  expect(loadScannerBudget(base, { AGENT_DELEGATE_SCANNER_TIMEOUT_MS: "700" }).maxWallClockMs).toBe(700);
  expect(loadScannerBudget(base, { AGENT_DELEGATE_SCANNER_TIMEOUT_MS: "abc" }).maxWallClockMs).toBe(600_000);
  expect(loadScannerBudget({ ...base, maxWallClockMs: 900_000 }, {}).maxWallClockMs).toBe(900_000);
  // 其余预算字段原样继承
  const widened = loadScannerBudget(base, {});
  expect(widened.maxTotalTokens).toBe(80_000);
  expect(widened.maxToolCalls).toBe(30);
});

test("resolveDelegateBudget：显式预算原样尊重；默认预算下 scanner 放宽墙钟", () => {
  const opts = (budget?: DelegateTaskToolOptions["budget"]): DelegateTaskToolOptions => ({
    sourceRegistry: sourceRegistry(), config: { model: "m" }, sandboxRoot: "/tmp",
    ...(budget ? { budget } : {}),
  });
  const explicit: DelegateTaskToolOptions["budget"] = { maxTotalTokens: 100, maxToolCalls: 2, maxWallClockMs: 5_000 };
  // 显式注入（测试/调用方）：任何角色都原样尊重
  expect(resolveDelegateBudget("scanner", opts(explicit))).toBe(explicit);
  expect(resolveDelegateBudget("researcher", opts(explicit))).toBe(explicit);
  // 默认预算：scanner 墙钟放宽到 600s，researcher 保持 300s
  expect(resolveDelegateBudget("scanner", opts()).maxWallClockMs).toBe(600_000);
  expect(resolveDelegateBudget("researcher", opts()).maxWallClockMs).toBe(300_000);
});
