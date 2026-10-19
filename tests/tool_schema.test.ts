// tests/tool_schema.test.ts
import { test, expect } from "bun:test";
import { z } from "zod";
import { ToolDefinition, defineTool } from "../src/core/types";
import { ToolRegistry } from "../src/core/registry";

const EchoSchema = z.object({
  text: z.string().trim().min(1).describe("要回显的文本"),
  count: z.number().int().min(1).max(9).default(2).describe("重复次数"),
});

function makeDefinedTool(): ToolDefinition {
  return defineTool({
    name: "echo",
    description: "echo args back",
    schema: EchoSchema,
    execute: async (args) => ({ text: args.text, count: args.count }),
  });
}

test("defineTool 从 Zod 派生 JSON Schema：default 字段不进 required，describe/min/max 保留", () => {
  const params = makeDefinedTool().parameters!;

  expect(params.type).toBe("object");
  expect(params.required).toEqual(["text"]);

  const props = params.properties as Record<string, Record<string, unknown>>;
  expect(props.text!.description).toBe("要回显的文本");
  expect(props.text!.minLength).toBe(1);
  expect(props.count!.default).toBe(2);
  expect(props.count!.maximum).toBe(9);
});

test("经 registry 调用：入参被校验，默认值与 trim 变换生效", async () => {
  const registry = new ToolRegistry();
  registry.register(makeDefinedTool());

  const out = JSON.parse(await registry.execute("echo", { text: "  hi  " }));
  expect(out).toEqual({ text: "hi", count: 2 });
});

test("非法入参转成 error observation，字段级错误信息可直接回给模型", async () => {
  const registry = new ToolRegistry();
  registry.register(makeDefinedTool());

  const out = JSON.parse(await registry.execute("echo", { text: "", count: 99 }));
  expect(out.error).toContain("Invalid arguments for echo");
  expect(out.error).toContain("text");
  expect(out.error).toContain("count");
});

test("直连 tool.execute 与经 registry 调用语义一致（默认值同样生效）", async () => {
  const tool = makeDefinedTool();
  const out = (await tool.execute({ text: "a" })) as { count: number };
  expect(out.count).toBe(2);

  await expect(tool.execute({ text: "" })).rejects.toThrow("Invalid arguments for echo");
});

test("MCP 式工具（只有 parameters、无 schema）不受校验影响；缺 parameters 时派生空对象兜底", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "mcp_like",
    description: "server-side validated",
    parameters: { type: "object", properties: { x: { type: "number" } } },
    execute: async (args) => ({ got: args }),
  });

  // 非法类型的入参原样透传——校验责任在 MCP Server（协议约定），host 不做二次猜测
  const out = JSON.parse(await registry.execute("mcp_like", { x: "not-a-number" }));
  expect(out).toEqual({ got: { x: "not-a-number" } });

  const openaiTool = registry.toOpenAITools().find((t) => t.function.name === "mcp_like");
  expect(openaiTool?.function.parameters).toEqual({
    type: "object",
    properties: { x: { type: "number" } },
  });

  const bare = new ToolRegistry();
  bare.register({ name: "bare", description: "no params", execute: async () => ({ ok: true }) });
  expect(bare.toOpenAITools()[0]!.function.parameters).toEqual({ type: "object", properties: {} });
});
