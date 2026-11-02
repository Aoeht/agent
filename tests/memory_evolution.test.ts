import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import OpenAI from "openai";
import { MemoryStore, type MemoryEntry, type MemoryRelation } from "../src/core/memory_store";
import { MemoryWriter, type MemoryFact } from "../src/core/memory_writer";
import { createMemoryTool } from "../src/tools/memory";
import type { EmbeddingClient } from "../src/rag/embeddings";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-evolution-"));
  dirs.push(dir);
  return new MemoryStore({ dir });
}
const sameVector: EmbeddingClient = { model: "all-similar", embed: async texts => texts.map(() => [1, 0]) };
function client(facts: unknown[], judge: (data: { candidates: MemoryEntry[]; fact: MemoryFact }) => unknown | Promise<unknown>): OpenAI {
  return { chat: { completions: { create: async (request: { messages: Array<{ content: string }> }) => {
    const judging = request.messages[0]!.content.includes("关系判定器");
    const result = judging ? await judge(JSON.parse(request.messages[1]!.content)) : facts;
    return { choices: [{ message: { content: JSON.stringify(result) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  } } } } as unknown as OpenAI;
}
function relation(value: MemoryRelation) {
  return (data: { candidates: MemoryEntry[] }) => ({ relation: value, targetId: data.candidates[0]!.id });
}

describe("memory evolution: similar does not imply duplicate", () => {
  for (const [before, after] of [
    ["项目使用 MySQL", "项目已迁移到 PostgreSQL"],
    ["接口限流每分钟 100 次", "接口限流已调整为每分钟 200 次"],
    ["用户允许自动提交", "用户不再允许自动提交"],
  ]) {
    test("高相似变更保留新版本：" + after, async () => {
      const store = await makeStore();
      const old = (await store.add({ type: "project", text: before!, scope: "repo-a" }))!;
      const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector,
        client: client([{ type: "project", text: after, scope: "repo-a" }], relation("update")) });
      expect(await writer.writeFromRun(after!, { sourceSessionId: "new-session" })).toMatchObject({
        added: 1, superseded: 1, skipped: 0, conflicts: 0, tokens: 30,
      });
      const restarted = new MemoryStore({ dir: store.dir });
      const [current] = await restarted.active();
      expect(current).toMatchObject({ text: after, supersedesId: old.id, sourceSessionId: "new-session", scope: "repo-a" });
      expect((await restarted.list()).find(e => e.id === old.id)).toMatchObject({ text: before, supersededBy: current!.id });
      expect(await restarted.loadIndex()).not.toContain(before!);
    });
  }

  test("项目范围和记忆类型隔离，即使向量完全相同也不互相覆盖", async () => {
    const store = await makeStore();
    await store.add({ type: "project", text: "数据库 MySQL", scope: "repo-a" });
    await store.add({ type: "reference", text: "数据库 MySQL", scope: "repo-b" });
    let calls = 0;
    const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector,
      client: client([{ type: "project", text: "数据库 PostgreSQL", scope: "repo-b" }], () => { calls++; return {}; }) });
    expect((await writer.writeFromRun("repo-b 使用 PostgreSQL")).added).toBe(1);
    expect(calls).toBe(0);
    expect(await store.active()).toHaveLength(3);
  });

  test("没有 embedding 或向量服务失败仍能通过词法候选处理更新", async () => {
    for (const embeddings of [null, { model: "broken", embed: async () => { throw new Error("offline"); } }]) {
      const store = await makeStore();
      await store.add({ type: "project", text: "项目数据库 MySQL" });
      const writer = new MemoryWriter({ store, model: "fake", embeddings,
        client: client([{ type: "project", text: "项目数据库 PostgreSQL" }], relation("update")) });
      expect((await writer.writeFromRun("明确迁移数据库")).superseded).toBe(1);
      expect((await store.active())[0]!.text).toContain("PostgreSQL");
    }
  });

  test("未知冲突隔离，工具确认后原子更新；旧数据保持可追溯", async () => {
    const store = await makeStore();
    const old = (await store.add({ type: "project", text: "部署区域香港" }))!;
    const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector,
      client: client([{ type: "project", text: "部署区域新加坡" }], relation("conflict")) });
    expect((await writer.writeFromRun("来源不确定")).conflicts).toBe(1);
    expect(await store.active()).toEqual([old]);
    expect((await store.search("新加坡")).total).toBe(0);
    expect(await store.loadIndex()).not.toContain("新加坡");
    const tool = createMemoryTool(store);
    const result = await tool.execute({ action: "conflicts" }) as { entries: MemoryEntry[]; total: number };
    expect(result.total).toBe(1);
    await tool.execute({ action: "resolve", id: result.entries[0]!.id, resolution: "accepted" });
    expect((await store.active())[0]!.text).toBe("部署区域新加坡");
    expect(await store.conflicts()).toHaveLength(0);
    expect(await store.list()).toHaveLength(2);
  });

  test("拒绝冲突不改变原记忆；候选变化后不能接受过期提案", async () => {
    const store = await makeStore();
    const old = (await store.add({ type: "user", text: "偏好短回答" }))!;
    const pending = (await store.applyFact({ type: "user", text: "偏好长回答" }, "conflict", old)).entry!;
    await store.update(old.id, "偏好按问题长度回答");
    await expect(store.resolveConflict(pending.id, "accepted")).rejects.toThrow("旧记忆已经变化");
    await store.resolveConflict(pending.id, "rejected");
    expect((await store.active())[0]!.text).toBe("偏好按问题长度回答");
    expect(await store.conflicts()).toHaveLength(0);
  });

  test("历史事实不能按到达顺序替换未来生效事实", async () => {
    const store = await makeStore();
    await store.add({ type: "project", text: "限流 200", validFrom: "2026-10-01T00:00:00.000Z" });
    const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector,
      client: client([{ type: "project", text: "限流 100", validFrom: "2026-09-01" }], relation("update")) });
    expect((await writer.writeFromRun("九月的历史记录")).conflicts).toBe(1);
    expect((await store.active())[0]!.text).toBe("限流 200");
    expect((await store.conflicts())[0]!.validFrom).toBe("2026-09-01T00:00:00.000Z");
  });

  test("非法判定和伪造 targetId 不能更改记忆，也不冒充去重成功", async () => {
    for (const decision of [null, [], { relation: "delete" }, { relation: "update", targetId: "invented" }]) {
      const store = await makeStore();
      const old = (await store.add({ type: "project", text: "数据库 MySQL" }))!;
      const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector,
        client: client([{ type: "project", text: "数据库 PostgreSQL" }], () => decision) });
      expect(await writer.writeFromRun("变化")).toMatchObject({ added: 0, skipped: 0, deferred: 1, tokens: 30 });
      expect(await store.active()).toEqual([old]);
    }
  });

  test("LLM 判定期间并发修改旧事实，提交阶段拒绝过期版本", async () => {
    const store = await makeStore();
    const old = (await store.add({ type: "project", text: "限流 100" }))!;
    const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector,
      client: client([{ type: "project", text: "限流 200" }], async data => {
        await new MemoryStore({ dir: store.dir }).update(old.id, "限流 300");
        return relation("update")(data);
      }) });
    expect((await writer.writeFromRun("变化")).deferred).toBe(1);
    expect((await store.active())[0]!.text).toBe("限流 300");
  });

  test("同批两次更新使用最新版本；完全重复不额外调用模型", async () => {
    const store = await makeStore();
    await store.add({ type: "project", text: "限流 100" });
    const seen: string[] = [];
    const facts = ["限流 200", "限流 300", "限流 300"].map(text => ({ type: "project", text }));
    const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector, client: client(facts, data => {
      seen.push(data.candidates[0]!.text); return relation("update")(data);
    }) });
    expect(await writer.writeFromRun("先 200 后 300")).toMatchObject({ added: 2, superseded: 2, skipped: 1, tokens: 45 });
    expect(seen).toEqual(["限流 100", "限流 200"]);
    expect((await store.active())[0]!.text).toBe("限流 300");
  });

  test("取消发生在判定后时不提交新事实", async () => {
    const store = await makeStore();
    const old = (await store.add({ type: "project", text: "限流 100" }))!;
    const abort = new AbortController();
    const writer = new MemoryWriter({ store, model: "fake", embeddings: sameVector,
      client: client([{ type: "project", text: "限流 200" }], data => { abort.abort(); return relation("update")(data); }) });
    await expect(writer.writeFromRun("更新", { signal: abort.signal })).rejects.toThrow();
    expect(await store.active()).toEqual([old]);
  });
});

