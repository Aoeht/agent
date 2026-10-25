// tests/memory_recall.test.ts
// 运行: bun test ./tests/memory_recall.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryRecall } from "../src/core/memory_recall";
import { chunkMemorySummary } from "../src/core/memory_chunks";
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
    expect(hits[0]!.channels).toContain("vector");
    // 同会话两条摘要：只取最后一条
    const v2 = hits.find((hit) => hit.sessionId === "session-scam-v2")!;
    expect(v2.summary).toContain("inspect_link");
    expect(v2.name).toBeUndefined(); // 该会话没有【会话名】记录
    // 不相关的会话（正交向量）不会排在前面
    expect(hits.find((hit) => hit.sessionId === "session-deploy")).toBeUndefined();

    const block = await recall.recallBlock("帮我查一下诈骗链接的检测");
    expect(block).toContain("会话 session-scam-v2");
    expect(block).toContain("vector");
    expect(block).toContain("融合分");
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

  test("未配置 embedding 时使用关键词召回，不调用向量服务", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "s1", [summaryOf("诈骗扫描")]);
    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: null });
    expect(await recall.available()).toBe(true);
    expect(await recall.recallBlock("诈骗")).toContain("s1");
    expect((await recall.recall("诈骗"))[0]!.channels).toEqual(["keyword"]);
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

  test("按章节分块，长正文有重叠且不丢尾部；未变块 ID 稳定", () => {
    const text = "## 背景\n" + Array.from({ length: 120 }, (_, i) => `这是第 ${i} 项背景材料。`).join("") + "\n## 决策\n上线前必须执行迁移验证。";
    const chunks = chunkMemorySummary("s1", text, 100);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.text.length <= 100)).toBe(true);
    const last = chunks.at(-1)!;
    expect(last.section).toBe("决策");
    expect(last.text).toContain("迁移验证");
    expect(chunkMemorySummary("s1", `## 新章\n新增内容\n${text}`, 100).at(-1)!.chunkId).toBe(last.chunkId);
    const long = chunkMemorySummary("s1", "abcdefghij".repeat(55), 100);
    expect(long.map(chunk => chunk.text).join("")).toContain("abcdefghij".repeat(5));
    expect(() => chunkMemorySummary("s1", text, 0)).toThrow("chunkChars");
    const boundary = chunkMemorySummary("boundary", "背景".repeat(207) + " BOUNDARY731 的处理方法已验证", 500);
    expect(boundary.some(chunk => chunk.text.includes("BOUNDARY731"))).toBe(true);
    expect(boundary.every(chunk => chunk.text.length <= 500)).toBe(true);
  });

  test("旧侧车自动重建，4000 字符之后的证据可检索且实际注入命中块", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    const text = `## 背景\n${"普通背景资料。".repeat(600)}\n## 结论\n故障编号 ZXQ942 的处理方法是重建连接池。`;
    await writeSession(sessionDir, "long", [summaryOf(text)]);
    const stat = await fs.stat(path.join(sessionDir, "long.jsonl"));
    await fs.writeFile(path.join(cacheDir, "session-index.json"), JSON.stringify({ version: 1,
      sessions: { long: { mtimeMs: stat.mtimeMs, size: stat.size, summary: text.slice(0, 4000) } } }));
    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: null });
    const block = await recall.recallBlock("ZXQ942");
    expect(block).toContain("重建连接池");
    expect(block).toContain("结论");
    expect(block).not.toContain("普通背景资料");
    expect(block.length).toBeLessThan(800);
  });

  test("向量异常降级；同义改写能单独由向量命中", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "s1", [summaryOf("## 操作\n发布前备份数据库")]);
    const failed = new MemoryRecall({ sessionDir, cacheDir, embeddings: {
      model: "failed", embed: async () => { throw new Error("offline"); },
    } });
    expect((await failed.recall("数据库"))[0]!.channels).toEqual(["keyword"]);
    const semantic = new MemoryRecall({ sessionDir, cacheDir, embeddings: {
      model: "synonym", embed: async texts => texts.map(() => [1, 0]),
    } });
    const hits = await semantic.recall("save a snapshot before rollout");
    expect(hits[0]!.summary).toContain("备份数据库");
    expect(hits[0]!.channels).toEqual(["vector"]);
    expect(await semantic.recall("   ")).toEqual([]);
  });

  test("更新/删除后旧块不再召回，重复内容去重且单会话有结果限额", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "many", [summaryOf("## 一\n发布检查甲\n## 二\n发布检查乙\n## 三\n发布检查丙")]);
    await writeSession(sessionDir, "other", [summaryOf("发布检查丁")]);
    await writeSession(sessionDir, "copy", [summaryOf("发布检查丁")]);
    const recall = new MemoryRecall({ sessionDir, cacheDir, embeddings: null, topK: 5, maxChunksPerSession: 2 });
    const hits = await recall.recall("发布检查");
    expect(hits.filter(hit => hit.sessionId === "many")).toHaveLength(2);
    expect(hits.filter(hit => hit.summary === "发布检查丁")).toHaveLength(1);
    await writeSession(sessionDir, "many", [summaryOf("新的结论：迁移完成")]);
    expect((await recall.recall("发布检查")).some(hit => hit.sessionId === "many")).toBe(false);
    await fs.rm(path.join(sessionDir, "other.jsonl"));
    await fs.rm(path.join(sessionDir, "copy.jsonl"));
    expect(await recall.recall("发布检查")).toEqual([]);
    expect((await recall.recall("迁移完成"))[0]!.sessionId).toBe("many");
  });

  test("重启复用块向量缓存；排除当前会话后不会为其生成向量", async () => {
    const sessionDir = await tmpDir("agent-sessions-");
    const cacheDir = await tmpDir("agent-memory-");
    await writeSession(sessionDir, "current", [summaryOf("当前秘密内容")]);
    await writeSession(sessionDir, "other", [summaryOf("诈骗扫描")]);
    const inputs: string[] = [];
    const embeddings: EmbeddingClient = { model: "cached", embed: async texts => {
      inputs.push(...texts); return fakeEmbeddings.embed(texts);
    } };
    const options = { sessionDir, cacheDir, embeddings };
    const first = await new MemoryRecall(options).recall("诈骗", { excludeSessionId: "current" });
    const count = inputs.length;
    expect(inputs.join("\n")).not.toContain("秘密");
    expect(await new MemoryRecall(options).recall("诈骗", { excludeSessionId: "current" })).toEqual(first);
    expect(inputs.length).toBe(count);
  });
});
