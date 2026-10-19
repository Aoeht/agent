// src/tools/ingest_findings.ts
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { ToolDefinition, defineTool } from "../core/types";

/**
 * 发现库默认落盘位置：进程工作目录下的 .agent-data。
 * 后续 scan_video 等批处理产物也归这里，一个数据目录收拢所有本地沉淀。
 */
export const FINDINGS_DIR = path.join(process.cwd(), ".agent-data");
const FINDINGS_FILE = "findings.jsonl";

const FindingItemSchema = z.object({
  summary: z.string().trim().min(1, "summary 不能为空").max(2000).describe("发现的正文：一句话说清这条结论/发现"),
  verdict: z.string().trim().min(1, "verdict 不能为空").max(100).describe("结论标签，简短短语，如：正常 / 存疑 / 已确认 / 建议:采纳"),
  confidence: z.number().min(0).max(1).optional().describe("把握程度 0~1；没有量化依据时省略"),
  reason: z.string().trim().max(2000).optional().describe("得出该结论的理由"),
  evidence: z.string().trim().max(4000).optional().describe("支撑证据：原文引用、时间戳、链接等"),
  labels: z.array(z.string().trim().min(1)).max(10).default([]).describe("自由分类标签，领域不限，如：[\"生活常识\",\"风险:低\"]"),
  dedupe_key: z.string().trim().min(1).max(200).optional().describe("幂等键：同一对象同一发现反复上报时给稳定键（如 视频ID:片段号），库中已存在则整条跳过"),
});

const IngestFindingsParamsSchema = z.object({
  subject: z.string().trim().min(1, "subject 不能为空").max(500).describe("这批发现所属对象：视频ID、对话主题、网页链接等"),
  source: z.string().trim().max(200).default("conversation").describe("发现来源：conversation=普通对话，也可填产生发现的工具名（inspect_link / scan_video 等）"),
  context: z.string().trim().max(2000).optional().describe("整批共用的背景说明"),
  findings: z.array(FindingItemSchema).min(1, "findings 至少一条").max(20).describe("本批发现，一次 1~20 条"),
});

export type IngestFindingsParams = z.output<typeof IngestFindingsParamsSchema>;

/** 单条落盘记录：批次字段摊平到每条，下游按行消费（jq/pandas）不用解嵌套 */
export interface FindingRecord {
  id: string;
  recorded_at: string;
  subject: string;
  source: string;
  context?: string;
  summary: string;
  verdict: string;
  confidence?: number;
  reason?: string;
  evidence?: string;
  labels: string[];
  dedupe_key?: string;
}

export interface IngestFindingsOptions {
  /** 显式指定落盘文件（测试用）；缺省 <cwd>/.agent-data/findings.jsonl */
  storePath?: string;
  now?: () => number;
  idGen?: () => string;
}

export function createIngestFindingsTool(options: IngestFindingsOptions = {}): ToolDefinition {
  const storePath = options.storePath ?? path.join(FINDINGS_DIR, FINDINGS_FILE);
  const now = options.now ?? (() => Date.now());
  const idGen = options.idGen ?? (() => `fnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
  /**
   * 进程内写链：读盘判重 → 追加 → 统计，整段串行执行。
   * 并发批如果各读各的旧文件，同一条带 dedupe_key 的发现会被同时放行；串行化后同键只有一个批能看到"不存在"。
   * 跨进程场景（两个 agent 进程同时写）仅靠单行 appendFile 保证不写坏文件，判重可能放过——发现库不做跨进程锁，量级不值得。
   */
  let writeChain: Promise<unknown> = Promise.resolve();

  /** 逐行解析；半截写入或手工编辑留下的坏行跳过不计数，不阻塞后续记录 */
  async function readRecords(): Promise<FindingRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(storePath, "utf-8");
    } catch {
      return []; // 文件尚不存在 = 空库
    }
    const records: FindingRecord[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as FindingRecord);
      } catch {
        // 坏行跳过
      }
    }
    return records;
  }

  return defineTool({
    name: "ingest_findings",
    schema: IngestFindingsParamsSchema,
    // 写入全程经写链串行化且 dedupe_key 幂等，允许与同批工具并发调用
    parallelSafe: true,
    description:
      "把对话或分析得到的结论、发现持久化记录到本地发现库（JSONL 追加），形成可追溯的结构化沉淀，" +
      "供后续统计、检索或作为标注数据使用。适用场景：用户要求\"记住/记录\"某个结论；完成一段分析后需要存档发现。" +
      "领域不限：每条发现含结论标签(verdict)、摘要(summary)，可选理由/证据/把握度，labels 为自由标签。同一发现重复上报时请带 dedupe_key。",
    execute: async (params: IngestFindingsParams) => {
      const run = writeChain.then(async () => {
        const existing = await readRecords();
        const seenKeys = new Set(existing.map((r) => r.dedupe_key).filter((k): k is string => k !== undefined));
        const recordedAt = new Date(now()).toISOString();
        const accepted: FindingRecord[] = [];
        let skipped = 0;

        for (const item of params.findings) {
          if (item.dedupe_key !== undefined) {
            if (seenKeys.has(item.dedupe_key)) {
              skipped++;
              continue;
            }
            seenKeys.add(item.dedupe_key); // 同一批内重复键同样只收第一条
          }
          accepted.push({
            id: idGen(),
            recorded_at: recordedAt,
            subject: params.subject,
            source: params.source,
            ...(params.context !== undefined ? { context: params.context } : {}),
            summary: item.summary,
            verdict: item.verdict,
            ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
            ...(item.reason !== undefined ? { reason: item.reason } : {}),
            ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
            labels: item.labels,
            ...(item.dedupe_key !== undefined ? { dedupe_key: item.dedupe_key } : {}),
          });
        }

        if (accepted.length > 0) {
          await fs.mkdir(path.dirname(storePath), { recursive: true });
          await fs.appendFile(storePath, accepted.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
        }

        return {
          ingested: accepted.length,
          skipped_duplicate: skipped,
          store_path: storePath,
          total_findings: existing.length + accepted.length,
          /** 回执只带关键字段，完整内容以落盘为准 */
          findings: accepted.map(({ id, summary, verdict, labels }) => ({ id, summary, verdict, labels })),
        };
      });
      writeChain = run.catch(() => undefined);
      return run;
    },
  });
}
