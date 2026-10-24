// tests/prefix_cache.test.ts
// 前缀缓存的可观测性与稳定性：
//   - cachedTokensOf：prompt_tokens_details.cached_tokens 标准字段 + DeepSeek 原生回退
//   - cached tokens 透传：step 事件 / run_end 事件 / AgentResult
//   - run 内 append-only：未触发压缩时，连续请求的消息序列是同一组对象的前缀扩展
//   - 跨轮前缀稳定：长期摘要/任务块排在 history 之后，改它们不废掉 history 的缓存前缀
//   - SessionStore.compact 迟滞窗口：不满阈值不重写；有遗留脏记录时照常清理
// 运行: bun test ./tests/prefix_cache.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Agent, cachedTokensOf } from "../src/core/agent";
import { SessionStore } from "../src/core/session_store";
import { ToolRegistry } from "../src/core/registry";
import { defineTool } from "../src/core/types";
import type { Message, StepInfo } from "../src/core/types";
import type { RunEndEvent } from "../src/core/events";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function textOf(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => ("text" in p ? p.text : "")).join("");
  return "";
}

function simpleToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: "dummy",
      description: "测试工具",
      schema: z.object({}),
      parallelSafe: true,
      execute: async () => "工具结果",
    })
  );
  return registry;
}

