// 验证 MCP 层的注册/热更新/下线与路径守卫。
// 放在 <项目根>/tests/mcp_smoke.ts 下运行：bun run tests/mcp_smoke.ts
import path from "node:path";
import fs from "node:fs/promises";
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";
import { ToolRegistry } from "../src/core/registry";

const SANDBOX = path.resolve("./.smoke-sandbox");

function assert(condition: boolean, label: string): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) process.exitCode = 1;
}

async function main() {
  await fs.rm(SANDBOX, { recursive: true, force: true });
  await fs.mkdir(SANDBOX, { recursive: true });

  const registry = new ToolRegistry();
  const adapter = new McpAdapter({ registry, allowedRoots: [SANDBOX] });
  const mcp = new McpClientManager(adapter);

  try {
    const tools = await mcp.addServer({
      id: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["--no-install", "@modelcontextprotocol/server-filesystem", SANDBOX],
      roots: [SANDBOX],
      requestTimeoutMs: 20_000,
    });

    assert(tools.length > 0 && registry.size === tools.length, `注册 ${tools.length} 个工具`);

    await registry.execute("filesystem__write_file", { path: "report.md", content: "测试报告" });
    assert(
      await fs.stat(path.join(SANDBOX, "report.md")).then(() => true, () => false),
      "白名单内相对路径可写"
    );

    const traversal = await registry.execute("filesystem__write_file", {
      path: "../../escaped.md",
      content: "boom",
    });
    assert(traversal.includes("Security Exception"), "路径穿越被拦截");

    const absolute = await registry.execute("filesystem__read_file", { path: "C:\\Windows\\win.ini" });
    assert(absolute.includes("Security Exception"), "越界绝对路径被拦截");

    const refreshed = await mcp.reloadServerTools("filesystem");
    assert(refreshed.length === tools.length, "tools/list_changed 差量刷新不抛错");

    await mcp.removeServer("filesystem");
    assert(
      registry.size === 0 && !registry.get("filesystem__read_file"),
      "Server 下线后工具真正从注册表移除"
    );
  } finally {
    await mcp.closeAll();
    await fs.rm(SANDBOX, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exitCode = 1;
});
