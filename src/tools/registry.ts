import { ToolDefinition } from "../core/types";

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  // ✅ 生成 LLM 所需的 tools 参数格式
  toOpenAITools() {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

    async execute(name: string, args: unknown): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    try {
      // ✅ 类型断言：tool.execute 接受 any 参数，由具体工具实现保证正确性
      const result = await (tool.execute as (args: unknown) => Promise<unknown>)(args);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const toolRegistry = new ToolRegistry();