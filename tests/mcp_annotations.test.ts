// 验证 annotations 准入策略 + structuredContent 优先。
// 用 SDK 的内存传输起一个可控的假 Server，避免依赖第三方 Server 的行为。
// 运行：bun run .sand-box/tests/mcp_annotations.test.ts
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { z } from "zod";
import { McpAdapter } from "../src/mcp/adapter";
import { Confirmer, ElicitationRequest, McpAuditEvent, McpToolProgress, ToolPolicyRequest } from "../src/mcp/types";

const SANDBOX = path.resolve("./.fake-sandbox");
const policyLog: ToolPolicyRequest[] = [];
const auditLog: McpAuditEvent[] = [];
const progressLog: McpToolProgress[] = [];
const elicitationLog: ElicitationRequest[] = [];

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

function buildFakeServer(): McpServer {
  const server = new McpServer({ name: "fake", version: "1.0.0" });

  server.registerTool(
    "read_note",
    {
      description: "读取一条笔记",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => ({ content: [{ type: "text", text: `note:${id}` }] })
  );

  server.registerTool(
    "purge_all",
    {
      description: "清空远端数据",
      inputSchema: {},
      // 不可回收 + 触达外部世界，正是策略该拦的那一类
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async () => ({ content: [{ type: "text", text: "wiped" }] })
  );

  server.registerTool(
    "touch",
    {
      description: "本地文件工具",
      inputSchema: { path: z.string(), content: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ content }) => ({ content: [{ type: "text", text: `touched:${content}` }] })
  );

  server.registerTool(
    "legacy_remote_mutation",
    {
      description: "没有声明任何 annotations 的老远程修改工具",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: "mutated" }] })
  );

  server.registerTool(
    "long_task",
    {
      description: "会主动报告进度的长任务",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => {
      const progressToken = extra._meta?.progressToken;
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 2, message: "halfway" },
        });
      }
      return { content: [{ type: "text", text: "done" }] };
    }
  );

  server.registerTool(
    "typed_report",
    {
      description: "返回 structuredContent 的类型化工具",
      inputSchema: { q: z.string() },
      outputSchema: { total: z.number(), hits: z.array(z.string()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ q }) => ({
      // 文本故意给一句"看起来像别的东西"的话，用来证明走了 structured 而非文本猜测
      content: [{ type: "text", text: `legacy text for ${q}` }],
      structuredContent: { total: 2, hits: [`${q}-a`, `${q}-b`] },
    })
  );

  server.registerTool(
    "jsonish_text",
    {
      description: "只用文本返回 JSON 的工具",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: "text", text: '{"ok":true}' }] })
  );

  server.registerTool(
    "risky_elicit",
    {
      description: "Server 主动发起 elicitation/create 表单确认的危险操作",
      inputSchema: {},
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async () => {
      const result = await server.server.elicitInput({
        message: "确认要执行危险操作吗？请填写原因。",
        requestedSchema: {
          type: "object",
          properties: {
            reason: { type: "string", title: "原因" },
          },
          required: ["reason"],
        },
      });
      if (result.action !== "accept") {
        return { content: [{ type: "text", text: `declined:${result.action}` }] };
      }
      return { content: [{ type: "text", text: `confirmed:${result.content?.reason}` }] };
    }
  );

  return server;
}

async function connectAdapter(adapter: McpAdapter, confirmer?: Confirmer): Promise<McpClient> {
  const server = buildFakeServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new McpClient(
    { name: "test-host", version: "1.0.0" },
    { capabilities: confirmer ? { elicitation: { form: {} } } : {} }
  );

  if (confirmer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params;
      if (params.mode === "url") return { action: "decline" };
      const decision = await confirmer({
        serverId: "fake",
        message: params.message,
        requestedSchema: params.requestedSchema,
      });
      return decision.content !== undefined
        ? { action: decision.action, content: decision.content }
        : { action: decision.action };
    });
  }

  await server.connect(serverSide);
  await client.connect(clientSide);
  await adapter.syncTools(client, "fake");
  return client;
}

