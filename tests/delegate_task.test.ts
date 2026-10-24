// tests/delegate_task.test.ts
// 主对话内的子 Agent 委派工具：
//   - 注册：registerSessionTools 传 config 才注册
//   - 子代理工具集是只读白名单且不含 delegate_task（无递归）
//   - goal 自包含进入子代理、报告套不可信围栏回注、token 记入观察头
//   - 预算越线：强制收尾后仍带回（可能不完整的）结果并标注
//   - 委派前已取消：不抛错，观察里说明被取消
//   - 轨迹落盘到委派目录
// 运行: bun test ./tests/delegate_task.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { defineTool } from "../src/core/types";
import { registerSessionTools } from "../src/bootstrap";
import { createDelegateTaskTool, loadDelegateBudget } from "../src/tools/delegate_task";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

const HOST_SANDBOX = { backend: "host", reason: "test" } as const;

function registryWith(config?: { model: string }): ToolRegistry {
  const registry = new ToolRegistry();
  registerSessionTools(registry, {
    skills: [], planStore: new PlanStore(), sandbox: HOST_SANDBOX, ...(config ? { config } : {}),
  });
  return registry;
}

/** 注入子代理的假 client：记录收到的请求，按脚本应答（可返回工具调用或终答） */
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

function sourceRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "search_web", description: "只读检索", schema: z.object({}),
    parallelSafe: true, execute: async () => "结果",
  }));
  registry.register(defineTool({
    name: "run_script", description: "写操作（子代理不该有）", schema: z.object({}),
    execute: async () => "done",
  }));
  return registry;
}

test("registerSessionTools 传 config 才注册 delegate_task", () => {
  expect(registryWith({ model: "m" }).get("delegate_task")).toBeDefined();
  expect(registryWith().get("delegate_task")).toBeUndefined();
});

test("loadDelegateBudget 读环境变量，非法值回退默认", () => {
  expect(loadDelegateBudget({})).toEqual({ maxTotalTokens: 80_000, maxToolCalls: 30, maxWallClockMs: 300_000 });
  expect(loadDelegateBudget({ AGENT_DELEGATE_TOKENS: "1234", AGENT_DELEGATE_TIMEOUT_MS: "9" }).maxTotalTokens).toBe(1234);
  expect(loadDelegateBudget({ AGENT_DELEGATE_TOKENS: "abc" }).maxTotalTokens).toBe(80_000);
});

test("委派：goal 进子代理、白名单防递归、报告套围栏、token 记入观察头", async () => {
  const dir = await tempDir("dsh-delegate-run-");
  const source = sourceRegistry();
  const { client, requests } = fakeClient(() => ({ content: "调研结论：A 与 B 相关（见 https://example.test/a）。" }));
  const tool = createDelegateTaskTool({
    sourceRegistry: source, config: { model: "glm-4.6" }, sandboxRoot: dir,
    traceDir: path.join(dir, "delegates"), client,
  });

  const observation = (await tool.execute({ goal: "查清 A 与 B 的关系", role: "researcher" })) as string;

  // 子代理收到了自包含任务与角色提示词
  const childRequest = requests[0]!;
  expect(childRequest.messages.at(-1).content).toContain("委派任务：\n查清 A 与 B 的关系");
  expect(childRequest.messages[0].content).toContain("researcher 子 Agent");
  // 白名单：只读工具在、写操作不在、delegate_task 自身不在（无递归）
  const childTools = childRequest.tools.map((t: any) => t.function.name) as string[];
  expect(childTools).toContain("search_web");
  expect(childTools).not.toContain("run_script");
  expect(childTools).not.toContain("delegate_task");
  // 观察头 + 围栏报告
  expect(observation).toContain("委派完成：researcher（answer");
  expect(observation).toContain("15 tokens");
  expect(observation).toContain("子代理报告");
  expect(observation).toContain("UNTRUSTED_MCP_DATA");
  expect(observation).toContain("调研结论");
  // 轨迹落盘
  const traces = await fs.readdir(path.join(dir, "delegates"));
  expect(traces.length).toBeGreaterThan(0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("预算越线：强制收尾带回结果并标注不完全成功", async () => {
  const dir = await tempDir("dsh-delegate-budget-");
  // 第 1 次调工具（进入工作循环），预算在下一轮循环顶越线 → 强制收尾的第 2 次调用给终答
  const { client } = fakeClient((index) => index === 1
    ? { content: "", toolCalls: [{ id: "t1", name: "search_web" }] }
    : { content: "尽力而为的部分结论" });
  const tool = createDelegateTaskTool({
    sourceRegistry: sourceRegistry(), config: { model: "glm-4.6" }, sandboxRoot: dir,
    client, budget: { maxTotalTokens: 5, maxToolCalls: 1, maxWallClockMs: 60_000 },
  });
  const observation = (await tool.execute({ goal: "随便查点", role: "analyst" })) as string;
  expect(observation).toContain("未能完全成功");
  expect(observation).toContain("尽力而为的部分结论");
  await fs.rm(dir, { recursive: true, force: true });
});

test("委派前已取消：不抛错并说明", async () => {
  const dir = await tempDir("dsh-delegate-abort-");
  const { client, requests } = fakeClient(() => ({ content: "不该被调用" }));
  const tool = createDelegateTaskTool({
    sourceRegistry: sourceRegistry(), config: { model: "glm-4.6" }, sandboxRoot: dir, client,
  });
  const controller = new AbortController();
  controller.abort();
  const observation = (await tool.execute({ goal: "任务", role: "reviewer" }, { signal: controller.signal })) as string;
  expect(observation).toContain("已被用户取消");
  expect(requests.length).toBe(0); // 取消发生在任何 LLM 调用之前
  await fs.rm(dir, { recursive: true, force: true });
});
