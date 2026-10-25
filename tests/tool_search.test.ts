import { describe, expect, test } from "bun:test";
import { Agent } from "../src/core/agent";
import { ToolRegistry, isMcpToolName } from "../src/core/registry";
import { TOOL_SEARCH_TOOL_NAME, createToolSearchTool } from "../src/core/tool_search";
import { defineTool } from "../src/core/types";

describe("isMcpToolName / 激活集", () => {
  test("双下划线约定区分 MCP 与第一方", () => {
    expect(isMcpToolName("filesystem__read_text_file")).toBe(true);
    expect(isMcpToolName("tool_search")).toBe(false);
    expect(isMcpToolName("run_script")).toBe(false);
  });

  test("activateTools 幂等、忽略未注册名字、返回本次新激活", () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: "fake__alpha", description: "a", schema: (require("zod") as typeof import("zod")).z.object({}),
      execute: async () => ({}),
    }));
    expect(registry.activateTools(["fake__alpha", "fake__missing"])).toEqual(["fake__alpha"]);
    expect(registry.activateTools(["fake__alpha"])).toEqual([]);
    expect(registry.isToolActivated("fake__alpha")).toBe(true);
    expect(registry.isToolActivated("fake__missing")).toBe(false);
    expect(registry.activatedToolList()).toEqual(["fake__alpha"]);
  });
});

describe("tool_search 元工具", () => {
  function mcpRegistry() {
    const registry = new ToolRegistry();
    registry.register(createToolSearchTool({ registry }));
    registry.register(defineTool({
      name: "alpha__web_search", description: "联网搜索网页内容与新闻",
      schema: (require("zod") as typeof import("zod")).z.object({}), execute: async () => "web",
    }));
    registry.register(defineTool({
      name: "beta__db_query", description: "查询本地数据库表格",
      schema: (require("zod") as typeof import("zod")).z.object({}), execute: async () => "db",
    }));
    return registry;
  }

  test("关键词命中并激活，下一轮注册表可见", async () => {
    const registry = mcpRegistry();
    const result = JSON.parse(await registry.execute(TOOL_SEARCH_TOOL_NAME, { query: "网页" })!) as {
      matches: Array<{ name: string }>;
      note: string;
    };
    expect(result.matches.map((m) => m.name)).toEqual(["alpha__web_search"]);
    expect(result.note).toContain("已激活 1 个工具");
    expect(registry.isToolActivated("alpha__web_search")).toBe(true);
  });

  test("非法正则不崩溃，回退为字面子串匹配；普通关键词正常命中", async () => {
    const registry = mcpRegistry();
    // "web_search(" 不是合法正则 → 回退为字面子串 "web_search("，名字里没有这个字面量，优雅返回空
    const invalid = JSON.parse(await registry.execute(TOOL_SEARCH_TOOL_NAME, { query: "web_search(" })!);
    expect(invalid.matches).toEqual([]);
    expect(invalid.note).toContain("没有匹配的工具");
    // 普通关键词（合法正则）按预期命中
    const keyword = JSON.parse(await registry.execute(TOOL_SEARCH_TOOL_NAME, { query: "数据库" })!);
    expect((keyword.matches as Array<{ name: string }>).map((m) => m.name)).toEqual(["beta__db_query"]);
  });

  test("limit 截断与空池提示", async () => {
    const registry = mcpRegistry();
    const limited = JSON.parse(await registry.execute(TOOL_SEARCH_TOOL_NAME, { query: "__", limit: 1 })!);
    expect((limited.matches as unknown[]).length).toBe(1);

    const empty = new ToolRegistry();
    empty.register(createToolSearchTool({ registry: empty }));
    const result = JSON.parse(await empty.execute(TOOL_SEARCH_TOOL_NAME, { query: "任意" })!);
    expect(result.note).toContain("没有可检索的工具");
  });
});

// ---------- Agent 级：暴露计算、激活流转、未激活守卫 ----------

const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
function toolCallReply(name: string, args: string, extra = {}) {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: args } }], ...extra },
    }],
    usage,
  };
}
function reply(content: string) {
  return { choices: [{ finish_reason: "stop", message: { content } }], usage };
}

