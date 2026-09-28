// src/mcp/adapter.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { toolRegistry } from "../tools/registry";
import { ToolDefinition } from "../core/types";

// 定义文本内容块的基本接口
interface McpTextContent {
  type: "text";
  text: string;
}

// 辅助函数：安全地从 response.content (unknown) 中提取纯文本数组
function extractTextContents(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter((item: unknown): item is McpTextContent => {
      return (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item as { type: unknown }).type === "text" &&
        "text" in item &&
        typeof (item as { text: unknown }).text === "string"
      );
    })
    .map((item) => item.text);
}

/**
 * 将单个 MCP Client 暴露的工具全部注册进本地的 toolRegistry
 */
export async function registerMcpTools(client: Client, serverPrefix?: string) {
  // 1. 从 MCP Server 拉取可用工具
  const { tools } = await client.listTools();

  for (const mcpTool of tools) {
    const toolName = serverPrefix ? `${serverPrefix}_${mcpTool.name}` : mcpTool.name;

    // 2. 构造符合你项目规范的 ToolDefinition
    const definition: ToolDefinition = {
      name: toolName,
      description: mcpTool.description ?? "",
      parameters: mcpTool.inputSchema as Record<string, unknown>,

      // 3. 桥接执行
      execute: async (args: unknown) => {
        const response = await client.callTool({
          name: mcpTool.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });

        // ✅ 安全解析文本内容
        const textResults = extractTextContents(response.content);

        // 如果 MCP 服务端标明了错误，直接抛出
        if (response.isError) {
          const errText = textResults.join("\n");
          throw new Error(`MCP Error: ${errText || "Unknown MCP tool execution error"}`);
        }

        // 如果只有单条文本结果，优先尝试解析 JSON（避免被外层 stringify 二次转义）
        if (textResults.length === 1) {
          try {
            return JSON.parse(textResults[0]!);
          } catch {
            return textResults[0];
          }
        }

        return textResults;
      },
    };

    // 4. 注册进 registry
    toolRegistry.register(definition);
    console.log(`[MCP] Tool registered: ${toolName}`);
  }
}