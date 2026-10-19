import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";
import { McpServerLogEvent } from "../src/mcp/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const events: McpServerLogEvent[] = [];

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP server log");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main() {
  const adapter = new McpAdapter({ allowedRoots: [path.resolve("./.fake-sandbox")] });
  const manager = new McpClientManager(adapter, (event) => events.push(event));

  try {
    await manager.addServer({
      id: "logging-fixture",
      transport: "stdio",
      command: "bun",
      args: ["run", path.join(HERE, "mcp_logging_server.ts")],
      loggingLevel: "info",
    });

    await waitFor(() => events.length > 0, 2_000);
    const event = events[0];
    const isReadyLog =
      event?.serverId === "logging-fixture" &&
      event.level === "info" &&
      event.logger === "fixture" &&
      typeof event.data === "object" &&
      event.data !== null &&
      (event.data as { event?: unknown }).event === "ready";

    if (!isReadyLog) throw new Error(`Unexpected MCP server log: ${JSON.stringify(event)}`);
    console.log("✅ 收到 MCP Server 结构化日志");
  } finally {
    await manager.closeAll();
  }
}

main().catch((error) => {
  console.error("LOGGING TEST FAILED:", error);
  process.exitCode = 1;
});
