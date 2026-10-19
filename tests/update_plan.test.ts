// tests/update_plan.test.ts
// "先规划再执行"（路线 B：Plan-as-Tool）链路测试：
//   - update_plan 工具：schema 校验、状态机约束（至多一个 in_progress）、全量替换进仓
//   - PlanStore：dirty 标记一次性消费、快照拷贝、reset
//   - Agent 集成：plan_update 事件、计划块下一轮请求可见、不入会话历史、跨 run 清场
//   - ContextManager：计划块替换钉住前缀后，新计划钉在 system 后、旧计划降级为普通对话
// 运行: bun test ./tests/update_plan.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { ContextManager } from "../src/core/context_manager";
import { SessionStore } from "../src/core/session_store";
import { PlanStore, formatPlanCli } from "../src/core/plan_store";
import { createUpdatePlanTool } from "../src/tools/update_plan";
import type { Message } from "../src/core/types";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

describe("update_plan 工具", () => {
  test("缺省状态补 pending，全量替换进仓，回执带进度概要", async () => {
    const store = new PlanStore();
    const tool = createUpdatePlanTool(store);
    const result = (await tool.execute({
      steps: [{ content: "查资料" }, { content: "写结论", status: "in_progress" }],
    })) as any;

    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.completed).toBe(0);
    expect(result.progress).toBe("0/2");
    expect(result.current).toBe("写结论");
    expect(store.getSteps()).toEqual([
      { content: "查资料", status: "pending" },
      { content: "写结论", status: "in_progress" },
    ]);
  });

  test("多于一个 in_progress 报错且不落仓", async () => {
    const store = new PlanStore();
    const tool = createUpdatePlanTool(store);
    await expect(
      tool.execute({
        steps: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      })
    ).rejects.toThrow("至多一个步骤");
    expect(store.isEmpty).toBe(true);
  });

  test("空清单与缺失 content 被 schema 拒绝", async () => {
    const tool = createUpdatePlanTool(new PlanStore());
    await expect(tool.execute({ steps: [] })).rejects.toThrow("steps");
    await expect(tool.execute({ steps: [{ status: "pending" }] })).rejects.toThrow("content");
  });

  test("写共享状态不允许与同批工具并发", () => {
    expect(createUpdatePlanTool(new PlanStore()).parallelSafe).toBe(false);
  });
});

describe("PlanStore", () => {
  test("dirty 标记一次性消费，getSteps 返回拷贝，reset 清场", () => {
    const store = new PlanStore();
    expect(store.isEmpty).toBe(true);
    expect(store.consumeDirty()).toBe(false); // 从未写入过

    store.replace([{ content: "一步", status: "pending" }]);
    expect(store.consumeDirty()).toBe(true);
    expect(store.consumeDirty()).toBe(false); // 只消费一次

    const snapshot = store.getSteps();
    snapshot[0]!.status = "completed";
    expect(store.getSteps()[0]!.status).toBe("pending"); // 仓内状态不受快照修改影响

    store.reset();
    expect(store.isEmpty).toBe(true);
    expect(store.consumeDirty()).toBe(false);
  });

  test("renderForContext 带标题、进度与状态标注", () => {
    const store = new PlanStore();
    store.replace([
      { content: "查资料", status: "completed" },
      { content: "写结论", status: "in_progress" },
      { content: "校对", status: "pending" },
    ]);
    const text = store.renderForContext();
    expect(text).toContain("【当前任务计划】");
    expect(text).toContain("1/3");
    expect(text).toContain("1. [已完成] 查资料");
    expect(text).toContain("2. [进行中] 写结论");
    expect(text).toContain("3. [待执行] 校对");
  });

  test("formatPlanCli 给终端渲染勾选列表", () => {
    const text = formatPlanCli([
      { content: "查资料", status: "completed" },
      { content: "写结论", status: "in_progress" },
      { content: "校对", status: "pending" },
    ]);
    expect(text).toContain("📋 任务计划 1/3");
    expect(text).toContain("✅ 1. 查资料");
    expect(text).toContain("▶️ 2. 写结论");
    expect(text).toContain("⬜ 3. 校对");
  });
});

