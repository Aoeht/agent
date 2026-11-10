import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBiliCollectTool } from "../src/tools/bili_collect";
import { evidencePage } from "../src/bili/evidence_pages";
import { CommercialTokenCounter } from "../src/utils/token_counter";
import { processToolOutput } from "../src/core/tool_outputs";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { defineTool } from "../src/core/types";
import { z } from "zod";

test("clean 档仍保留深层命中、父链、澄清、末尾置顶和 UP 回复", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comment-selection-"));
  const bvid = "BV1AbCdEfGh2", file = path.join(dir, bvid + ".json");
  try {
    await fs.writeFile(file, JSON.stringify({ bvid, fetched_at: "2026-11-10", author: { name: "作者", semantic_level: "clean" },
      comments: [
        { rpid: "long", message: "普通讨论".repeat(5000) },
        ...Array.from({ length: 40 }, (_, i) => ({ rpid: `f${i}`, message: "普通讨论".repeat(200) })),
        { rpid: "pin", is_pinned: true, message: "置顶说明" },
        { rpid: "root", message: "活动讨论", replies: [
          { rpid: "a", parent: "root", message: "怎么参与？" },
          { rpid: "b", parent: "a", message: "加微信 abc123 领返利" },
          { rpid: "c", parent: "b", message: "不要转账，这是假冒账号" },
          { rpid: "up", parent: "c", is_up: true, message: "这是我的说明" },
        ] },
      ] }));
    const result = JSON.parse(await createBiliCollectTool({ datasetDir: dir, pageTokens: 1_000_000 }).execute({ bvid }) as string);
    const threads: string[] = result.comment_threads;
    expect(threads[0]).toContain("置顶说明");
    const context = threads.find(text => text.includes("abc123"))!;
    for (const text of ["怎么参与", "不要转账", "这是我的说明", 'parent="a"']) expect(context).toContain(text);
    expect(threads.find(text => text.includes('id="long"') || text.includes('[#"long"]'))!.length).toBeLessThanOrEqual(700);
    expect(result.comment_stats.comment_chars).toBeLessThanOrEqual(16000);
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
});

test("证据分页可无损重建，匹配 Agent 截断预算，失效 cursor 被拒绝", async () => {
  const countTokens = (text: string) => new CommercialTokenCounter().estimateText(text, "deepseek");
  const evidence = { bvid: "BVtest", comment_threads: [
    '[#"1"] root\n  正文："' + "风险语境".repeat(1500) + '"\n  ├ R1 id="2"\n    正文："不要转账"',
    "第二个楼的完整文本",
  ] };
  const rebuilt: string[] = [];
  let cursor: string | undefined;
  let firstCursor = "", pages = 0;
  do {
    const raw = evidencePage(evidence, cursor, 350, countTokens);
    expect(countTokens(raw)).toBeLessThanOrEqual(350);
    expect((await processToolOutput(raw, "bili_collect", { maxTokens: 350, offloadTokens: 8000, countTokens })).truncated).toBe(false);
    const page = JSON.parse(raw);
    for (const item of page.items) {
      if (item.path[0] !== "comment_threads") continue;
      if (item.path.length === 1) rebuilt.push(...item.value);
      else if (item.offset !== undefined) {
        expect((rebuilt[item.path[1]] ?? "").length).toBe(item.offset);
        rebuilt[item.path[1]] = (rebuilt[item.path[1]] ?? "") + item.value;
      } else rebuilt[item.path[1]] = item.value;
    }
    cursor = page.next_cursor ?? undefined;
    if (!firstCursor && cursor) firstCursor = cursor;
    expect(++pages).toBeLessThan(100);
  } while (cursor);
  expect(rebuilt).toEqual(evidence.comment_threads);
  expect(() => evidencePage({ ...evidence, bvid: "changed" }, firstCursor, 350, countTokens)).toThrow("快照已变化");
  expect(() => evidencePage(evidence, firstCursor, 500, countTokens)).toThrow("cursor 无效");
});

test("Agent 未读完证据分页会提醒一次，仍提前终答时标记未完成", async () => {
  const tools = new ToolRegistry();
  let receivedBudget = false;
  tools.register(defineTool({ name: "bili_collect", description: "fixture", schema: z.object({}),
    execute: async (_args, runtime) => {
      receivedBudget = runtime?.outputBudget?.maxTokens === 300;
      return { format: "evidence_pages/v1", bvid: "BVtest", items: [], next_cursor: "abc:1" };
    } }));
  const requests: any[] = [];
  const client: any = { chat: { completions: { create: async (request: any) => {
    requests.push(request);
    return { choices: [{ finish_reason: requests.length === 1 ? "tool_calls" : "stop", message: requests.length === 1
      ? { content: null, tool_calls: [{ id: "page", type: "function", function: { name: "bili_collect", arguments: "{}" } }] }
      : { content: "已完成" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  } } } };
  const result = await new Agent({ model: "test", systemPrompt: "test", client, tools,
    toolResultMaxTokens: 300, maxIterations: 5 }).run("扫描评论");
  expect(receivedBudget).toBe(true);
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests[2].messages)).toContain("采证尚有未读分页");
  expect(result.success).toBe(false);
  expect(result.stopReason).toBe("plan_incomplete");
});