describe("atomic memory mutations", () => {
  test("权威文件提交失败时旧记忆仍有效；重启后也没有半次替换", async () => {
    const store = await makeStore();
    const old = (await store.add({ type: "project", text: "旧事实" }))!;
    // Instance-local fault injection avoids mocking filesystem operations in concurrent test files.
    const internal = store as unknown as { atomicWrite: (...args: unknown[]) => Promise<void> };
    const original = internal.atomicWrite;
    internal.atomicWrite = async () => { throw new Error("injected disk failure"); };
    try {
      await expect(store.applyFact({ type: "project", text: "新事实" }, "update", old)).rejects.toThrow("injected");
    } finally { internal.atomicWrite = original; }
    expect(await new MemoryStore({ dir: store.dir }).active()).toEqual([old]);
    expect((await store.applyFact({ type: "project", text: "新事实" }, "update", old)).status).toBe("updated");
  });

  test("派生索引写失败不把已提交的事实报告为失败", async () => {
    const store = await makeStore();
    const old = (await store.add({ type: "project", text: "旧事实" }))!;
    const internal = store as unknown as { atomicWrite: (file: string, ...args: unknown[]) => Promise<void> };
    const original = internal.atomicWrite;
    internal.atomicWrite = async (file, ...args) => {
      if (file.endsWith("MEMORY.md")) throw new Error("index unavailable");
      return original.call(store, file, ...args);
    };
    try {
      expect((await store.applyFact({ type: "project", text: "新事实" }, "update", old)).status).toBe("updated");
    } finally { internal.atomicWrite = original; }
    expect(await store.loadIndex()).toContain("新事实");
  });

  test("多实例并发写不丢失；竞争替换最多一个成功", async () => {
    const store = await makeStore();
    const stores = Array.from({ length: 6 }, () => new MemoryStore({ dir: store.dir }));
    await Promise.all(stores.map((s, i) => s.add({ type: "project", text: "事实 " + i })));
    expect(await store.active()).toHaveLength(6);
    const old = (await store.active())[0]!;
    const results = await Promise.all(stores.map((s, i) => s.applyFact({ type: "project", text: "替换 " + i }, "update", old)));
    expect(results.filter(r => r.status === "updated")).toHaveLength(1);
    expect(results.filter(r => r.status === "stale")).toHaveLength(5);
    expect(await store.active()).toHaveLength(6);
  });

  test("跨范围替换被存储层拒绝；replace 工具保留范围和版本关联", async () => {
    const store = await makeStore();
    const old = (await store.add({ type: "project", text: "MySQL", scope: "a" }))!;
    expect((await store.applyFact({ type: "project", text: "PostgreSQL", scope: "b" }, "update", old)).status).toBe("stale");
    await createMemoryTool(store).execute({ action: "replace", id: old.id, text: "PostgreSQL" });
    expect((await store.active())[0]).toMatchObject({ scope: "a", supersedesId: old.id, text: "PostgreSQL" });
  });
});