describe("Agent 集成", () => {
  /** 第一轮响应调 update_plan（steps 为 null 时直接给最终回答），之后给最终回答；记录每次请求供断言 */
  function makePlanAgent(steps: unknown) {
    const planStore = new PlanStore();
    const tools = new ToolRegistry();
    tools.register(createUpdatePlanTool(planStore));
    const requests: any[] = [];
    const client = {
      chat: {
        completions: {
          create: async (request: any) => {
            requests.push(request);
            if (steps !== null && requests.length === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "p1",
                          type: "function",
                          function: { name: "update_plan", arguments: JSON.stringify(steps) },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            return {
              choices: [{ message: { content: "任务完成，最终结论。" } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          },
        },
      },
    };
    return { planStore, tools, client, requests };
  }

  test("计划块下一轮请求可见，plan_update 事件广播，且不落入会话历史", async () => {
    const dir = await tempDir("dsh-plan-");
    const { planStore, tools, client, requests } = makePlanAgent({
      steps: [{ content: "查资料" }, { content: "写结论", status: "in_progress" }],
    });
    const store = new SessionStore({ dir, sessionId: "t" });
    const agent = new Agent({
      model: "m",
      systemPrompt: "test",
      client: client as any,
      tools,
      planStore,
      sessionStore: store,
    });

    const events: any[] = [];
    agent.events.on("plan_update", (e) => events.push(e));
    const result = await agent.run("做个多步任务");

    expect(events).toHaveLength(1);
    expect(events[0].steps).toEqual([
      { content: "查资料", status: "pending" },
      { content: "写结论", status: "in_progress" },
    ]);

    // 第二轮请求（模型实际收到的 messages）能看到刚注入的计划块
    const secondRequestText = JSON.stringify(requests[1]!.messages);
    expect(secondRequestText).toContain("【当前任务计划】");
    expect(secondRequestText).toContain("查资料");
    expect(secondRequestText).toContain("[进行中] 写结论");

    // 计划块进了本次 run 的消息序列（与事件一致）
    expect(JSON.stringify(result.messages)).toContain("【当前任务计划】");

    // 但不落入跨轮会话历史：历史只有用户输入与最终回答
    const persisted = await store.load();
    const persistedText = JSON.stringify(persisted.messages);
    expect(persistedText).not.toContain("【当前任务计划】");
    expect(persistedText).toContain("做个多步任务");
    expect(persistedText).toContain("任务完成，最终结论。");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("run 开始清场：上一任务的计划不带入新 run", async () => {
    // 模型不再调 update_plan（steps 传 null），仓里的残留只能来自上一任务
    const { planStore, client } = makePlanAgent(null);
    const agent = new Agent({ model: "m", systemPrompt: "test", client: client as any, planStore });
    planStore.replace([{ content: "上一任务步骤", status: "completed" }]);

    await agent.run("新任务");
    expect(planStore.isEmpty).toBe(true);
  });

  test("强制收尾返回空内容时，摘掉工具重试一次拿到最终答案", async () => {
    const tools = new ToolRegistry();
    tools.register(
      createUpdatePlanTool(new PlanStore())
    );
    const requests: any[] = [];
    const client = {
      chat: {
        completions: {
          create: async (request: any) => {
            requests.push(request);
            // 主循环第一轮：调一次工具，耗尽 maxIterations=1
            if (requests.length === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        { id: "t1", type: "function", function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ content: "一步" }] }) } },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            // 带工具的收尾（tool_choice:"none"）：模拟 provider 忽略它/推理耗尽，返回空内容
            if (request.tool_choice === "none") {
              return { choices: [{ message: { content: null } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
            }
            // 摘掉工具的重试：只能给文本
            return { choices: [{ message: { content: "兜底最终回答" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
          },
        },
      },
    };
    const agent = new Agent({
      model: "m",
      systemPrompt: "test",
      client: client as any,
      tools,
      maxIterations: 1,
    });
    const result = await agent.run("多步任务");
    expect(result.success).toBe(true);
    expect(result.finalAnswer).toBe("兜底最终回答");
    // 第一次收尾带工具 + tool_choice:"none"，重试不带工具
    expect(requests[1]!.tool_choice).toBe("none");
    expect(requests[2]!.tools).toBeUndefined();
  });
});

describe("ContextManager：计划块与钉住前缀", () => {
  function makeManager(client: any, compressThreshold: number): ContextManager {
    return new ContextManager({
      modelName: "glm-4.6",
      maxTokens: 128000,
      compressThreshold,
      reserveTokens: 100,
      summaryModel: "summary-test",
      client,
    });
  }

  function summaryClient(): any {
    return {
      chat: {
        completions: {
          create: async (params: any) => {
            if (!params.tools) {
              return {
                choices: [{ message: { content: "## 任务与目标\n测试摘要内容" } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            return { choices: [{ message: { content: "好的" } }], usage: { total_tokens: 2 } };
          },
        },
      },
    };
  }

  function textOf(message: Message | undefined): string {
    if (!message) return "";
    return typeof message.content === "string" ? message.content : "";
  }

  function longText(prefix: string, lines: number): string {
    return Array.from(
      { length: lines },
      (_, i) => `${prefix}第${i}行：不同的内容片段 ${i * 7} 与补充说明${i}。`
    ).join("");
  }

  function planBlock(text: string): Message[] {
    return [
      { role: "user", content: text },
      { role: "assistant", content: "收到，我已了解当前任务计划，将按计划推进并保持各步状态更新。" },
    ];
  }

  test("压缩路径下计划块钉在 system 之后，永不折叠", async () => {
    const cm = makeManager(summaryClient(), 500);
    const longTerm: Message[] = [
      { role: "user", content: "【长期记忆摘要】用户偏好简洁。" },
      { role: "assistant", content: "收到，我已了解以上长期记忆摘要。" },
    ];
    const planV1 = planBlock("【当前任务计划】1. [待执行] 旧步骤");

    cm.setPinnedPrefix([...longTerm, ...planV1]);
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      ...longTerm,
      ...planV1,
      { role: "user", content: longText("第一问：背景资料", 120) },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "t1", content: longText("抓取正文", 80) },
    ];
    const first = await cm.compress(messages);
    // 钉住前缀按传入顺序排在 system 之后：长期摘要块在前，计划块随后，压缩不折叠
    expect(textOf(first[1])).toContain("【长期记忆摘要】");
    expect(textOf(first[3])).toContain("【当前任务计划】");
    expect(textOf(first[3])).toContain("旧步骤");
  });

  test("计划更新后新计划接管钉住位置，旧计划降级为普通对话", async () => {
    const cm = makeManager(summaryClient(), 500);
    const planV1 = planBlock("【当前任务计划】1. [待执行] 旧步骤");

    cm.setPinnedPrefix([...planV1]);
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      ...planV1,
      { role: "user", content: longText("第一问：背景资料", 120) },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "t1", content: longText("抓取正文", 80) },
    ];
    await cm.compress(messages);

    // 模型更新计划：v1 解钉（此后按普通对话参与折叠），v2 接管钉住前缀
    const planV2 = planBlock("【当前任务计划】1. [已完成] 旧步骤\n2. [进行中] 新步骤");
    cm.setPinnedPrefix([...planV2]);
    const messages2: Message[] = [...messages, { role: "user", content: "第二问：继续" }, ...planV2];
    const second = await cm.compress(messages2);

    const joined = second.map(textOf).join("|");
    expect(joined).toContain("新步骤"); // 最新计划在场
    expect(textOf(second[1])).toContain("新步骤"); // 且钉在 system 之后（旧计划没占住这个位置）
  });
});
