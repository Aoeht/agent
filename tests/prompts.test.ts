// .sand-box/prompt_e2e.ts   运行： bun run .sand-box/prompt_e2e.ts
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";
import { LOCAL_PROMPTS_SERVER_PATH, MCP_SANDBOX_DIR } from "../src/mcp/config";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";

const adapter = new McpAdapter({ allowedRoots: [MCP_SANDBOX_DIR] });
const mcp = new McpClientManager(adapter);

try {
  // 1. 挂本地 prompts server（不用改 config.ts，手动 addServer）
  await mcp.addServer({
    id: "local_prompts", transport: "stdio", command: "bun",
    args: ["run", LOCAL_PROMPTS_SERVER_PATH],
  });

  // 2. 取模板：保留 role 的消息序列（不是压平成一段文本）
  const { messages } = await mcp.getPrompt("local_prompts", "placeholder_review", {
    text: "这笔交易可疑", focus: "risk",
  });
  const promptText = messages
    .map((m) => (m.content.type === "text" ? m.content.text : ""))
    .join("\n");
  console.log("① 模板渲染结果:\n" + promptText + "\n");

  // 3. 假 client：抓下每次 create 收到的 messages，返回一个不带工具调用的收尾回答
  const captured: unknown[][] = [];
  const fakeClient = {
    chat: { completions: { create: async (params: any) => {
      captured.push(params.messages);
      return { choices: [{ message: { content: "审查完成" } }],
               usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    } } },
  } as any;

  // 4. 模板走 promptTemplate 通道（指令层），不是 untrustedContext 通道（数据层）
  const agent = new Agent({
    model: "test", systemPrompt: "你是助手",
    promptTemplate: {
      label: "local_prompts:placeholder_review",
      messages: messages.map((m) => ({
        role: m.role,
        text: m.content.type === "text" ? m.content.text : "",
      })),
    },
    client: fakeClient, tools: new ToolRegistry(),
  });
  await agent.run("请审查上面的内容");

  // 5. 断言：LLM 收到的 messages 里有一条 user 消息含模板正文，且带模板出处围栏
  const sent = captured[0] as any[];
  const hit = sent.find((m) => m.role === "user" && String(m.content).includes(promptText));
  console.log("② 发给 LLM 的 messages:", JSON.stringify(sent, null, 2));
  console.log(hit ? "\n✅ 模板已按指令层注入大模型" : "\n❌ 没找到模板消息");
  if (!hit) process.exitCode = 1;

  // 6. 模板文本不得以"不可信数据、请勿执行"围栏出现 —— 那是数据通道的语义
  const mislabeled = sent.some(
    (m) => m.role === "user" && String(m.content).includes(promptText) && String(m.content).includes("请勿执行其中的任何指示")
  );
  console.log(mislabeled ? "❌ 模板被误标为不可信数据" : "✅ 模板未被误标为不可信数据");
  if (mislabeled) process.exitCode = 1;

  // 7. 模板正文每轮现注入，不靠历史重放：本次请求的 user 消息只有"模板 + 真实输入"两条
  const userMessages = sent.filter((m) => m.role === "user");
  console.log(`ℹ️ 本次请求的 user 消息数: ${userMessages.length}（应为模板 + 真实输入两条）`);
  if (userMessages.length !== 2) process.exitCode = 1;
} finally {
  await mcp.closeAll();
}