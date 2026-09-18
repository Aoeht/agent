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