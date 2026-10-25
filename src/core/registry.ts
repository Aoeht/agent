// src/core/registry.ts
import { ToolDefinition, ToolRuntime } from "./types";

/** 一次工具调用的上下文，供注册表级中间件读取 */
export interface ToolCallContext {
  name: string;
  args: unknown;
  runtime?: ToolRuntime;
}

/**
 * 注册表级工具中间件：所有工具（内置 + MCP）执行时统一经过，
 * 用于遥测、审计、准入、限流等横切逻辑——内置工具不再游离在 MCP 的管线之外。
 * 先注册的在最外层；抛错即拒绝本次调用（Agent 层负责把异常转成 error observation）。
 */
export type ToolCallMiddleware = (
  context: ToolCallContext,
  next: () => Promise<string>
) => Promise<string>;

/**
 * MCP 工具的注册名固定为 `serverId__toolName`（bootstrap.copyMcpTools 与 MCP adapter
 * 的同一约定），内置工具不含双下划线——按需加载用这条边界区分"可延迟的 MCP 长尾"
 * 与"永远全量加载的第一方工具"。
 */
export function isMcpToolName(name: string): boolean {
  return name.includes("__");
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private middlewares: ToolCallMiddleware[] = [];
  /** 按需加载（tool_search）模式下已激活的 MCP 工具名；只增不减，会话内持续可用 */
  private activatedToolNames = new Set<string>();

  /** replace=true 用于 MCP 工具热更新：同名工具直接覆盖而不是抛错 */
  register(tool: ToolDefinition, options: { replace?: boolean } = {}): void {
    if (this.tools.has(tool.name) && !options.replace) {
      throw new Error(`Tool "${tool.name}" already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** 追加中间件（外层）。链在每次 execute 时快照构建，执行中追加不影响当次调用 */
  use(middleware: ToolCallMiddleware): void {
    this.middlewares.push(middleware);
  }

  /**
   * 激活按需加载的工具：只登记注册表中当前存在的名字，幂等；
   * 返回本次**新**激活的名字（tool_search 的回执用它说明实际生效数）。
   */
  activateTools(names: string[]): string[] {
    const applied: string[] = [];
    for (const name of names) {
      if (this.tools.has(name) && !this.activatedToolNames.has(name)) {
        this.activatedToolNames.add(name);
        applied.push(name);
      }
    }
    return applied;
  }

  /** 该工具是否已被 tool_search 激活（未激活 ≠ 未注册：注册表里可能有，但按需加载下未暴露） */
  isToolActivated(name: string): boolean {
    return this.activatedToolNames.has(name);
  }

  /** 已激活的 MCP 工具名快照（每轮请求组装暴露清单用） */
  activatedToolList(): string[] {
    return [...this.activatedToolNames];
  }

  /** 生成 LLM 所需的 tools 参数格式；无 parameters 的工具按空对象 schema 兜底 */
  toOpenAITools() {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    }));
  }

  async execute(name: string, args: unknown, runtime?: ToolRuntime): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    const context: ToolCallContext = {
      name,
      args,
      ...(runtime !== undefined ? { runtime } : {}),
    };
    const chain = [...this.middlewares].reduceRight<() => Promise<string>>(
      (next, middleware) => () => middleware(context, next),
      () => this.runTool(tool, args, runtime)
    );
    return chain();
  }

  /** 工具执行体：结果/异常统一序列化成 JSON observation（工具错误不抛出） */
  private async runTool(tool: ToolDefinition, args: unknown, runtime?: ToolRuntime): Promise<string> {
    try {
      const result = await tool.execute(args, runtime);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
