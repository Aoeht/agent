import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new McpServer(
  { name: "logging-fixture", version: "1.0.0" },
  { capabilities: { logging: {} } }
);
server.registerTool("health", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
server.server.setRequestHandler(SetLevelRequestSchema, async () => ({}));
await server.connect(new StdioServerTransport());
setTimeout(() => {
  void server.sendLoggingMessage({
    level: "info",
    logger: "fixture",
    data: { event: "ready" },
  });
}, 100);

setInterval(() => undefined, 1_000);
