// tests/memory_store.test.ts
// 运行: bun test ./tests/memory_store.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryStore } from "../src/core/memory_store";
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
  });
});
