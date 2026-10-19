// 验证自己的本地 prompts Server：stdio 挂载后，listPrompts 能发现占位模板，
// getPrompt 能按 argsSchema 正确渲染内容（含可选参数缺省走默认值这条分支）。
// 运行：bun run tests/mcp_local_prompts.test.ts
import path from "node:path";
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";
import { LOCAL_PROMPTS_SERVER_PATH, MCP_SANDBOX_DIR } from "../src/mcp/config";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

async function main() {
  console.log("挂载路径:", path.resolve(LOCAL_PROMPTS_SERVER_PATH));
  const adapter = new McpAdapter({ allowedRoots: [MCP_SANDBOX_DIR] });
  const mcp = new McpClientManager(adapter);

  try {
    await mcp.addServer({
      id: "local_prompts",
      transport: "stdio",
      command: "bun",
      args: ["run", LOCAL_PROMPTS_SERVER_PATH],
    });

    const prompts = await mcp.listPrompts("local_prompts");
    const names = prompts.map((p) => p.name).sort();
    // 只断言"包含已知模板"，不锁定总数：server.ts 之后新增模板不该让这条测试变红
    check(
      names.includes("placeholder_greeting") && names.includes("placeholder_review"),
      "listPrompts 能发现本地预设模板",
      names
    );

    const greeting = prompts.find((p) => p.name === "placeholder_greeting");
    check(
      greeting !== undefined && (greeting.arguments?.length ?? 0) === 0,
      "零参数模板不声明 arguments",
      greeting
    );

    const greetingResult = await mcp.getPrompt("local_prompts", "placeholder_greeting");
    check(
      greetingResult.messages.length === 1 &&
        greetingResult.messages[0]?.content.type === "text" &&
        greetingResult.messages[0].content.type === "text" &&
        greetingResult.messages[0].content.text.includes("占位内容"),
      "getPrompt 渲染零参数模板",
      greetingResult.messages
    );

    const reviewResult = await mcp.getPrompt("local_prompts", "placeholder_review", {
      text: "这笔交易可疑",
      focus: "risk",
    });
    const reviewMessage = reviewResult.messages[0]?.content;
    check(
      reviewMessage?.type === "text" && reviewMessage.text.includes("risk") && reviewMessage.text.includes("这笔交易可疑"),
      "getPrompt 按 argsSchema 填充必填/可选参数",
      reviewMessage
    );

    // 可选参数不传，应走 Server 侧默认值分支（focus ?? "general"）
    const reviewDefault = await mcp.getPrompt("local_prompts", "placeholder_review", { text: "普通文本" });
    const defaultMessage = reviewDefault.messages[0]?.content;
    check(
      defaultMessage?.type === "text" && defaultMessage.text.includes("general"),
      "缺省可选参数走默认值",
      defaultMessage
    );
  } finally {
    await mcp.closeAll();
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
    if (failures > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("TEST CRASHED:", error);
    process.exitCode = 1;
  });
