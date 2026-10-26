// tests/command_router.test.ts
// 斜杠命令共享路由器（REPL 与 Web 同一条认领链）：认领矩阵（/task* 放行、未知 /xxx
// 拦截提示）、/model 查看切换落盘、忙时门控、/prompts 与 /prompt 注入清除、/tokens、
// /rewind 序号式执行（真实影子 git + 会话截断）。
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { SessionStore } from "../src/core/session_store";
import { CheckpointStore } from "../src/core/checkpoint_store";
import { SessionManager, EventHub } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import { loadAgentConfig } from "../src/config";
import type { ServerRuntime } from "../src/server/runtime";
import {
  handleSlashCommand,
  isCommandText,
  type CommandRouterDeps,
  type RunStatsSummary,
} from "../src/core/command_router";
import type { PromptSource } from "../src/prompts/commands";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function makeClient(reply = "好的"): { client: any } {
  return {
    client: {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: reply } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    },
  };
}

async function setup() {
  const dir = await tempDir("dsh-cmd-");
  const store = new SessionStore({ dir, sessionId: "c" });
  const { client } = makeClient();
  const agent = new Agent({
    model: "config-model",
    systemPrompt: "系统规则",
    client,
    tools: new ToolRegistry(),
    sessionStore: store,
  });
  const mcp: PromptSource = {
    listPrompts: async () => [
      { serverId: "local", name: "review", description: "评审模板", arguments: [] },
    ],
    getPrompt: async () => ({
      messages: [{ role: "user", content: { type: "text", text: "模板正文" } }],
    }),
  };
  const deps = (over: Partial<CommandRouterDeps> = {}): CommandRouterDeps => ({
    agent,
    store,
    mcp,
    ...over,
  });
  const cleanup = async () => fs.rm(dir, { recursive: true, force: true });
  return { dir, store, agent, deps, cleanup };
}

// ───────────────────────── isCommandText ─────────────────────────

test("isCommandText：以 / 开头的输入都认领（含 /task*），普通消息不认领", () => {
  expect(isCommandText("/model")).toBe(true);
  expect(isCommandText("  /task resolve a1 applied ok")).toBe(true);
  expect(isCommandText("帮我核查这个链接")).toBe(false);
  expect(isCommandText("")).toBe(false);
});

// ───────────────────────── 认领矩阵 ─────────────────────────

test("认领矩阵：/task* 放行给 Agent 内部拦截，未知 /xxx 拦截提示，普通消息不认领", async () => {
  const { deps, cleanup } = await setup();
  for (const text of ["/task", "/task status", "/task resolve a1 applied ok", "/task new 新目标"]) {
    expect(await handleSlashCommand(text, deps())).toEqual({ kind: "not-a-command" });
  }
  const unknown = await handleSlashCommand("/rewindz", deps());
  expect(unknown.kind).toBe("handled");
  expect(unknown.kind === "handled" && unknown.lines.join("\n")).toContain("未知命令 /rewindz");
  // /promptfoo 是 prompt 处理器显式交回的未知形态：统一落到底部提示，不进 LLM
  const promptfoo = await handleSlashCommand("/promptfoo", deps());
  expect(promptfoo.kind === "handled" && promptfoo.lines.join("\n")).toContain("未知命令 /promptfoo");
  expect(await handleSlashCommand("你好", deps())).toEqual({ kind: "not-a-command" });
  await cleanup();
});

// ───────────────────────── /help 与 /tokens ─────────────────────────

test("/help：静态清单，忙时也放行", async () => {
  const { deps, cleanup } = await setup();
  const outcome = await handleSlashCommand("/help", deps({ isBusy: () => true }));
  expect(outcome.kind === "handled" && outcome.lines[0]).toContain("可用命令");
  await cleanup();
});

test("/tokens：无回合记录时提示；有 lastRunStats 时输出用量与缓存命中", async () => {
  const { deps, cleanup } = await setup();
  const empty = await handleSlashCommand("/tokens", deps());
  expect(empty.kind === "handled" && empty.lines.join("\n")).toContain("还没有");
  const stats: RunStatsSummary = {
    totalTokens: 1234,
    cachedPromptTokens: 100,
    toolCallsCount: 2,
    iterations: 3,
    model: "config-model",
    stopReason: "answer",
  };
  const shown = await handleSlashCommand("/tokens", deps({ lastRunStats: () => stats }));
  const text = shown.kind === "handled" ? shown.lines.join("\n") : "";
  expect(text).toContain("1234");
  expect(text).toContain("100");
  expect(text).toContain("config-model");
  await cleanup();
});

