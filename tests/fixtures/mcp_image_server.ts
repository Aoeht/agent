import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Importing the test image must not start an MCP server.
if (import.meta.main) {
  const server = new McpServer({ name: "p2-image-fixture", version: "1.0.0" });
  server.registerTool("capture", {
    description: "Return a fixed local 1x1 PNG",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({ content: [
    { type: "text", text: "stdio-fixed-png" },
    { type: "image", mimeType: "image/png", data: PNG_1X1_BASE64 },
  ] }));
  await server.connect(new StdioServerTransport());
}
