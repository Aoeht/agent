// tests/memory_store.test.ts
// 运行: bun test ./tests/memory_store.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryStore, type MemoryEntry, type MemoryPage, type MemorySearchEntry } from "../src/core/memory_store";
import { createMemoryTool } from "../src/tools/memory";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
}

describe("MemoryStore", () => {
  test("add → list/active/loadIndex 往返，MEMORY.md 视图同步重渲", async () => {
    const dir = await tmpDir();
    const store = new MemoryStore({ dir });
    const entry = await store.add({ type: "user", text: "用户偏好 bun 而不是 npm" });
    expect(entry).toBeDefined();

    expect((await store.list()).length).toBe(1);
    expect((await store.active()).length).toBe(1);

    const index = await store.loadIndex();
    expect(index).toContain("## user（用户画像与偏好）");
    expect(index).toContain("用户偏好 bun 而不是 npm");
    expect(index).toContain(entry!.id);

    // 视图文件已生成且内容一致
    const view = await fs.readFile(path.join(dir, "MEMORY.md"), "utf-8");
    expect(view).toContain("用户偏好 bun 而不是 npm");
  });

  test("空记忆时 loadIndex 返回空串（调用方据此不注入）", async () => {
    const dir = await tmpDir();
    const store = new MemoryStore({ dir });
    expect(await store.loadIndex()).toBe("");
  });

  test("同类型同文本的重复 add 被跳过", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    await store.add({ type: "project", text: "论文数据集格式固定为报告 JSON" });
    const again = await store.add({ type: "project", text: "论文数据集格式固定为报告 JSON" });
    expect(again).toBeUndefined();
    expect((await store.active()).length).toBe(1);
  });

  test("forget 打 supersededAt：active 不再含它，list 保留痕迹，索引重渲", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const entry = (await store.add({ type: "feedback", text: "提交信息用中文一行式" }))!;
    expect(await store.forget(entry.id)).toBe(true);

    expect((await store.active()).length).toBe(0);
    const all = await store.list();
    expect(all.length).toBe(1);
    expect(all[0]!.supersededAt).toBeDefined();
    expect(await store.loadIndex()).toBe("");
    // 重复作废返回 false
    expect(await store.forget(entry.id)).toBe(false);
  });

  test("update 改正文并记 updatedAt；已作废条目不可更新", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const entry = (await store.add({ type: "reference", text: "评估看板在 /dashboard" }))!;
    const updated = (await store.update(entry.id, "评估看板迁移到 http://127.0.0.1:8787/metrics"))!;
    expect(updated.text).toContain("8787");
    expect(updated.updatedAt).toBeDefined();
    expect((await store.active())[0]!.text).toContain("8787");

    await store.forget(entry.id);
    expect(await store.update(entry.id, "再改")).toBeUndefined();
  });

  test("损坏行与字段不合法的行被跳过，好记录不受影响", async () => {
    const dir = await tmpDir();
    const store = new MemoryStore({ dir });
    await store.add({ type: "user", text: "第一条好记录" });
    const recordsPath = path.join(dir, "memory.jsonl");
    await fs.appendFile(recordsPath, "{broken json\n", "utf-8");
    await fs.appendFile(recordsPath, `${JSON.stringify({ id: "m-x", type: "bogus", text: "坏类型", createdAt: "t" })}\n`, "utf-8");
    await fs.appendFile(recordsPath, `${JSON.stringify({ id: "m-y", type: "user", text: "缺时间戳" })}\n`, "utf-8");

    const active = await store.active();
    expect(active.length).toBe(1);
    expect(active[0]!.text).toBe("第一条好记录");
  });

  test("超长正文截断到上限", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const entry = (await store.add({ type: "project", text: "长".repeat(2000) }))!;
    expect(entry.text.length).toBeLessThanOrEqual(501);
    expect(entry.text.endsWith("…")).toBe(true);
  });

  test("渲染索引按类型分节且最多 200 条，超出部分提示省略", async () => {
    const dir = await tmpDir();
    const store = new MemoryStore({ dir });
    for (let i = 0; i < 205; i++) {
      await store.add({ type: "project", text: `项目事实第 ${i} 条` });
    }
    const index = await store.loadIndex();
    expect(index).toContain("（仅显示前 200 条，其余 5 条已省略）");
    expect(index).not.toContain("项目事实第 204 条");
    expect(index).toContain("action=read offset=200");
    const all = await store.active();
    const paged: MemoryEntry[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: MemoryPage = await store.readPage({ offset, limit: 50 });
      expect(page.total).toBe(205);
      paged.push(...page.entries);
      offset = page.nextOffset;
    }
    expect(paged.map((entry) => entry.id)).toEqual(all.map((entry) => entry.id));
    expect((await store.readPage()).entries).toHaveLength(20);
    expect(await store.readPage({ offset: 205 })).toMatchObject({ entries: [], total: 205, nextOffset: null });
    expect(await store.readPage({ offset: 1000 })).toMatchObject({ entries: [], total: 205, nextOffset: null });
    const found = await store.search("204");
    expect(found.total).toBe(1);
    expect(found.entries[0]!.id).toBe(all[204]!.id);
  });

  test("类型筛选先于分页，作废条目不占位置，更新立即可见", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    await store.add({ type: "user", text: "用户偏好简短回答" });
    const old = (await store.add({ type: "project", text: "旧项目事实" }))!;
    const first = (await store.add({ type: "project", text: "第一条事实" }))!;
    const second = (await store.add({ type: "project", text: "第二条事实" }))!;
    await store.forget(old.id);
    await store.update(second.id, "更新后的事实");
    expect(await store.readPage({ type: "project", limit: 1 })).toMatchObject({
      total: 2, nextOffset: 1, entries: [{ id: first.id }],
    });
    expect(await store.readPage({ type: "project", limit: 1, offset: 1 })).toMatchObject({
      total: 2, nextOffset: null, entries: [{ id: second.id, text: "更新后的事实" }],
    });
    expect(await store.readPage({ type: "reference" })).toMatchObject({ entries: [], total: 0, nextOffset: null });
  });

  test("搜索支持中文和大小写归一化，按相关度分页，同分顺序稳定", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const both = (await store.add({ type: "project", text: "部署 Kubernetes" }))!;
    await store.add({ type: "project", text: "Kubernetes 集群维护需要检查日志并验证版本" });
    await store.add({ type: "reference", text: "Kubernetes 文档" });
    const all = await store.search("部署 KUBERNETES", { type: "project" });
    expect(all.total).toBe(2);
    expect(all.entries[0]!.id).toBe(both.id);
    expect(all.entries[0]!.score).toBeGreaterThan(all.entries[1]!.score);
    const first = await store.search("部署 KUBERNETES", { type: "project", limit: 1 });
    const next = await store.search("部署 KUBERNETES", { type: "project", offset: first.nextOffset!, limit: 1 });
    expect([...first.entries, ...next.entries]).toEqual(all.entries);
    expect(next.nextOffset).toBeNull();
    expect((await store.search("部署")).entries.map((entry) => entry.id)).toEqual([both.id]);
    expect((await store.search("kubernetes", { type: "reference" })).total).toBe(1);
    expect((await store.search("nevermatchedkeyword")).entries).toEqual([]);
    expect((await store.search("!!!")).entries).toEqual([]);
    const tied1 = (await store.add({ type: "user", text: "equalkeyword" }))!;
    const tied2 = (await store.add({ type: "feedback", text: "equalkeyword" }))!;
    const expected = [tied1.id, tied2.id].sort();
    expect((await store.search("equalkeyword")).entries.map((entry) => entry.id)).toEqual(expected);
    expect((await new MemoryStore({ dir: store.dir }).search("equalkeyword")).entries.map((entry) => entry.id)).toEqual(expected);
  });

  test("搜索反映修改和作废，不召回过期事实", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const entry = (await store.add({ type: "reference", text: "legacydashboard" }))!;
    expect((await store.search("legacydashboard")).total).toBe(1);
    await store.update(entry.id, "currentdashboard");
    expect((await store.search("legacydashboard")).total).toBe(0);
    expect((await store.search("currentdashboard")).entries[0]!.id).toBe(entry.id);
    await store.forget(entry.id);
    expect((await store.search("currentdashboard")).total).toBe(0);
  });

  test("拒绝无效分页参数和空白/超长查询", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.readPage({ offset })).rejects.toThrow("offset");
      await expect(store.search("事实", { offset })).rejects.toThrow("offset");
    }
    for (const limit of [0, -1, 1.5, 51, NaN, Infinity]) {
      await expect(store.readPage({ limit })).rejects.toThrow("limit");
      await expect(store.search("事实", { limit })).rejects.toThrow("limit");
    }
    for (const query of ["", "   ", "字".repeat(501)]) {
      await expect(store.search(query)).rejects.toThrow("query");
    }
  });
});