async function main() {
  const adapter = new McpAdapter({
    allowedRoots: [SANDBOX],
    // 只拦"破坏性且触达外部世界"的调用，本地写文件（filesystem 的 write_file 也标了
    // destructiveHint）依旧放行
    toolPolicy: (req) => {
      policyLog.push(req);
      const a = req.annotations;
      if (a?.destructiveHint && a.openWorldHint) return "deny";
      return "allow";
    },
    onAudit: (event) => auditLog.push(event),
    onProgress: (event) => progressLog.push(event),
  });

  const client = await connectAdapter(adapter);

  // 1. annotations 被读到，并摘要进了工具描述
  const readNote = adapter.registry.get("fake__read_note");
  check(Boolean(readNote), "read_note 已注册");
  check(readNote!.description.includes("read-only"), "描述带 read-only 标记", readNote!.description);

  const purge = adapter.registry.get("fake__purge_all");
  check(purge!.description.includes("destructive") && purge!.description.includes("open-world"), "purge_all 描述含两个标记", purge!.description);

  // 2. 只读工具正常放行
  const readResult = await adapter.registry.execute("fake__read_note", { id: "42" });
  check(readResult.includes("note:42"), "只读工具可执行", readResult);

  // 3. 策略按 annotations 拒绝，且拒绝以工具错误形式回给模型（不炸循环）
  const purgeResult = await adapter.registry.execute("fake__purge_all", {});
  check(purgeResult.includes("Policy Denied"), "destructive+open-world 被策略拒绝", purgeResult);

  const lastPolicy = policyLog[policyLog.length - 1];
  check(lastPolicy?.annotations?.openWorldHint === true, "策略回调收到了 annotations", lastPolicy?.annotations);

  // 4. 未声明 annotations 的老 Server 按规范默认值进入保守策略
  const legacy = await adapter.registry.execute("fake__legacy_remote_mutation", {});
  check(legacy.includes("Policy Denied"), "缺失 annotations 的远程修改工具被拒绝", legacy);
  const legacyPolicy = policyLog[policyLog.length - 1];
  check(
    legacyPolicy?.annotations?.destructiveHint === true && legacyPolicy.annotations.openWorldHint === true,
    "策略收到的缺失 annotations 已补规范默认值",
    legacyPolicy?.annotations
  );

  // 5. 路径守卫同时拦截越界和受保护文件，本地非 open-world 写入仍放行
  const escaped = await adapter.registry.execute("fake__touch", { path: "../out.md", content: "x" });
  check(escaped.includes("Security Exception"), "路径穿越被拦截", escaped);
  const protectedFile = await adapter.registry.execute("fake__touch", { path: ".env", content: "x" });
  check(protectedFile.includes("受保护文件或目录"), "受保护路径被拦截", protectedFile);
  const inside = await adapter.registry.execute("fake__touch", { path: "in.md", content: "y" });
  check(inside.includes("touched:y"), "白名单内本地写入可执行", inside);

  // 6. Server 发送进度后，adapter 会把它映射为宿主回调
  const longTask = await adapter.registry.execute("fake__long_task", {});
  check(longTask.includes("done"), "长任务可执行", longTask);
  check(
    progressLog.some((event) => event.registeredName === "fake__long_task" && event.progress === 1 && event.total === 2),
    "收到并映射 MCP 进度通知",
    progressLog
  );

  // 7. 审计不记录字符串内容，拒绝与完成都有独立事件
  check(
    auditLog.some((event) => event.phase === "denied" && event.registeredName === "fake__purge_all"),
    "策略拒绝被审计",
    auditLog
  );
  check(
    auditLog.some(
      (event) =>
        event.phase === "completed" &&
        event.registeredName === "fake__touch" &&
        event.args.content === "[string 1 chars]"
    ),
    "审计只记录参数字符串长度",
    auditLog
  );

  // 8. structuredContent 优先，不再靠文本猜 JSON
  const typed = await adapter.registry.execute("fake__typed_report", { q: "mcp" });
  const parsedTyped = JSON.parse(typed) as { total: number; hits: string[] };
  check(parsedTyped.total === 2 && parsedTyped.hits[0] === "mcp-a", "返回结构化对象而非遗留文本", typed);

  // 9. 纯文本 JSON 的启发式仍然生效（老 Server 兼容）
  const jsonish = await adapter.registry.execute("fake__jsonish_text", {});
  check(JSON.parse(jsonish).ok === true, "文本 JSON 兜底解析未被破坏", jsonish);

  // 10. 策略返回 ask 时会调用 confirmer 做人工确认（本地确认，不经过 MCP 协议）
  const acceptConfirmer: Confirmer = async (request) => {
    elicitationLog.push(request);
    return { action: "accept" };
  };
  const askAcceptAdapter = new McpAdapter({
    allowedRoots: [SANDBOX],
    toolPolicy: ({ annotations }) =>
      annotations?.destructiveHint && annotations.openWorldHint ? "ask" : "allow",
    confirmer: acceptConfirmer,
  });
  const askAcceptClient = await connectAdapter(askAcceptAdapter);
  const askAccepted = await askAcceptAdapter.registry.execute("fake__purge_all", {});
  check(askAccepted.includes("wiped"), "人工确认通过后工具正常执行", askAccepted);
  check(
    elicitationLog.some((req) => req.serverId === "fake" && req.requestedSchema === undefined),
    "本地 ask 确认请求不带 schema",
    elicitationLog
  );
  await askAcceptClient.close();

  const declineConfirmer: Confirmer = async () => ({ action: "decline" });
  const askDeclineAdapter = new McpAdapter({
    allowedRoots: [SANDBOX],
    toolPolicy: ({ annotations }) =>
      annotations?.destructiveHint && annotations.openWorldHint ? "ask" : "allow",
    confirmer: declineConfirmer,
  });
  const askDeclineClient = await connectAdapter(askDeclineAdapter);
  const askDeclined = await askDeclineAdapter.registry.execute("fake__purge_all", {});
  check(
    askDeclined.includes("Policy Denied") && askDeclined.includes("人工拒绝"),
    "人工拒绝后按 Policy Denied 处理",
    askDeclined
  );
  await askDeclineClient.close();

  const askNoConfirmerAdapter = new McpAdapter({
    allowedRoots: [SANDBOX],
    toolPolicy: ({ annotations }) =>
      annotations?.destructiveHint && annotations.openWorldHint ? "ask" : "allow",
  });
  const askNoConfirmerClient = await connectAdapter(askNoConfirmerAdapter);
  const askNoConfirmer = await askNoConfirmerAdapter.registry.execute("fake__purge_all", {});
  check(
    askNoConfirmer.includes("Policy Denied") && askNoConfirmer.includes("未配置 confirmer"),
    "ask 未配置 confirmer 时按拒绝处理",
    askNoConfirmer
  );
  await askNoConfirmerClient.close();

  // 11. 真实 elicitation/create：Server 主动发起表单确认，宿主通过 confirmer 作答
  const formConfirmer: Confirmer = async (request) => {
    elicitationLog.push(request);
    return { action: "accept", content: { reason: "approved-by-test" } };
  };
  const elicitAdapter = new McpAdapter({ allowedRoots: [SANDBOX] }); // 默认全放行，不触发本地 ask
  const elicitClient = await connectAdapter(elicitAdapter, formConfirmer);
  const elicited = await elicitAdapter.registry.execute("fake__risky_elicit", {});
  check(elicited.includes("confirmed:approved-by-test"), "真实 elicitation 表单确认后工具按内容执行", elicited);
  check(
    elicitationLog.some((req) => req.requestedSchema?.properties?.reason !== undefined),
    "elicitation 请求带上了 Server 的 requestedSchema",
    elicitationLog
  );
  await elicitClient.close();

  const declineFormConfirmer: Confirmer = async () => ({ action: "decline" });
  const elicitDeclineAdapter = new McpAdapter({ allowedRoots: [SANDBOX] });
  const elicitDeclineClient = await connectAdapter(elicitDeclineAdapter, declineFormConfirmer);
  const elicitedDeclined = await elicitDeclineAdapter.registry.execute("fake__risky_elicit", {});
  check(elicitedDeclined.includes("declined:decline"), "真实 elicitation 被人工拒绝时工具收到 decline", elicitedDeclined);
  await elicitDeclineClient.close();

  // 12. annotateDescription:false 时不往描述里塞标记
  const quietAdapter = new McpAdapter({ allowedRoots: [SANDBOX], annotateDescription: false });
  const quietClient = await connectAdapter(quietAdapter);
  const quiet = quietAdapter.registry.get("fake__read_note");
  check(quiet!.description === "[MCP fake] 读取一条笔记", "关闭后描述不含标记", quiet!.description);

  await quietClient.close();
  await client.close();
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
