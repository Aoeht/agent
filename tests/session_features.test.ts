// tests/session_features.test.ts
// 会话级功能：会话内切换模型（+ 续聊恢复）、会话名 = 第一轮对话的摘要。
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { SessionStore, normalizeSessionName } from "../src/core/session_store";
import { pickSession } from "../src/core/session_picker";
import { handleModelCommand } from "../src/core/model_command";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

/** 抓取每次请求的完整参数，返回不带工具调用的收尾回答 */
function makeClient(reply = "好的"): { client: any; requests: any[] } {
  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          requests.push(params);
          return {
            choices: [{ message: { content: reply } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };
  return { client, requests };
}

// ───────────────────────── 会话名的规范化与落盘 ─────────────────────────

test("会话名规范化：去引号/结尾句号/换行，超长截断，空串视为无效", () => {
  expect(normalizeSessionName('  "核查钓鱼链接"。  ')).toBe("核查钓鱼链接");
  expect(normalizeSessionName("第一行\n第二行")).toBe("第一行 第二行");
  expect(normalizeSessionName("   ")).toBeUndefined();
  expect(normalizeSessionName("。！？")).toBeUndefined();
  expect(normalizeSessionName("啊".repeat(50))!.length).toBe(25); // 24 字 + 省略号
});

test("会话名与模型记录：历史可见、不进上下文、不计消息数，compact 后仍在", async () => {
  const dir = await tempDir("dsh-named-");
  const store = new SessionStore({ dir, sessionId: "t" });
  await store.append({ role: "user", content: "第一轮问题" });
  await store.append({ role: "assistant", content: "第一轮回答" });

  expect(await store.recordSessionName("“核查钓鱼链接”。")).toBe("核查钓鱼链接");
  await store.recordModel("glm-5.2");
  // 重复设置同一个值不再追加第二行，否则每轮都会写一条噪声
  await store.recordSessionName("核查钓鱼链接");
  await store.recordModel("glm-5.2");

  const raw = await fs.readFile(store.filePath, "utf-8");
  expect(raw.split("【会话名】").length - 1).toBe(1);
  expect(raw.split("【模型】").length - 1).toBe(1);
  expect(raw).toContain("【会话名】核查钓鱼链接"); // 记录就在文件里，历史可查

  const loaded = await store.load();
  expect(loaded.sessionName).toBe("核查钓鱼链接");
  expect(loaded.model).toBe("glm-5.2");
  // 元记录不是对话消息：不能进 LLM 上下文
  expect(loaded.messages.map((m) => m.content)).toEqual(["第一轮问题", "第一轮回答"]);

  const summaries = await SessionStore.list(dir);
  expect(summaries[0]!.name).toBe("核查钓鱼链接");
  expect(summaries[0]!.messageCount).toBe(2);

  // 裁剪历史不能把会话名/模型裁掉
  await store.compact(1);
  const after = await store.load();
  expect(after.sessionName).toBe("核查钓鱼链接");
  expect(after.model).toBe("glm-5.2");
  expect(after.messages.length).toBe(2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("老会话没有会话名记录时，菜单回退到首条用户消息预览", async () => {
  const dir = await tempDir("dsh-legacy-");
  const store = new SessionStore({ dir, sessionId: "old" });
  await store.append({ role: "user", content: "旧会话的提问" });
  await store.append({ role: "assistant", content: "回答" });

  const summaries = await SessionStore.list(dir);
  expect(summaries[0]!.name).toBeUndefined();
  expect(summaries[0]!.firstUserText).toBe("旧会话的提问");

  await fs.rm(dir, { recursive: true, force: true });
});

// ───────────────────────── 会话内切换模型 ─────────────────────────

test("setModel 切换后后续 run 用新模型；续聊时按会话记录恢复", async () => {
  const dir = await tempDir("dsh-model-");
  const store = new SessionStore({ dir, sessionId: "m" });

  const first = makeClient();
  const agent = new Agent({
    model: "config-model", systemPrompt: "系统规则", client: first.client,
    tools: new ToolRegistry(), sessionStore: store,
  });
  await agent.run("一");
  expect(first.requests[0].model).toBe("config-model");

  agent.setModel("switched-model");
  expect(agent.model).toBe("switched-model");
  await store.recordModel("switched-model"); // REPL 的 /model 会同时落盘
  await agent.run("二");
  // 纯聊天现在也会发后台摘要请求；这里只检查主对话，不按所有请求的下标取值。
  expect(first.requests.filter(r => r.messages[0]?.content === "系统规则")[1].model).toBe("switched-model");
  await agent.flushSummary();

  // 新进程续聊同一个会话：模型从记录恢复，而不是回到配置默认值
  const second = makeClient();
  const resumed = new Agent({
    model: "config-model", systemPrompt: "系统规则", client: second.client,
    tools: new ToolRegistry(), sessionStore: store,
  });
  await resumed.run("三");
  expect(resumed.model).toBe("switched-model");
  expect(second.requests[0].model).toBe("switched-model");

  // 进程内显式切换优先于会话记录
  resumed.setModel("override-model");
  await resumed.run("四");
  expect(second.requests.filter(r => r.messages[0]?.content === "系统规则")[1].model).toBe("override-model");
  await resumed.flushSummary();

  await fs.rm(dir, { recursive: true, force: true });
});

test("没有会话记录（新会话）时用配置里的默认模型", async () => {
  const dir = await tempDir("dsh-fresh-");
  const store = new SessionStore({ dir, sessionId: "fresh" });
  const { client, requests } = makeClient();
  const agent = new Agent({
    model: "config-model", systemPrompt: "系统规则", client,
    tools: new ToolRegistry(), sessionStore: store,
  });

  await agent.run("新会话第一轮");
  expect(requests[0].model).toBe("config-model");
  await agent.flushSummary();
  await fs.rm(dir, { recursive: true, force: true });
});

// ───────────────────────── 会话名生成 ─────────────────────────

test("会话名走摘要模型且强制非流式，结果被清洗", async () => {
  const { client, requests } = makeClient("“核查钓鱼链接的安全性”。");
  // 主流程开着流式：起名仍必须非流式，否则标题会逐字打进终端、污染 trace
  const agent = new Agent({
    model: "main-model", summaryModel: "cheap-model", systemPrompt: "系统规则",
    client, tools: new ToolRegistry(), stream: true,
  });

  const name = await agent.summarizeSessionName("这个链接安全吗", "看起来是钓鱼站");

  expect(name).toBe("核查钓鱼链接的安全性");
  expect(requests[0].model).toBe("cheap-model");
  expect(requests[0].stream).toBeUndefined();
  expect(requests[0].messages[0]!.content).toContain("会话命名器");
  expect(requests[0].messages.at(-1).content).toContain("这个链接安全吗");
  expect(requests[0].messages.at(-1).content).toContain("看起来是钓鱼站");
});

test("起名失败或标题为空都返回 undefined，不抛错、不影响本回合", async () => {
  const failing = {
    chat: { completions: { create: async () => { throw new Error("上游 500"); } } },
  } as any;
  const agent = new Agent({
    model: "main-model", systemPrompt: "系统规则", client: failing, tools: new ToolRegistry(),
  });
  expect(await agent.summarizeSessionName("问题", "回答")).toBeUndefined();

  const blank = makeClient("   \n  ");
  const agent2 = new Agent({
    model: "main-model", systemPrompt: "系统规则", client: blank.client, tools: new ToolRegistry(),
  });
  expect(await agent2.summarizeSessionName("问题", "回答")).toBeUndefined();
});

test("没配 summaryModel 时用主模型起名", async () => {
  const { client, requests } = makeClient("会话主题");
  const agent = new Agent({
    model: "main-model", systemPrompt: "系统规则", client, tools: new ToolRegistry(),
  });
  expect(await agent.summarizeSessionName("q", "a")).toBe("会话主题");
  expect(requests[0].model).toBe("main-model");
});

// ───────────────────────── /model 命令 ─────────────────────────

test("/model：查看当前、切换、同名不写、非法输入不改动、失败有提示", async () => {
  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  let model = "m1";
  const switched: string[] = [];
  const host = {
    currentModel: () => model,
    switchModel: async (next: string) => {
      switched.push(next);
      model = next;
    },
  };

  // 未知斜杠命令与普通问题都交回主循环，且不打印任何东西
  expect(await handleModelCommand("帮我核查这个链接", host, out)).toEqual({ kind: "not-a-command" });
  expect(await handleModelCommand("/models", host, out)).toEqual({ kind: "not-a-command" });
  expect(lines).toEqual([]);

  expect(await handleModelCommand("/model", host, out)).toEqual({ kind: "handled" });
  expect(lines.at(-2)).toContain("当前模型: m1");

  await handleModelCommand("/model m2", host, out);
  expect(switched).toEqual(["m2"]);
  expect(lines.at(-1)).toContain("m1 → m2");

  await handleModelCommand("/model m2", host, out);
  expect(switched).toEqual(["m2"]); // 同名不再切换
  expect(lines.at(-1)).toContain("未做改动");

  await handleModelCommand("/model two words", host, out);
  expect(switched).toEqual(["m2"]);
  expect(lines.at(-1)).toContain("不能含空格");

  const failing = {
    currentModel: () => "m2",
    switchModel: async () => { throw new Error("没有这个模型"); },
  };
  await handleModelCommand("/model m3", failing, out);
  expect(lines.at(-1)).toContain("切换模型失败");
  expect(lines.at(-1)).toContain("没有这个模型");
});

// ───────────────────────── 会话选择菜单 ─────────────────────────

test("会话菜单用会话名打头，并保留 sessionId 与首条提问", async () => {
  const dir = await tempDir("dsh-picker-");
  const sessionId = "session-20260101-000000";
  const store = new SessionStore({ dir, sessionId });
  await store.append({ role: "user", content: "这个链接是不是钓鱼" });
  await store.append({ role: "assistant", content: "是" });
  await store.recordSessionName("核查钓鱼链接");

  const menu: string[] = [];
  const created = await pickSession({ dir, ask: async () => "0", log: (l) => menu.push(l) });
  expect(created.isNew).toBe(true);
  const menuText = menu.join("\n");
  expect(menuText).toContain(`核查钓鱼链接 · ${sessionId}`);
  expect(menuText).toContain("↳ 这个链接是不是钓鱼");

  const resumeLog: string[] = [];
  const resumed = await pickSession({ dir, ask: async () => "1", log: (l) => resumeLog.push(l) });
  expect(resumed.sessionId).toBe(sessionId);
  expect(resumed.isNew).toBe(false);
  expect(resumeLog.join("\n")).toContain(`续聊会话: 核查钓鱼链接（${sessionId}）`);

  await fs.rm(dir, { recursive: true, force: true });
});
