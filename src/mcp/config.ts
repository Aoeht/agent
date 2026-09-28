export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
}

export const mcpServers: McpServerConfig[] = [
  {
    id: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
  },
  // 后续需要 GitHub、Postgres 等直接在这里追加
];