/** 按脚本应答的 mock client：mainReply 按主调用序号取应答（摘要调用固定应答且计数递增），记下全部请求 */
function scriptedClient(mainReply: (mainIndex: number) => any) {
  const requests: any[] = [];
  let mainIndex = 0;
  let summaryCount = 0;
  const client: any = {
    chat: {
      completions: {
        create: async (params: any) => {
          requests.push(params);
          if (!params.tools?.length) {
            summaryCount++;
            return {
              choices: [{ message: { content: `## 任务与目标\n第 ${summaryCount} 次摘要内容` } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          const reply = mainReply(mainIndex);
          mainIndex++;
          return reply;
        },
      },
    },
  };
  return { client, requests, mainRequests: () => requests.filter((r) => r.tools?.length) };
}

const toolCallChoice = (id: string, name = "dummy") => ({
  message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
  finish_reason: "tool_calls",
});
const finalChoice = (content: string) => ({ message: { content }, finish_reason: "stop" });

// ───────────────────────── cachedTokensOf 解析 ─────────────────────────

describe("cachedTokensOf", () => {
  test("标准字段 prompt_tokens_details.cached_tokens", () => {
    expect(cachedTokensOf({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 60 } } as any)).toBe(60);
  });

  test("DeepSeek 原生顶层 prompt_cache_hit_tokens 回退", () => {
    expect(cachedTokensOf({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      prompt_cache_hit_tokens: 30 } as any)).toBe(30);
  });

  test("两个都没有 / undefined → 0", () => {
    expect(cachedTokensOf({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } as any)).toBe(0);
    expect(cachedTokensOf(undefined)).toBe(0);
  });
});

// ───────────────────────── cached tokens 透传 ─────────────────────────

describe("缓存命中记账", () => {
  test("step/run_end 事件与 AgentResult 携带 cachedPromptTokens（含 DeepSeek 原生回退）", async () => {
    const dir = await tempDir("dsh-cache-ledger-");
    const { client } = scriptedClient((index) =>
      index % 2 === 0
        ? { choices: [toolCallChoice(`c${index}`)], usage: { prompt_tokens: 100, completion_tokens: 5,
            total_tokens: 105, prompt_tokens_details: { cached_tokens: 60 } } }
        : { choices: [finalChoice("答案")], usage: { prompt_tokens: 120, completion_tokens: 5,
            total_tokens: 125, prompt_cache_hit_tokens: 20 } });
    const agent = new Agent({
      model: "glm-4.6", systemPrompt: "系统规则", client,
      tools: simpleToolRegistry(), sessionStore: new SessionStore({ dir, sessionId: "t" }),
    });
    const steps: StepInfo[] = [];
    const ends: RunEndEvent[] = [];
    agent.events.on("step", ({ step }) => steps.push(step));
    agent.events.on("run_end", (event) => ends.push(event));
    const result = await agent.run("查一下");
    await agent.flushSummary();

    expect(result.cachedPromptTokens).toBe(80); // 60 + 20
    expect(steps.map((s) => s.tokens.cachedPromptTokens)).toEqual([60, 20]);
    expect(ends.at(-1)?.cachedPromptTokens).toBe(80);
    // 口径不变：cached 已含在 promptTokens 内；fold 的 15 tokens 补记进下一轮，不进本轮
    expect(result.totalTokens).toBe(105 + 125);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("provider 不上报时结果里没有该字段（additive）", async () => {
    const dir = await tempDir("dsh-cache-none-");
    const { client } = scriptedClient(() => ({ choices: [finalChoice("答案")],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    const agent = new Agent({
      model: "glm-4.6", systemPrompt: "系统规则", client,
      sessionStore: new SessionStore({ dir, sessionId: "t" }),
    });
    const result = await agent.run("你好");
    expect(result.cachedPromptTokens).toBeUndefined();
    expect(result.steps[0]!.tokens.cachedPromptTokens).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ───────────────────────── run 内 append-only ─────────────────────────

describe("run 内前缀稳定", () => {
  test("未触发压缩时，连续请求是同一组消息对象的前缀扩展", async () => {
    const dir = await tempDir("dsh-cache-append-");
    const { client, mainRequests } = scriptedClient((index) =>
      index % 2 === 0
        ? { choices: [toolCallChoice(`c${index}`)], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }
        : { choices: [finalChoice("完成")], usage: { prompt_tokens: 70, completion_tokens: 5, total_tokens: 75 } });
    const agent = new Agent({
      model: "glm-4.6", systemPrompt: "系统规则", client,
      tools: simpleToolRegistry(), sessionStore: new SessionStore({ dir, sessionId: "t" }),
    });
    const compacts: string[] = [];
    agent.events.on("compact", (event) => compacts.push(event.action));
    await agent.run("做两步");
    await agent.flushSummary();

    const mains = mainRequests();
    expect(mains.length).toBe(2); // 工具调用一次 + 终答一次
    // 全程没有动过请求消息的压缩动作（longterm_summary 是落盘的后台记忆更新，不碰请求序列）
    expect(compacts.filter((action) => action !== "longterm_summary")).toEqual([]);
    for (let next = 1; next < mains.length; next++) {
      const prev = mains[next - 1]!;
      const cur = mains[next]!;
      expect(cur.messages.length).toBeGreaterThan(prev.messages.length);
      for (let i = 0; i < prev.messages.length; i++) {
        expect(cur.messages[i]).toBe(prev.messages[i]); // 对象身份一致 = 序列化字节一致
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ───────────────────────── 跨轮前缀稳定 ─────────────────────────

describe("跨轮前缀稳定", () => {
  test("长期摘要/任务块排在 history 之后：更新它们不废掉 history 的缓存前缀", async () => {
    const dir = await tempDir("dsh-cache-crossrun-");
    const store = new SessionStore({ dir, sessionId: "t" });
    // 每轮都是"工具调用 → 终答"两步；每轮 fold 的摘要内容递增（长期块真的在变）
    const { client, mainRequests } = scriptedClient((index) => {
      const round = Math.floor(index / 2) + 1;
      return index % 2 === 0
        ? { choices: [toolCallChoice(`c${index}`)], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }
        : { choices: [finalChoice(`第${round}轮答案`)], usage: { prompt_tokens: 60, completion_tokens: 5, total_tokens: 65 } };
    });
    const agent = new Agent({
      model: "glm-4.6", systemPrompt: "系统规则", client, tools: simpleToolRegistry(), sessionStore: store,
    });
    await agent.run("第一问");
    await agent.run("第二问");
    await agent.run("第三问");
    await agent.flushSummary();

    const mains = mainRequests();
    // 第一轮 2 个主调用、第二/三轮各 2 个
    expect(mains.length).toBe(6);
    const run2Last = mains[3]!; // 第二轮的终答调用
    const run3First = mains[4]!; // 第三轮的首次调用

    // 第三轮的全部 history 消息（user1/aF1/user2/aF2）都在长期摘要块之前
    const texts3 = (run3First.messages as Message[]).map(textOf);
    const ltIndex = texts3.findIndex((t) => t.includes("长期记忆摘要"));
    expect(ltIndex).toBeGreaterThan(0);
    const historyTexts = ["第一问", "第1轮答案", "第二问", "第2轮答案"];
    for (const marker of historyTexts) {
      expect(texts3.findIndex((t) => t.includes(marker))).toBeLessThan(ltIndex);
    }
    // 任务记录块也在 history 之后（它的 actions 每轮都在变）
    const taskIndex = texts3.findIndex((t) => t.includes("持久化任务记录"));
    expect(taskIndex).toBeGreaterThan(ltIndex);

    // 缓存关键性质：run3 首请求与 run2 末请求的公共前缀覆盖到当时的全部 history
    // （system, user1, aF1）——旧顺序下 longTerm 占据 [1]，fold 一变前缀就废。
    const shared = 3;
    for (let i = 0; i < shared; i++) {
      expect(JSON.stringify(run3First.messages[i])).toBe(JSON.stringify(run2Last.messages[i]));
    }
    expect(JSON.stringify(run3First.messages[shared])).not.toBe(JSON.stringify(run2Last.messages[shared]));

    // 长期摘要确实变了（第 N 次摘要内容），不是碰巧没更新
    expect(texts3[ltIndex]).toContain("摘要内容");

    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ───────────────────────── compact 迟滞窗口 ─────────────────────────

describe("SessionStore.compact 迟滞", () => {
  async function writeTurns(store: SessionStore, from: number, to: number): Promise<void> {
    for (let i = from; i <= to; i++) {
      await store.append({ role: "user", content: `第${i}问` });
      await store.append({ role: "assistant", content: `第${i}答` });
    }
  }
  async function lineCount(store: SessionStore): Promise<number> {
    const raw = await fs.readFile(store.filePath, "utf-8");
    return raw.split("\n").filter((line) => line.trim()).length;
  }

  test("不满 maxTurns+slack 不重写文件", async () => {
    const dir = await tempDir("dsh-compact-hyst-");
    const store = new SessionStore({ dir, sessionId: "t" });
    await writeTurns(store, 1, 21); // 21 轮 = 42 条，阈值 20+5=25 轮
    await store.compact(20);
    expect(await lineCount(store)).toBe(42);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("超过阈值一次性裁回 maxTurns", async () => {
    const dir = await tempDir("dsh-compact-trim-");
    const store = new SessionStore({ dir, sessionId: "t" });
    await writeTurns(store, 1, 26); // 26 轮 > 25
    await store.compact(20);
    expect(await lineCount(store)).toBe(40);
    const loaded = await store.load();
    expect(loaded.messages.map(textOf)).toEqual(
      expect.arrayContaining(["第26问", "第26答"])
    );
    expect(loaded.messages.map(textOf)).not.toContain("第6问"); // 最早的 6 轮被裁
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("遗留的工具组记录不受迟滞保护，照常清理", async () => {
    const dir = await tempDir("dsh-compact-legacy-");
    const store = new SessionStore({ dir, sessionId: "t" });
    await store.append({ role: "user", content: "旧版第一问" });
    await store.append({ role: "assistant", content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: "{}" } }] } as Message);
    await store.append({ role: "tool", tool_call_id: "t1", content: "旧工具输出" });
    await store.append({ role: "assistant", content: "旧版最终回答" });
    await store.compact(20);
    expect(await lineCount(store)).toBe(2); // 只剩 user + 最终回答
    await fs.rm(dir, { recursive: true, force: true });
  });
});
