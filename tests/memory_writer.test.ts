// tests/memory_writer.test.ts
// 运行: bun test ./tests/memory_writer.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import OpenAI from "openai";
import { MemoryStore } from "../src/core/memory_store";
import { MemoryWriter } from "../src/core/memory_writer";
import type { EmbeddingClient } from "../src/rag/embeddings";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 假 LLM 客户端：固定返回 content，不联网 */
function fakeClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    },
  } as unknown as OpenAI;
}

/** 含"bun"→[1,0]，含"docker"→[0,1]，其余→[0,0] 的关键词假 embedding */
const fakeEmbeddings: EmbeddingClient = {
  model: "fake-embed",
  embed: async (inputs) =>
    inputs.map((text) => {
      if (text.includes("bun")) return [1, 0];
      if (text.includes("docker")) return [0, 1];
      return [0, 0];
    }),
};

const ARRAY_OF = (facts: Array<Record<string, string>>) => JSON.stringify(facts);

describe("MemoryWriter", () => {
  test("提取事实写入记忆仓，带来源会话与 token 成本", async () => {
    const store = new MemoryStore({ dir: await tmpDir("agent-memory-") });
    const writer = new MemoryWriter({
      store,
      client: fakeClient(ARRAY_OF([{ type: "feedback", text: "提交信息用中文一行式" }])),
      model: "fake",
      embeddings: null,
    });
    const report = await writer.writeFromRun("用户请求：修 bug", { sourceSessionId: "session-a" });
    expect(report.added).toBe(1);
    expect(report.tokens).toBe(15);
    const [entry] = await store.active();
    expect(entry!.type).toBe("feedback");
    expect(entry!.sourceSessionId).toBe("session-a");
  });

  test("空数组与围栏包裹的 JSON 都能正确处理", async () => {
    const store = new MemoryStore({ dir: await tmpDir("agent-memory-") });
    const writer = new MemoryWriter({ store, client: fakeClient("[]"), model: "fake" });
    const report = await writer.writeFromRun("普通闲聊");
    expect(report).toMatchObject({ added: 0, superseded: 0, skipped: 0, tokens: 15 });

    const fenced = new MemoryWriter({
      store,
      client: fakeClient("```json\n" + ARRAY_OF([{ type: "user", text: "用户在写论文" }]) + "\n```"),
      model: "fake",
    });
    expect((await fenced.writeFromRun("x")).added).toBe(1);
  });

  test("与已有记忆语义重复的事实被跳过（embedding 阈值查重）", async () => {
    const store = new MemoryStore({ dir: await tmpDir("agent-memory-") });
    await store.add({ type: "user", text: "用户偏好 bun 管理依赖" });
    const writer = new MemoryWriter({
      store,
      client: fakeClient(ARRAY_OF([{ type: "user", text: "用户使用 bun 作为包管理器" }])),
      model: "fake",
      embeddings: fakeEmbeddings,
    });
    const report = await writer.writeFromRun("x");
    expect(report.added).toBe(0);
    expect(report.skipped).toBe(1);
    expect((await store.active()).length).toBe(1);
  });

  test("supersedes 命中现有条目：旧条目作废留痕、新事实入库", async () => {
    const store = new MemoryStore({ dir: await tmpDir("agent-memory-") });
    const old = (await store.add({ type: "user", text: "用户用 docker 跑测试" }))!;
    const writer = new MemoryWriter({
      store,
      client: fakeClient(
        ARRAY_OF([{ type: "user", text: "用户改用 bun 跑测试", supersedes: "用户用 docker 跑测试" }])
      ),
      model: "fake",
      embeddings: fakeEmbeddings,
    });
    const report = await writer.writeFromRun("x");
    expect(report.added).toBe(1);
    expect(report.superseded).toBe(1);

    const all = await store.list();
    const oldEntry = all.find((entry) => entry.id === old.id)!;
    expect(oldEntry.supersededAt).toBeDefined();
    const active = await store.active();
    expect(active.length).toBe(1);
    expect(active[0]!.text).toBe("用户改用 bun 跑测试");
  });

  test("语义命中但 LLM 未声明 supersedes：只跳过不自动取代（宁漏勿错）", async () => {
    const store = new MemoryStore({ dir: await tmpDir("agent-memory-") });
    await store.add({ type: "user", text: "用户偏好 bun 管理依赖" });
    const writer = new MemoryWriter({
      store,
      client: fakeClient(ARRAY_OF([{ type: "user", text: "用户改用 bun 跑测试" }])),
      model: "fake",
      embeddings: fakeEmbeddings,
    });
    const report = await writer.writeFromRun("x");
    expect(report.skipped).toBe(1);
    expect(report.superseded).toBe(0);
    expect((await store.active()).length).toBe(1);
  });

  test("输出不是 JSON 数组时抛错（调用方转 memory_failed 事件）", async () => {
    const store = new MemoryStore({ dir: await tmpDir("agent-memory-") });
    const writer = new MemoryWriter({ store, client: fakeClient("我觉得这轮没什么好记的"), model: "fake" });
    await expect(writer.writeFromRun("x")).rejects.toThrow("JSON 数组");
  });

  test("type 非法或 text 为空的条目被过滤，不写坏记忆仓", async () => {
    const store = new MemoryStore({ dir: await tmpDir("agent-memory-") });
    const writer = new MemoryWriter({
      store,
      client: fakeClient(
        ARRAY_OF([
          { type: "secret", text: "坏类型" },
          { type: "user", text: "   " },
          { type: "project", text: "合法的一条" },
        ])
      ),
      model: "fake",
    });
    expect((await writer.writeFromRun("x")).added).toBe(1);
    expect((await store.active())[0]!.text).toBe("合法的一条");
  });
});
