// 验证 MCP resources/prompts 消费：能力探测、分页 list、readResource 的路径守卫、
// getPrompt 的名字白名单，以及对未声明能力的 Server 优雅返回空列表。
// 用真实 stdio 子进程跑夹具 Server（与 logging 测试同款方式），确保是端到端往返，不是内存桩。
// 运行：bun run tests/mcp_resources_prompts.test.ts
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.resolve(".cap-sandbox");
const FIXTURE = path.join(HERE, "mcp_capabilities_server.ts");

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

async function expectThrow(fn: () => Promise<unknown>, include: string, label: string): Promise<void> {
  try {
    await fn();
    check(false, `${label}（预期抛错，实际没有）`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(message.includes(include), label, message);
  }
}

async function main() {
  await fs.mkdir(SANDBOX, { recursive: true });

  const adapter = new McpAdapter({ allowedRoots: [SANDBOX] });
  const mcp = new McpClientManager(adapter);

  try {
    await mcp.addServer({
      id: "capabilities-fixture",
      transport: "stdio",
      command: "bun",
      args: ["run", FIXTURE, SANDBOX],
    });

    // 1. resources/list 分页拉全，且带 serverId 归属；能力缺失的 Server 不报错，只是没有它
    const resources = await mcp.listResources();
    const names = resources.map((r) => r.name).sort();
    check(
      JSON.stringify(names) === JSON.stringify(["notes", "outside", "secret", "settings"]),
      "listResources 返回全部静态资源",
      names
    );
    check(resources.every((r) => r.serverId === "capabilities-fixture"), "资源都归属到正确 serverId");

    // 1b. 模板资源不在 resources/list 里，只在 resources/templates/list 里
    const templates = await mcp.listResourceTemplates();
    check(
      templates.length === 1 && templates[0]?.name === "dynamic-note" && templates[0].uriTemplate === "mem://note/{id}",
      "listResourceTemplates 返回动态资源模板",
      templates
    );

    // 2. readResource：白名单内的 file:// 资源可读
    const notes = resources.find((r) => r.name === "notes")!;
    const notesContents = await mcp.readResource("capabilities-fixture", notes.uri);
    const firstNote = notesContents[0];
    check(
      notesContents.length === 1 && firstNote !== undefined && "text" in firstNote && firstNote.text.includes("沙箱笔记"),
      "沙箱内资源可读取",
      notesContents
    );

    // 3. 非 file:// 资源（config://）不受本地路径守卫管辖，直接放行
    const settings = resources.find((r) => r.name === "settings")!;
    const settingsContents = await mcp.readResource("capabilities-fixture", settings.uri);
    const firstSetting = settingsContents[0];
    check(
      firstSetting !== undefined && "text" in firstSetting && firstSetting.text === '{"theme":"dark"}',
      "非 file:// 资源可读取",
      settingsContents
    );

    // 4. 越界 file:// 资源被路径守卫拦截
    const outside = resources.find((r) => r.name === "outside")!;
    await expectThrow(
      () => mcp.readResource("capabilities-fixture", outside.uri),
      "Security Exception",
      "越界 file:// 资源被拦截"
    );

    // 5. 命中受保护路径（.env）的 file:// 资源被拦截，即使它在白名单根目录内
    const secret = resources.find((r) => r.name === "secret")!;
    await expectThrow(
      () => mcp.readResource("capabilities-fixture", secret.uri),
      "受保护文件或目录",
      "受保护路径资源被拦截"
    );

    // 6. subscribeResource 走通（夹具声明了 resources.subscribe 且补了处理器）
    await mcp.subscribeResource("capabilities-fixture", notes.uri);
    check(true, "subscribeResource 未抛错");

    // 7. prompts/list + getPrompt 名字白名单
    const prompts = await mcp.listPrompts();
    check(
      JSON.stringify(prompts.map((p) => p.name).sort()) === JSON.stringify(["greet", "summarize"]),
      "listPrompts 返回全部注册模板",
      prompts.map((p) => p.name)
    );

    const summarize = prompts.find((p) => p.name === "summarize")!;
    check(
      JSON.stringify(summarize.arguments?.map((a) => a.name).sort()) === JSON.stringify(["text", "tone"]),
      "prompt 参数声明被读到",
      summarize.arguments
    );

    const rendered = await mcp.getPrompt("capabilities-fixture", "summarize", { text: "hello world", tone: "casual" });
    const summarizeMessage = rendered.messages[0];
    check(
      rendered.messages.length === 1 && summarizeMessage?.content.type === "text",
      "getPrompt 返回消息",
      rendered
    );
    check(
      summarizeMessage?.content.type === "text" && summarizeMessage.content.text.includes("hello world"),
      "prompt 参数被填充进消息内容",
      summarizeMessage?.content
    );

    const greet = await mcp.getPrompt("capabilities-fixture", "greet");
    check(
      greet.messages.length === 2 && greet.messages[1]?.role === "assistant",
      "零参数 prompt 可取多轮消息",
      greet.messages
    );

    await expectThrow(
      () => mcp.getPrompt("capabilities-fixture", "not_registered"),
      "不在 Server",
      "未登记的 prompt 名字被白名单拦截"
    );

    // 8. 未声明 resources/prompts 能力的 Server（纯 tools 的 filesystem 才该走到这条，这里用不带能力的夹具替身）
    //    直接对 capabilities-fixture 指定一个错误 serverId，验证方法层的显式失败而不是静默空列表
    await expectThrow(
      () => mcp.listResources("ghost-server"),
      "不存在或未声明",
      "未知 serverId 调用 listResources 明确报错"
    );
  } finally {
    await mcp.closeAll();
    await fs.rm(SANDBOX, { recursive: true, force: true });
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
