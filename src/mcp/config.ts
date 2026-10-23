// src/mcp/config.ts
import path from "node:path";
import { McpServerConfig } from "./types";

/**
 * 文件系统类 Server 的唯一可写根目录。
 * 同一份路径既用于启动 server-filesystem，也用于 McpAdapter 的路径守卫白名单，
 * 避免"提示词里说沙箱、实际却放开了 process.cwd()"这种口径不一致。
 */
export const MCP_SANDBOX_DIR = path.resolve(
  process.env.MCP_SANDBOX_DIR ?? path.join(process.cwd(), ".mcp-sandbox")
);

/** 自己的本地 prompts 预设 Server 入口，stdio 方式启动，见 src/prompts/server.ts */
export const LOCAL_PROMPTS_SERVER_PATH = path.resolve(
  process.env.LOCAL_PROMPTS_SERVER_PATH ?? path.join(process.cwd(), "src/prompts/server.ts")
);

export const McpServers: McpServerConfig[] = [
  // 本地文件系统 (stdio 传输)
  // --no-install：只用本地已安装版本，不在运行时联网拉包
  {
    id: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["--no-install", "@modelcontextprotocol/server-filesystem", MCP_SANDBOX_DIR],
    // 同时通过 MCP roots 能力告知 Server 可访问范围，与 adapter 白名单形成双层防护
    roots: [MCP_SANDBOX_DIR],
    requestTimeoutMs: 30_000,
    loggingLevel: "info",
    enabled: true,
  },
  {
    id: "logistics",
    transport: "streamableHttp",
    url: "https://dashscope.aliyuncs.com/api/v1/mcps/market-cmgjmcp00075338/mcp",
    headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY ?? ""}` },
    requestTimeoutMs: 30_000,
    loggingLevel: "info",
    enabled: true,
  },

  // GitHub（未配置 Token 时自动跳过，不会拖垮 Agent 启动）
//   {
//     id: "github",
//     transport: "stdio",
//     command: "npx",
//     args: ["--no-install", "@modelcontextprotocol/server-github"],
//     env: {
//       GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? "",
//     },
//     requestTimeoutMs: 60_000,
//     // allowedTools 可裁剪注入 LLM 的工具数量（名字需与 Server 实际暴露的一致）
//     // allowedTools: ["search_repositories", "get_file_contents", "create_issue"],
//     enabled: Boolean(process.env.GITHUB_TOKEN),
//   },
//   {
//   id: "everything",
//   transport: "stdio",
//   command: "npx",
//   args: ["-y", "@modelcontextprotocol/server-everything"],
//   enabled: true,
// },

  // 自己的本地 prompts 预设 Server（stdio 启动，见 src/prompts/server.ts）
  // 预设内容改了不用重启挂载逻辑，改一次 bun run 生效一次；enabled 设 false 可临时下线
  {
    id: "local_prompts",
    transport: "stdio",
    command: "bun",
    args: ["run", LOCAL_PROMPTS_SERVER_PATH],
    enabled: true,
  },

  // 远程服务：优先 streamableHttp（sse 已被 MCP 规范标记为过时）
  // {
  //   id: "remote_search",
  //   transport: "streamableHttp",
  //   url: "https://mcp-server.example.com/mcp",
  //   headers: { Authorization: `Bearer ${process.env.REMOTE_MCP_KEY ?? ""}` },
  //   connectTimeoutMs: 15_000,
  //   enabled: Boolean(process.env.REMOTE_MCP_KEY),
  // },
];