describe("memory 工具", () => {
  test("read/add/forget/update 全链路", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const tool = createMemoryTool(store);

    const added = (await tool.execute({ action: "add", type: "feedback", text: "文档要先写结论再写依据" })) as { status: string };
    expect(added.status).toBe("ok");

    const read = (await tool.execute({ action: "read" })) as { total: number; index: string };
    expect(read.total).toBe(1);
    expect(read.index).toContain("feedback（纠正与确认有效的做法）");

    const id = (await store.active())[0]!.id;
    const forgotten = (await tool.execute({ action: "forget", id })) as { status: string };
    expect(forgotten.status).toBe("ok");
    expect(((await tool.execute({ action: "read" })) as { total: number }).total).toBe(0);
  });

  test("缺必填参数时抛错（registry 会转成 error observation）", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const tool = createMemoryTool(store);
    await expect(tool.execute({ action: "add" as never })).rejects.toThrow("add 需要 type 与 text");
    await expect(tool.execute({ action: "forget" as never })).rejects.toThrow("forget 需要 id");
    await expect(tool.execute({ action: "search" })).rejects.toThrow("search 需要 query");
  });

  test("工具透传筛选和分页参数，返回完整条目及续页信息", async () => {
    const store = new MemoryStore({ dir: await tmpDir() });
    const tool = createMemoryTool(store);
    await store.add({ type: "user", text: "发布时提醒用户" });
    await store.add({ type: "project", text: "发布前校验" });
    const entry = (await store.add({ type: "project", text: "发布后检查", sourceSessionId: "session-a" }))!;
    const read = await tool.execute({ action: "read", type: "project", offset: 1, limit: 1 }) as MemoryPage & { index: string };
    expect(read).toMatchObject({ total: 2, offset: 1, limit: 1, nextOffset: null, entries: [entry] });
    expect(read.index).toContain(entry.id);
    expect(read.index).not.toContain("发布前校验");
    const expected = await store.search("发布", { type: "project", limit: 1, offset: 1 });
    const search = await tool.execute({ action: "search", query: "发布", type: "project", limit: 1, offset: 1 }) as MemoryPage<MemorySearchEntry>;
    expect(search).toMatchObject(expected);
    expect(search.total).toBe(2);
    expect(search.entries).toHaveLength(1);
    expect(search.nextOffset).toBeNull();
    for (const args of [
      { action: "read", offset: -1 }, { action: "read", limit: 51 },
      { action: "search", query: " " }, { action: "search", query: "x".repeat(501) },
    ]) {
      await expect(tool.execute(args)).rejects.toThrow("Invalid arguments for memory");
    }
  });
});
