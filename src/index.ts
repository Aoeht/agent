import { Agent } from "./core/agent";
import "./tools/tavily-search"; // 副作用导入，注册工具

async function main() {
  const agent = new Agent({
    model: "deepseek-v4-pro", // 或 qwen-plus 等
    systemPrompt: `你是一个全能的助手，擅长回答各种问题，并能调用工具获取最新信息。请根据用户的提问，尽量给出准确、详细的答案。提供了search_web工具，可以在网络上搜索最新信息。优先返回工具调用的结果，不要返回“我不知道”。`,
    maxIterations: 8,
  });

  const result = await agent.run(
    "请告诉我《迪迦奥特曼》中三具奥特曼石像原来设定的是哪三个奥特曼。"
  );

  console.log("✅ Success:", result.success);
  console.log("📝 Answer:", result.finalAnswer);
  console.log("🔧 Tool Calls:", result.toolCallsCount);
  console.log("💰 Tokens:", result.totalTokens);
}

main().catch(console.error);


// // src/index.ts
// import { toolRegistry } from "./tools/registry";
// import { mcpManager } from "./mcp/client_manager";
// // 导入你现有的静态工具（如果它们通过导入时自动 registry.register）
// import "./tools/rag_search";
// import "./tools/tavily-search";

// async function bootstrap() {
//   // 1. 动态挂载你想要的 MCP Server（例如挂载官方文件系统工具）
//   await mcpManager.addServer({
//     id: "filesystem",
//     command: "npx",
//     args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
//   });

//   // 此时，toolRegistry 已经同时拥有了：
//   // - 本地的 rag_search, tavily-search, find_suspicious_segments
//   // - MCP 动态注入的 read_file, list_directory 等工具

//   // 2. 正常传递给 LLM
//   const openAITools = toolRegistry.toOpenAITools();
//   console.log("当前 Agent 支持的所有工具：", openAITools.map(t => t.function.name));

//   // 3. 当 LLM 返回 tool_call 时，调用的方式完全不变：
//   // const output = await toolRegistry.execute(call.name, JSON.parse(call.arguments));

//   // 4. 退出时清理子进程
//   process.on("SIGINT", async () => {
//     await mcpManager.closeAll();
//     process.exit(0);
//   });
// }

// bootstrap().catch(console.error);