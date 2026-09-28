// src/mcp/client_manager.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerMcpTools } from "./adapter";

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
function cleanEnv(env: NodeJS.ProcessEnv, customEnv?: Record<string, string>): Record<string, string> {
  const merged = { ...env, ...customEnv };
  return Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}
export class McpClientManager {
  private transports: StdioClientTransport[] = [];
  private clients: Client[] = [];

  /**
   * 启动并连接单个 MCP Server，自动注册其所有 Tools 到 registry
   */
  async addServer(config: McpServerConfig) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: cleanEnv(process.env, config.env),
    });

    const client = new Client(
      { name: `agent-host-${config.id}`, version: "1.0.0" },
      { capabilities: { sampling: {
        tools: {},

      } } }
    );

    await client.connect(transport);
    this.transports.push(transport);
    this.clients.push(client);

    // 自动适配并注册到 toolRegistry
    await registerMcpTools(client);
    console.log(`[MCP] Server connected: ${config.id}`);
  }

  /**
   * 释放所有 MCP 子进程，避免僵尸进程
   */
  async closeAll() {
    for (const transport of this.transports) {
      await transport.close();
    }
    this.transports = [];
    this.clients = [];
  }
}

export const mcpManager = new McpClientManager();