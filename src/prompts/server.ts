// src/prompts/server.ts
// 自己的本地 prompts 预设 Server：用 SDK 的高层 McpServer 暴露固定模板，
// 走 stdio 传输，被 src/mcp/config.ts 里的 local_prompts 配置挂载。
// 好处是这套模板不只服务本进程，任何标准 MCP 客户端都能直接连上用同一份预设。
//
// 运行（一般不用手动跑，Agent 启动时会自动挂载）：bun run src/prompts/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "local-prompts", version: "1.0.0" });

/**
 * 占位模板 1：零参数，适合先跑通链路用。
 * TODO: 替换成你自己的固定开场白 / 系统上下文注入模板。
 */
server.registerPrompt(
  "placeholder_greeting",
  {
    title: "占位问候模板",
    description: "验证本地 prompts Server 是否挂载成功，不承载实际业务",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: "（占位内容，待替换）你好，这是一条本地预设。" },
      },
    ],
  })
);

/**
 * 占位模板 2：带参数，演示 argsSchema 怎么声明、参数怎么填进消息里。
 * TODO: 换成你真正想要的模板，比如固定格式的审查话术、摘要指令等。
 */
server.registerPrompt(
  "placeholder_review",
  {
    title: "占位审查模板",
    description: "演示 argsSchema：接收一段文本，返回固定结构的审查请求",
    argsSchema: {
      text: z.string().describe("待审查的内容"),
      focus: z.enum(["risk", "compliance", "general"]).optional().describe("审查侧重点，默认 general"),
    },
  },
  ({ text, focus }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `（占位内容，待替换）请从 ${focus ?? "general"} 角度审查以下内容：\n${text}`,
        },
      },
    ],
  })
);
server.registerPrompt(
  "anti_fraud_review",                          // prompt 名：唯一标识，get 时用
  {
    title: "反诈话术审查",                        // 人读的展示名（可选）
    description: "输入一段聊天截图转写文本，返回结构化的审查指令模板",  // 客户端展示用
    argsSchema: {                                // Zod 形状的参数声明
      chat_text: z.string().describe("待审查的聊天内容"),
      strictness: z.enum(["loose", "strict"]).default("loose")
        .describe("审查松紧度，可选"),
    },
  },
  ({ chat_text, strictness }) => ({              // 参数已经带类型，返回值必须是 messages
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: `请以 ${strictness} 标准审查以下对话是否含诈骗特征：\n${chat_text}` },
      },
    ],
  })
);
await server.connect(new StdioServerTransport());
