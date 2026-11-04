import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { raiseToHistory, type AuthorRiskLevel } from "./author_risk";

/** 明确的账号身份与结论；普通自由文本 verdict 不自动猜成风险等级。 */
export const AuthorFindingSchema = z.object({
  owner_mid: z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]),
  risk_level: z.enum(["high", "medium", "low", "clean", "unknown"]),
});

const HistoryRecordSchema = z.object({
  id: z.string().min(1),
  recorded_at: z.string().datetime({ offset: true }),
  subject: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
  source: z.literal("scan_video"),
  dedupe_key: z.string(),
  evidence: z.string().trim().min(1),
  author_risk: AuthorFindingSchema,
});

export interface AuthorHistory {
  level: AuthorRiskLevel;
  records: Array<{ id: string; bvid: string; recorded_at: string; evidence: string; level: AuthorRiskLevel }>;
}

export async function loadAuthorHistory(
  ownerMid: string | number | undefined,
  options: { storePath?: string; excludeBvid?: string; now?: number } = {},
): Promise<AuthorHistory> {
  const result: AuthorHistory = { level: "unknown", records: [] };
  if (ownerMid === undefined || !/^[1-9]\d*$/.test(String(ownerMid))) return result;
  const file = options.storePath ?? path.join(process.cwd(), ".agent-data", "findings.jsonl");
  let text: string;
  try { text = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.storePath === undefined) return result;
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const parsed = HistoryRecordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const record = parsed.data;
    if (String(record.author_risk.owner_mid) !== String(ownerMid)
      || record.subject === options.excludeBvid
      || record.dedupe_key !== `${record.subject}:author`
      || Date.parse(record.recorded_at) > (options.now ?? Date.now())
      || record.author_risk.risk_level === "unknown") continue;
    result.level = raiseToHistory(result.level, record.author_risk.risk_level);
    result.records.push({ id: record.id, bvid: record.subject, recorded_at: record.recorded_at,
      evidence: record.evidence, level: record.author_risk.risk_level });
  }
  return result;
}
