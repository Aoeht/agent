// tests/registry.test.ts
import { test, expect } from "bun:test";
import { ToolRegistry } from "../src/core/registry";
import { createSearchWebTool } from "../src/tools/tavily_search";
import type { ToolDefinition } from "../src/core/types";

function makeEchoTool(name: string): ToolDefinition {
  return {
    name,
    description: "echo args back",
    parameters: { type: "object" },
    execute: async (args) => ({ echoed: args }),
  };
}

test("注册表实例之间相互隔离", () => {
  const a = new ToolRegistry();
  const b = new ToolRegistry();
  a.register(makeEchoTool("only_a"));

  expect(a.get("only_a")).toBeDefined();
  expect(b.get("only_a")).toBeUndefined();
});

test("中间件按注册顺序洋葱式包裹：先注册的在最外层", async () => {
  const registry = new ToolRegistry();
  const order: string[] = [];

  registry.use(async (_ctx, next) => {
    order.push("outer-before");
    const result = await next();
    order.push("outer-after");
    return result;
  });
  registry.use(async (_ctx, next) => {
    order.push("inner-before");
    const result = await next();
    order.push("inner-after");
    return result;
  });

  registry.register(makeEchoTool("echo"));
  const result = await registry.execute("echo", { x: 1 });

  expect(order).toEqual(["outer-before", "inner-before", "inner-after", "outer-after"]);
  expect(JSON.parse(result)).toEqual({ echoed: { x: 1 } });
});

test("中间件拿得到工具名与参数（遥测/准入依赖它）", async () => {
  const registry = new ToolRegistry();
  const seen: { name: string; args: unknown }[] = [];
  registry.use(async (ctx, next) => {
    seen.push({ name: ctx.name, args: ctx.args });
    return next();
  });

  registry.register(makeEchoTool("spy_tool"));
  await registry.execute("spy_tool", { secret: 42 });

  expect(seen).toEqual([{ name: "spy_tool", args: { secret: 42 } }]);
});

test("中间件抛错会向上传播（Agent 层负责把它转成 error observation）", async () => {
  const registry = new ToolRegistry();
  registry.use(async (ctx, next) => {
    if (ctx.name === "denied_tool") throw new Error("Policy Denied [denied_tool]");
    return next();
  });

  registry.register(makeEchoTool("denied_tool"));
  registry.register(makeEchoTool("allowed_tool"));

  expect(registry.execute("denied_tool", {})).rejects.toThrow("Policy Denied");
  expect(JSON.parse(await registry.execute("allowed_tool", {}))).toEqual({ echoed: {} });
});

test("未知工具仍然抛错，工具内部异常仍序列化成 error observation", async () => {
  const registry = new ToolRegistry();
  const boom: ToolDefinition = {
    name: "boom",
    description: "always throws",
    parameters: { type: "object" },
    execute: async () => {
      throw new Error("爆炸了");
    },
  };
  registry.register(boom);

  expect(registry.execute("missing_tool", {})).rejects.toThrow("Unknown tool: missing_tool");
  expect(JSON.parse(await registry.execute("boom", {}))).toEqual({ error: "爆炸了" });
});

test("内置工具工厂返回可注册的独立定义", () => {
  const registry = new ToolRegistry();
  const tool = createSearchWebTool();

  expect(tool.name).toBe("search_web");
  expect(tool.parallelSafe).toBe(true);

  registry.register(tool);
  expect(registry.get("search_web")).toBeDefined();
  expect(registry.toOpenAITools().some((t) => t.function.name === "search_web")).toBe(true);
});
