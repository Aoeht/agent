// tests/ingest_findings.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/core/registry";
import { createIngestFindingsTool } from "../src/tools/ingest_findings";

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-findings-"));
  storePath = path.join(tmpDir, "findings.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeTool = () => createIngestFindingsTool({ storePath });

async function readLines(): Promise<Record<string, unknown>[]> {
  const text = await fs.readFile(storePath, "utf-8");
  return text
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return []; // 与被测工具同口径：坏行跳过
      }
    });
}

test("普通对话结论落盘：批次字段摊平、默认值生效、回执带 id", async () => {
  const out = (await makeTool().execute({
    subject: "泡茶水温讨论",
    findings: [
      { summary: "绿茶适宜 80°C 左右冲泡", verdict: "已确认", reason: "高温会破坏茶多酚", labels: ["生活常识"] },
      { summary: "红茶可用 95°C 冲泡", verdict: "存疑", confidence: 0.6 },
    ],
  })) as {
    ingested: number;
    skipped_duplicate: number;
    total_findings: number;
    store_path: string;
    findings: { id: string; summary: string; verdict: string; labels: string[] }[];
  };

  expect(out.ingested).toBe(2);
  expect(out.skipped_duplicate).toBe(0);
  expect(out.total_findings).toBe(2);
  expect(out.store_path).toBe(storePath);
  expect(out.findings[0]!.id).toMatch(/^fnd_/);

  const lines = await readLines();
  expect(lines).toHaveLength(2);
  // 批次字段摊平到每条记录，source 走默认值
  expect(lines[0]).toMatchObject({
    subject: "泡茶水温讨论",
    source: "conversation",
    summary: "绿茶适宜 80°C 左右冲泡",
    verdict: "已确认",
    reason: "高温会破坏茶多酚",
    labels: ["生活常识"],
  });
  expect(lines[0]!.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // labels default([]) 生效；可选字段缺省时不出现在落盘记录里
  expect(lines[1]!.labels).toEqual([]);
  expect(lines[1]).not.toHaveProperty("reason");
  expect(lines[1]).not.toHaveProperty("dedupe_key");
});

test("dedupe_key 幂等：库中已有同键发现则整条跳过，同批内重复键也只收第一条", async () => {
  const tool = makeTool();
  await tool.execute({
    subject: "视频 v1",
    findings: [{ summary: "片段3含引导加微信话术", verdict: "存疑", dedupe_key: "v1:seg3" }],
  });

  const again = (await tool.execute({
    subject: "视频 v1",
    findings: [
      { summary: "片段3含引导加微信话术（复述）", verdict: "存疑", dedupe_key: "v1:seg3" },
      { summary: "片段7含二维码", verdict: "正常", dedupe_key: "v1:seg7" },
      { summary: "片段7重复上报", verdict: "正常", dedupe_key: "v1:seg7" },
    ],
  })) as { ingested: number; skipped_duplicate: number; total_findings: number };

  expect(again.ingested).toBe(1);
  expect(again.skipped_duplicate).toBe(2);
  expect(again.total_findings).toBe(2);

  const lines = await readLines();
  expect(lines).toHaveLength(2);
  expect(lines.map((l) => l.summary)).toEqual(["片段3含引导加微信话术", "片段7含二维码"]);
});

test("无 dedupe_key 的相同内容允许重复入库（发现库不做语义判重）", async () => {
  const tool = makeTool();
  const params = {
    subject: "话题 X",
    findings: [{ summary: "同一句话", verdict: "正常" }],
  };
  await tool.execute(params);
  const out = (await tool.execute(params)) as { ingested: number; total_findings: number };

  expect(out.ingested).toBe(1);
  expect(out.total_findings).toBe(2);
});

test("经 registry 调用：空 findings / 缺 summary 转成 error observation", async () => {
  const registry = new ToolRegistry();
  registry.register(makeTool());

  const empty = JSON.parse(await registry.execute("ingest_findings", { subject: "s", findings: [] }));
  expect(empty.error).toContain("Invalid arguments for ingest_findings");
  expect(empty.error).toContain("findings");

  const noSummary = JSON.parse(
    await registry.execute("ingest_findings", { subject: "s", findings: [{ verdict: "正常" }] })
  );
  expect(noSummary.error).toContain("summary");
});

test("坏行（半截写入）不阻塞：跳过后照常判重与追加", async () => {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, '{"id":"old","subject":"a"}\n{"broken\n', "utf-8");

  const out = (await makeTool().execute({
    subject: "b",
    findings: [{ summary: "新发现", verdict: "正常", dedupe_key: "k1" }],
  })) as { ingested: number; total_findings: number };

  expect(out.ingested).toBe(1);
  expect(out.total_findings).toBe(2); // 1 条完整旧记录 + 1 条新记录，坏行不计

  const lines = await readLines();
  expect(lines).toHaveLength(2);
  expect(lines[1]!.dedupe_key).toBe("k1");
});

test("Zod 单一事实来源：required 只含无默认值字段，describe 传导到 JSON Schema", () => {
  const params = makeTool().parameters as {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };

  expect(params.required).toEqual(["subject", "findings"]);
  expect(params.properties.source!.default).toBe("conversation");
  expect(params.properties.subject!.description).toContain("所属对象");
  const findingProps = (params.properties.findings!.items as {
    properties: Record<string, Record<string, unknown>>;
  }).properties;
  expect(findingProps.summary!.description).toContain("发现的正文");
  expect(findingProps.verdict!.minLength).toBe(1);
});
