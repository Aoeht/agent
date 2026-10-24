// tests/memory_recall.test.ts
// 运行: bun test ./tests/memory_recall.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryRecall } from "../src/core/memory_recall";
import type { EmbeddingClient } from "../src/rag/embeddings";
import { LONG_TERM_SUMMARY_PREFIX, SESSION_NAME_PREFIX } from "../src/core/session_store";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSession(dir: string, sessionId: string, records: Array<Record<string, unknown>>): Promise<void> {
  const body = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), body, "utf-8");
}

const summaryOf = (text: string) => ({ role: "user", content: `${LONG_TERM_SUMMARY_PREFIX}${text}` });
const nameOf = (text: string) => ({ role: "user", content: `${SESSION_NAME_PREFIX}${text}` });

/** 关键词假 embedding：含"诈骗"→[1,0]，含"部署"→[0,1]，其余→[0,0]——向量正交，排序确定 */
const fakeEmbeddings: EmbeddingClient = {
  model: "fake-embed",
  embed: async (inputs) =>
    inputs.map((text) => {
      if (text.includes("诈骗")) return [1, 0];
      if (text.includes("部署")) return [0, 1];
      return [0, 0];
    }),
};

describe("MemoryRecall", () => {
  test("refresh 抽取各会话最新长期摘要与会话名，recall 命中语义最相关的会话", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "session-scam", [
      { role: "user", content: "普通对话" },
      { role: "assistant", content: "好的" },
      nameOf("诈骗扫描"),
      summaryOf("## 任务与目标\n扫描视频诈骗风险，产出证据报告"),
    ]);
    await writeSession(sessionDir, "session-deploy", [
      nameOf("部署调优"),
      summaryOf("## 任务与目标\n优化 Docker 部署流程与镜像体积"),
    ]);
    // 同会话两条摘要：只取最后一条
    await writeSession(sessionDir, "session-scam-v2", [
      summaryOf("旧摘要：无关内容"),
      summaryOf("## 任务与目标\n诈骗词表与 inspect_link 共用"),
    ]);

    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: fakeEmbeddings });
    const hits = await recall.recall("帮我查一下诈骗链接的检测");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // 两个诈骗会话同分（向量正交假 embedding 下都是 1.0），按 id 定序取前者
    expect(hits[0]!.sessionId).toBe("session-scam");
    // 同会话两条摘要：只取最后一条
    const v2 = hits.find((hit) => hit.sessionId === "session-scam-v2")!;
    expect(v2.summary).toContain("inspect_link");
    expect(v2.name).toBeUndefined(); // 该会话没有【会话名】记录
    // 不相关的会话（正交向量）不会排在前面
    expect(hits.find((hit) => hit.sessionId === "session-deploy")).toBeUndefined();

    const block = await recall.recallBlock("帮我查一下诈骗链接的检测");
    expect(block).toContain("会话 session-scam-v2");
    expect(block).toContain("相关度 1.00");
  });

  test("excludeSessionId 排除当前会话；无命中返回空串", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "current", [summaryOf("诈骗现场处置流程")]);
    await writeSession(sessionDir, "other", [summaryOf("诈骗词表维护")]);

    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: fakeEmbeddings });
    const block = await recall.recallBlock("诈骗词表有哪些", { excludeSessionId: "current" });
    expect(block).toContain("other");
    expect(block).not.toContain("current");

    const none = await recall.recallBlock("完全无关的问题比如量子波动");
    expect(none).toBe("");
  });

  test("未配置 embedding 时召回整体停用（recall/recallBlock 恒空，不抛错）", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "s1", [summaryOf("诈骗扫描")]);
    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: null });
    expect(await recall.available()).toBe(false);
    expect(await recall.recallBlock("诈骗")).toBe("");
  });

  test("侧车缓存跨实例复用：新实例不用重读会话文件也能召回", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "s1", [summaryOf("诈骗扫描证据预处理")]);

    const first = new MemoryRecall({ sessionDir, cacheDir, embeddings: fakeEmbeddings });
    expect(await first.recallBlock("诈骗")).not.toBe("");

    // 删除会话文件后新实例从侧车读到索引——但 refresh 会发现文件消失并剔除
    await fs.rm(path.join(sessionDir, "s1.jsonl"));
    const second = new MemoryRecall({ sessionDir, cacheDir, embeddings: fakeEmbeddings });
    expect(await second.recallBlock("诈骗")).toBe("");
    // 会话还在时，新实例零重读直接命中
    await writeSession(sessionDir, "s1", [summaryOf("诈骗扫描证据预处理")]);
    const third = new MemoryRecall({ sessionDir, cacheDir, embeddings: fakeEmbeddings });
    expect(await third.recallBlock("诈骗")).toContain("s1");
  });

  test("摘要内容进入向量缓存：同查询第二次调用不触发 embedding", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "s1", [summaryOf("诈骗扫描证据预处理")]);
    let calls = 0;
    const counting: EmbeddingClient = {
      model: "fake-embed",
      embed: async (inputs) => {
        calls += inputs.length;
        return fakeEmbeddings.embed(inputs);
      },
    };
    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: counting });
    await recall.recallBlock("诈骗");
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    await recall.recallBlock("诈骗");
    expect(calls).toBe(afterFirst);
  });

  test("会话名注入到召回标签里", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "s1", [nameOf("诈骗扫描"), summaryOf("诈骗词表与快照契约")]);
    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: fakeEmbeddings });
    expect(await recall.recallBlock("诈骗")).toContain("会话 s1 · 诈骗扫描");
  });
});