// ───────────────────────── /model ─────────────────────────

test("/model：查看当前模型；切换写入 agent 并落盘会话记录", async () => {
  const { agent, store, deps, cleanup } = await setup();
  const bare = await handleSlashCommand("/model", deps());
  expect(bare.kind === "handled" && bare.lines.join("\n")).toContain("config-model");

  const switched = await handleSlashCommand("/model m2", deps());
  expect(agent.model).toBe("m2");
  expect(switched.kind === "handled" && switched.lines.join("\n")).toContain("m2");
  expect((await store.load()).model).toBe("m2");
  await cleanup();
});

// ───────────────────────── 忙时门控 ─────────────────────────

test("忙时门控：变更类命令（/model 切换、/prompt、/rewind）拒绝且无副作用，只读命令放行", async () => {
  const { agent, store, deps, cleanup } = await setup();
  const busy = { isBusy: () => true };

  const refusedModel = await handleSlashCommand("/model m2", deps(busy));
  expect(refusedModel.kind === "handled" && refusedModel.lines[0]).toContain("回合进行中");
  expect(agent.model).toBe("config-model");

  const refusedPrompt = await handleSlashCommand("/prompt", deps(busy));
  expect(refusedPrompt.kind === "handled" && refusedPrompt.lines[0]).toContain("回合进行中");

  const refusedRewind = await handleSlashCommand("/rewind", deps(busy));
  expect(refusedRewind.kind === "handled" && refusedRewind.lines[0]).toContain("回合进行中");

  const allowedList = await handleSlashCommand("/prompts", deps(busy));
  expect(allowedList.kind === "handled" && allowedList.lines.join("\n")).toContain("local:review");
  const allowedTokens = await handleSlashCommand("/tokens", deps(busy));
  expect(allowedTokens.kind).toBe("handled");

  // 忙时 /model 切换连会话记录都不该写
  expect((await store.load()).model).toBeUndefined();
  await cleanup();
});

// ───────────────────────── /prompts 与 /prompt ─────────────────────────

test("/prompt：注入模板落盘（label 随记录恢复）、空 /prompt 清除", async () => {
  const { store, deps, cleanup } = await setup();
  const listed = await handleSlashCommand("/prompts", deps());
  expect(listed.kind === "handled" && listed.lines.join("\n")).toContain("local:review");

  const injected = await handleSlashCommand('/prompt local:review {"text":"hi"}', deps());
  expect(injected.kind === "handled" && injected.lines.join("\n")).toContain("已载入");
  expect((await store.load()).promptTemplate?.label).toBe("local:review");

  const cleared = await handleSlashCommand("/prompt", deps());
  expect(cleared.kind === "handled" && cleared.lines.join("\n")).toContain("已清除");
  expect((await store.load()).promptTemplate).toBeUndefined();
  await cleanup();
});

// ───────────────────────── /rewind ─────────────────────────

test("/rewind：检查点未启用时明确告警并认领输入", async () => {
  const { deps, cleanup } = await setup();
  const outcome = await handleSlashCommand("/rewind", deps());
  expect(outcome.kind === "handled" && outcome.lines.join("\n")).toContain("检查点未启用");
  await cleanup();
});

