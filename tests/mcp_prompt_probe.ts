// 一次性冒烟脚本：连接 config.ts 里当前启用的 Server，逐个 prompts/list，
// 再对每个模板尝试 getPrompt（必填参数给占位值），打印成功/失败，不需要跑 Agent 或调用 LLM。
// 运行：bun run tests/mcp_prompt_probe.ts
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";
import { MCP_SANDBOX_DIR, McpServers } from "../src/mcp/config";

async function main() {
  const adapter = new McpAdapter({ allowedRoots: [MCP_SANDBOX_DIR] });
  const mcp = new McpClientManager(adapter);

  try {
    const reports = await mcp.loadFromConfig(McpServers);
    for (const report of reports) {
      console.log(report.ok ? `✅ ${report.id} 已连接` : `❌ ${report.id}: ${report.error}`);
    }

    const prompts = await mcp.listPrompts();
    if (prompts.length === 0) {
      console.log("当前启用的 Server 都没有声明 prompts 能力（listPrompts 返回空列表，不代表出 bug）。");
      return;
    }

    for (const prompt of prompts) {
      // 必填参数填占位值，可选参数省略走 Server 默认
      const args: Record<string, string> = {};
      for (const arg of prompt.arguments ?? []) {
        if (arg.required) args[arg.name] = "sample";
      }

      const label = `${prompt.serverId}:${prompt.name}`;
      try {
        const result = await mcp.getPrompt(prompt.serverId, prompt.name, Object.keys(args).length > 0 ? args : undefined);
        console.log(`✅ getPrompt ${label} 成功，${result.messages.length} 条消息`);
        console.log(JSON.stringify(result.messages, null, 2));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ getPrompt ${label} 失败:`, message);
      }
    }
  } finally {
    await mcp.closeAll();
  }
}

main().catch((error) => {
  console.error("PROBE CRASHED:", error);
  process.exitCode = 1;
});
