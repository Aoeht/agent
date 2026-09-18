import { Agent } from "./core/agent";
import "./tools/tavily-search"; // 副作用导入，注册工具

async function main() {
  const agent = new Agent({
    model: "deepseek-v4-pro", // 或 qwen-plus 等
    systemPrompt: `你是一个资深影迷，你不能直接回答“不知道”，在必要时使用工具去查找信息，并优先返回调用工具得到的答案。`,
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