test("/rewind 序号式：真实影子 git 上截断会话并返回 refresh=history（列表最新在前）", async () => {
  const { store, deps, cleanup, dir } = await setup();
  const sandbox = await tempDir("dsh-cmd-ws-");
  try {
    const checkpoints = new CheckpointStore({
      shadowRoot: path.join(dir, "checkpoints", "c"),
      sandboxRoot: sandbox,
      sessionRecordCount: () => store.recordCount(),
    });
    // 第 1 号检查点在 0 条记录的边界；随后长出 2 条、再拍第 2 号（边界 2 条）
    await checkpoints.snapshot("第一轮");
    await store.append({ role: "user", content: "第一轮消息" });
    await store.append({ role: "assistant", content: "回答" });
    await checkpoints.snapshot("第二轮");
    await store.append({ role: "user", content: "第二轮消息" });
    await store.append({ role: "assistant", content: "回答2" });
    expect(await store.recordCount()).toBe(4);

    // 列表最新在前：编号 1 = 第二号检查点（边界 2 条）
    const outcome = await handleSlashCommand("/rewind 1 t", deps({ checkpoints }));
    expect(outcome.kind).toBe("handled");
    expect(outcome.kind === "handled" && outcome.lines.join("\n")).toContain("已恢复对话");
    expect(outcome.kind === "handled" && outcome.refresh).toBe("history");
    expect(await store.recordCount()).toBe(2);

    // 编号 2 = 第一号检查点（边界 0 条）；越界编号报错且不执行
    const older = await handleSlashCommand("/rewind 2 t", deps({ checkpoints }));
    expect(older.kind === "handled" && older.refresh).toBe("history");
    expect(await store.recordCount()).toBe(0);

    const outOfRange = await handleSlashCommand("/rewind 9 t", deps({ checkpoints }));
    expect(outOfRange.kind === "handled" && outOfRange.lines.join("\n")).toContain("超出范围");
    expect(outOfRange.kind === "handled" && outOfRange.refresh).toBeUndefined();
  } finally {
    await cleanup();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("/rewind 无参数且无 ask 通道（Web 形态）：只列清单并提示序号式用法", async () => {
  const { store, deps, cleanup, dir } = await setup();
  const sandbox = await tempDir("dsh-cmd-ws2-");
  try {
    const checkpoints = new CheckpointStore({
      shadowRoot: path.join(dir, "checkpoints", "c"),
      sandboxRoot: sandbox,
      sessionRecordCount: () => store.recordCount(),
    });
    await checkpoints.snapshot("第一轮");
    const outcome = await handleSlashCommand("/rewind", deps({ checkpoints }));
    const text = outcome.kind === "handled" ? outcome.lines.join("\n") : "";
    expect(text).toContain("检查点");
    expect(text).toContain("/rewind <编号>");
    expect(outcome.kind === "handled" && outcome.refresh).toBeUndefined();
    expect(await store.recordCount()).toBe(0); // 没有执行回滚
  } finally {
    await cleanup();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

// ───────────────────────── Web 会话检查点基建 ─────────────────────────

test("Web 会话检查点基建：createAgent 挂快照钩子，回合后 entry.checkpoints 可列出检查点", async () => {
  const dir = await tempDir("dsh-web-ckpt-");
  const sandbox = await tempDir("dsh-web-ckpt-ws-");
  const previousKey = process.env.OPENAI_API_KEY;
  if (previousKey === undefined) process.env.OPENAI_API_KEY = "test-unused-key";
  try {
    const hub = new EventHub();
    const bridge = new UiBridge(hub.publish, 5_000);
    const runtime = {
      // 检查点保持默认开启：本测试验证的就是 Web 会话的快照接线
      config: { ...loadAgentConfig(), model: "default-model", stream: false },
      registry: new ToolRegistry(), skills: [], sandbox: { backend: "host", reason: "test" },
      sandboxRoot: sandbox, mcp: { getStatus: () => [], closeAll: async () => {} },
    } as unknown as ServerRuntime;
    const manager = new SessionManager({ hub, bridge, runtime, sessionDir: dir, traceDir: path.join(dir, "trace") });
    const off = manager.subscribe("s1", () => {});
    await new Promise((resolve) => setTimeout(resolve, 80)); // hello 异步建 agent

    // 换立即应答的假 client：无 tools 的主调用与摘要调用都秒回
    const entry = (manager as any).entries.get("s1");
    entry.agent.client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "好的" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        },
      },
    };
    const sent = await manager.sendMessage("s1", "建检查点的一轮");
    expect(sent.queued).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400)); // 回合收尾（含命名/摘要后台调用）

    expect(entry.checkpoints).toBeDefined();
    const list = await entry.checkpoints.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].input).toBe("建检查点的一轮");
    off();
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
});
