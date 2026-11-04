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

// 人工复核独立存放；不接受 scanner 在 finding 中自报「人工确认」。
const ReviewSchema = z.object({
  finding_id: z.string().min(1),
  decision: z.enum(["confirmed", "revoked"]),
  reviewed_at: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1),
});

/** 初始保守规则，尚未由作者级人工标签校准；过期后回到当前资料的预算。 */
export const AUTHOR_MODEL_HISTORY_DAYS = 90;

export interface AuthorHistory {
  level: AuthorRiskLevel;
  model_max_age_days: number;
  records: Array<{
    id: string; bvid: string; recorded_at: string; evidence: string; level: AuthorRiskLevel;
    status: "model" | "confirmed" | "revoked" | "expired";
    review?: z.infer<typeof ReviewSchema>;
  }>;
}

export async function loadAuthorHistory(
  ownerMid: string | number | undefined,
  options: { storePath?: string; reviewsPath?: string; modelMaxAgeDays?: number; excludeBvid?: string; now?: number } = {},
): Promise<AuthorHistory> {
  const maxAgeDays = options.modelMaxAgeDays ?? AUTHOR_MODEL_HISTORY_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error("作者模型历史有效天数必须为正数");
  const now = options.now ?? Date.now();
  const result: AuthorHistory = { level: "unknown", model_max_age_days: maxAgeDays, records: [] };
  if (ownerMid === undefined || !/^[1-9]\d*$/.test(String(ownerMid))) return result;
  const file = options.storePath ?? path.join(process.cwd(), ".agent-data", "findings.jsonl");
  let text: string;
  try { text = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.storePath !== undefined) throw error;
    text = "";
  }
  const reviews = new Map<string, z.infer<typeof ReviewSchema>>();
  const reviewsFile = options.reviewsPath ?? `${file}.author-reviews.jsonl`;
  let reviewText = "";
  try { reviewText = await fs.readFile(reviewsFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.reviewsPath !== undefined) throw error;
  }
  for (const [index, line] of reviewText.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    // 坏复核行必须报错，不能静默漏掉撤销而继续使用原结论。
    let review: z.infer<typeof ReviewSchema>;
    try { review = ReviewSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`作者人工复核文件格式错误：${reviewsFile}:${index + 1}`); }
    if (Date.parse(review.reviewed_at) > now) continue;
    const prior = reviews.get(review.finding_id);
    if (!prior || Date.parse(review.reviewed_at) > Date.parse(prior.reviewed_at)
      || (Date.parse(review.reviewed_at) === Date.parse(prior.reviewed_at) && review.decision === "revoked")) {
      reviews.set(review.finding_id, review);
    }
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
      || Date.parse(record.recorded_at) > now
      || record.author_risk.risk_level === "unknown") continue;
    const candidate = reviews.get(record.id);
    const review = candidate && Date.parse(candidate.reviewed_at) >= Date.parse(record.recorded_at) ? candidate : undefined;
    const status = review?.decision ?? (now - Date.parse(record.recorded_at) >= maxAgeDays * 86_400_000 ? "expired" : "model");
    if (status === "model" || status === "confirmed") result.level = raiseToHistory(result.level, record.author_risk.risk_level);
    result.records.push({ id: record.id, bvid: record.subject, recorded_at: record.recorded_at,
      evidence: record.evidence, level: record.author_risk.risk_level, status, ...(review ? { review } : {}) });
  }
  return result;
}