function setup(script: unknown[], config: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  let requests = 0;
  const payloads: any[] = [];
  const client = { chat: { completions: { create: async (request: unknown) => {
    payloads.push(request);
    const item = script[requests++];
    if (item === undefined) throw new Error("Unexpected model request");
    return item;
  } } } };
  return { agent: new Agent({ model: "test", systemPrompt: "test", maxRetries: 0, ...config, client: client as any }), payloads };
}

function populatedRegistry(executed: { ran: boolean }) {
  const registry = new ToolRegistry();
  registry.register(createToolSearchTool({ registry }));
  registry.register(defineTool({
    name: "inspect", description: "第一方工具", schema: (require("zod") as typeof import("zod")).z.object({}),
    execute: async () => "inspected",
  }));
  registry.register(defineTool({
    name: "fake__web_search", description: "联网搜索网页内容与新闻",
    schema: (require("zod") as typeof import("zod")).z.object({}),
    execute: async () => { executed.ran = true; return "web result"; },
  }));
  registry.register(defineTool({
    name: "fake__db_query", description: "查询本地数据库表格",
    schema: (require("zod") as typeof import("zod")).z.object({}),
    execute: async () => { executed.ran = true; return "db result"; },
  }));
  return registry;
}

function toolNames(payload: { tools?: Array<{ function: { name: string } }> }): string[] {
  return (payload.tools ?? []).map((tool) => tool.function.name);
}

describe("Agent 按需加载暴露", () => {
  test("on 模式：MCP 工具不暴露，tool_search 暴露；检索激活后下一轮可见可调", async () => {
    const executed = { ran: false };
    const registry = populatedRegistry(executed);
    const { agent, payloads } = setup([
      toolCallReply(TOOL_SEARCH_TOOL_NAME, '{"query":"网页"}'),
      toolCallReply("fake__web_search", "{}"),
      reply("done"),
    ], { tools: registry, toolSearch: "on" });
    await agent.run("hi");

    expect(toolNames(payloads[0])).toEqual(["tool_search", "inspect"]);
    // 激活发生在第一轮 tool_search 之后：第二轮请求带上已激活的 MCP 工具
    expect(toolNames(payloads[1])).toContain("fake__web_search");
    expect(toolNames(payloads[1])).toContain("inspect");
    expect(executed.ran).toBe(true);
  });

  test("auto 模式：schema 未超阈值不切换（tool_search 不暴露，MCP 全量）", async () => {
    const registry = populatedRegistry({ ran: false });
    const { agent, payloads } = setup([reply("done")], { tools: registry });
    await agent.run("hi");
    const names = toolNames(payloads[0]);
    expect(names).toContain("fake__web_search");
    expect(names).not.toContain(TOOL_SEARCH_TOOL_NAME);
  });

  test("auto 模式：schema 超过上下文 10% 自动切换", async () => {
    const registry = new ToolRegistry();
    registry.register(createToolSearchTool({ registry }));
    registry.register(defineTool({
      name: "fake__huge", description: `超大工具描述。${"工具能力说明。".repeat(1500)}`,
      schema: (require("zod") as typeof import("zod")).z.object({}), execute: async () => "ok",
    }));
    const { agent, payloads } = setup([reply("done")], { tools: registry, contextWindow: 20_000 });
    await agent.run("hi");
    const names = toolNames(payloads[0]);
    expect(names).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(names).not.toContain("fake__huge");
  });

  test("未激活的 MCP 工具调用被拦截并回传协议提示，不执行", async () => {
    const executed = { ran: false };
    const registry = populatedRegistry(executed);
    const { agent, payloads } = setup([
      toolCallReply("fake__db_query", "{}"),
      reply("done"),
    ], { tools: registry, toolSearch: "on" });
    await agent.run("hi");

    expect(executed.ran).toBe(false);
    const toolMessage = payloads[1].messages.find(
      (m: { role: string }) => m.role === "tool"
    );
    expect(String(toolMessage?.content)).toContain("未加载");
    expect(String(toolMessage?.content)).toContain("tool_search");
  });
});
