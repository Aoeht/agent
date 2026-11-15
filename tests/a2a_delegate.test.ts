// tests/a2a_delegate.test.ts
// a2a_call 工具：白名单解析、围栏回注、schema 层拒绝未配置的 agent 名
import { afterEach, describe, expect, test } from "bun:test";
import { createA2aCallTool, loadA2aAgents } from "../src/tools/a2a_delegate";
import { startA2aTestServer, type A2aTestServer } from "./helpers/a2a_test_server";

describe("a2a_call 工具", () => {
  const servers: A2aTestServer[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  test("loadA2aAgents：合法清单解析；坏 JSON/非数组/缺字段都按空处理", () => {
    expect(loadA2aAgents({ AGENT_A2A_AGENTS: '[{"name":"a","url":"https://x.example"}]' } as NodeJS.ProcessEnv)).toEqual([
      { name: "a", url: "https://x.example" },
    ]);
    expect(loadA2aAgents({ AGENT_A2A_AGENTS: '[{"name":"a","url":"https://x","token":"t"}]' } as NodeJS.ProcessEnv)).toEqual([
      { name: "a", url: "https://x", token: "t" },
    ]);
    expect(loadA2aAgents({ AGENT_A2A_AGENTS: "not json" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(loadA2aAgents({ AGENT_A2A_AGENTS: '{"name":"a"}' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(loadA2aAgents({ AGENT_A2A_AGENTS: '[{"name":"","url":"https://x"}]' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(loadA2aAgents({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  test("流式对端：answer 带围栏与出处；state/taskId/contextId 结构化返回", async () => {
    const server = startA2aTestServer({ answer: "远端结论" });
    servers.push(server);
    const tool = createA2aCallTool({ agents: [{ name: "weather", url: server.url }] });
    const result = (await tool.execute({ agent: "weather", message: "查天气" })) as {
      agent: string; state: string; taskId: string; contextId: string; answer: string;
    };
    expect(result.agent).toBe("weather");
    expect(result.state).toBe("TASK_STATE_COMPLETED");
    expect(result.taskId).not.toBe("");
    expect(result.contextId).not.toBe("");
    // 围栏是硬性的：远端正文必须以不可信数据形式进入上下文
    expect(result.answer).toContain("【不可信外部数据");
    expect(result.answer).toContain("远端 Agent「weather」");
    // 流式对端的产物是它自己 echo 出来的文本
    expect(result.answer).toContain("回声：查天气");
  });

  test("非流式对端走阻塞路径，结果一致", async () => {
    const server = startA2aTestServer({ answer: "阻塞答案", streaming: false });
    servers.push(server);
    const tool = createA2aCallTool({ agents: [{ name: "plain", url: server.url }] });
    const result = (await tool.execute({ agent: "plain", message: "任务" })) as { state: string; answer: string };
    expect(result.state).toBe("TASK_STATE_COMPLETED");
    expect(result.answer).toContain("阻塞答案");
  });

  test("未配置的 agent 名被 schema 拒绝（模型不能自选地址）", async () => {
    const server = startA2aTestServer();
    servers.push(server);
    const tool = createA2aCallTool({ agents: [{ name: "known", url: server.url }] });
    let message = "";
    try {
      await tool.execute({ agent: "evil-unknown", message: "x" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Invalid arguments for a2a_call");
  });

  test("cancelTaskId 路径返回结构化状态（不让模型用自然语言劝停对端）", async () => {
    const server = startA2aTestServer();
    servers.push(server);
    const tool = createA2aCallTool({ agents: [{ name: "weather", url: server.url }] });
    // 测试双端没有 CancelTask 分支 → 返回 -32601，unwrap 翻成 A2aError
    let errored = false;
    try {
      await tool.execute({ agent: "weather", message: "x", cancelTaskId: "task-1" });
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });
});
