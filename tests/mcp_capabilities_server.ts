// tests/mcp_capabilities_server.ts
// 资源/提示能力测试夹具：一个真实 stdio MCP Server，声明 resources + prompts 能力，
// 提供落在沙箱内 / 越界 / 命中受保护路径 / 非 file:// 四种 URI，用来验证宿主侧守卫。
// 运行：bun run tests/mcp_capabilities_server.ts <沙箱绝对路径>
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const sandbox = path.resolve(process.argv[2] ?? ".");
const outside = path.resolve(sandbox, "..", "outside-sandbox.md");

const server = new McpServer(
  { name: "capabilities-fixture", version: "1.0.0" },
  {
    capabilities: {
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
    },
  }
);

// 至少给一个 tool，否则老宿主只挂 tools 时会拿到空列表
server.registerTool(
  "noop",
  { description: "占位工具", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "ok" }] })
);

server.registerResource(
  "notes",
  pathToFileURL(path.join(sandbox, "notes.md")).href,
  { title: "沙箱笔记", description: "落在白名单内的文件资源", mimeType: "text/markdown" },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# 沙箱笔记\n这是 resources/read 测试内容。" }],
  })
);

server.registerResource(
  "secret",
  pathToFileURL(path.join(sandbox, ".env")).href,
  { title: "凭据", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "API_KEY=super-secret" }] })
);

server.registerResource(
  "outside",
  pathToFileURL(outside).href,
  { title: "越界文件", mimeType: "text/plain" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "不该被读到" }] })
);

server.registerResource(
  "settings",
  "config://app/settings",
  { title: "应用配置", description: "非 file:// 资源，路径守卫无从下手", mimeType: "application/json" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: '{"theme":"dark"}' }] })
);

server.registerResource(
  "dynamic-note",
  new ResourceTemplate("mem://note/{id}", { list: undefined }),
  { title: "动态笔记", mimeType: "text/plain" },
  async (uri, variables) => ({
    contents: [{ uri: uri.href, text: `note#${String(variables.id ?? "?")}` }],
  })
);

server.registerPrompt(
  "summarize",
  {
    title: "摘要",
    description: "把一段文本压成一句话",
    argsSchema: { text: z.string(), tone: z.enum(["formal", "casual"]).optional() },
  },
  ({ text, tone }) => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: `请用${tone ?? "默认"}语气总结：${text}` },
      },
    ],
  })
);

server.registerPrompt(
  "greet",
  { title: "打招呼", description: "零参数模板" },
  () => ({
    messages: [
      { role: "user" as const, content: { type: "text" as const, text: "你好" } },
      { role: "assistant" as const, content: { type: "text" as const, text: "你好，有什么可以帮你？" } },
    ],
  })
);

// McpServer 声明了 resources.subscribe 能力也不会自动挂处理器，
// 与 logging 一样要手动补，否则客户端 subscribeResource 会得到 -32601
server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

await server.connect(new StdioServerTransport());
