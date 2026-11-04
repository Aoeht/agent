// src/bili/author_risk.ts
/**
 * 作者账号级风险分——只用来给识别/抽帧分配预算，不代替逐视频定性。
 *
 * 输入只取账号资料（粉丝、关注、认证、昵称/签名、投稿数、累计播放）与历史结论，
 * 不读当前视频的标题/弹幕/评论/字幕/画面，避免"这条视频看着干净"反过来洗白作者。
 * 历史结论只向上覆盖：作者历史上出现过 high，就不能因为本次账号数据好看而降档。
 *
 * 缺粉丝数时无法计算，返回 unknown（调用方按 medium 预算处理）。
 */
import { scanKeywords } from "../core/scam_lexicon";
import type { AuthorInfo } from "./snapshot";

export type AuthorRiskLevel = "high" | "medium" | "low" | "clean" | "unknown";

export type AuthorRiskInput = Partial<
  Pick<AuthorInfo, "name" | "sign" | "fans" | "attention" | "official_type" | "video_count" | "total_views">
> & {
  /** 该 owner_mid 的历史结论；只向上覆盖 */
  history_level?: AuthorRiskLevel;
};

export interface AuthorRiskScore {
  level: AuthorRiskLevel;
  /** null = 缺关键数据，无法计算 */
  score: number | null;
  /** 触发加减分的依据，便于排查分档是否合理 */
  reasons: string[];
}

export const AUTHOR_RISK_THRESHOLDS = { high: 70, medium: 50, low: 30 } as const;

/** 各档抽帧预算（九宫格张数）；unknown 与 medium 同档，避免冷启动漏扫 */
export const AUTHOR_MAX_GRIDS: Record<AuthorRiskLevel, number> = {
  high: 20,
  medium: 10,
  low: 5,
  clean: 3,
  unknown: 10,
};

const BASE_SCORE = 50;

const LEVEL_RANK: Record<Exclude<AuthorRiskLevel, "unknown">, number> = {
  clean: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export function levelFromScore(score: number): Exclude<AuthorRiskLevel, "unknown"> {
  if (score >= AUTHOR_RISK_THRESHOLDS.high) return "high";
  if (score >= AUTHOR_RISK_THRESHOLDS.medium) return "medium";
  if (score >= AUTHOR_RISK_THRESHOLDS.low) return "low";
  return "clean";
}

/** 历史覆盖只向上：历史档位更高才替换 */
export function raiseToHistory(level: AuthorRiskLevel, history?: AuthorRiskLevel): AuthorRiskLevel {
  if (history === undefined || history === "unknown") return level;
  if (level === "unknown") return history;
  return LEVEL_RANK[history] > LEVEL_RANK[level] ? history : level;
}

function fansScore(fans: number): { delta: number; reason: string } {
  if (fans >= 1_000_000) return { delta: -25, reason: "粉丝 ≥100万" };
  if (fans >= 100_000) return { delta: -18, reason: "粉丝 ≥10万" };
  if (fans >= 10_000) return { delta: -10, reason: "粉丝 ≥1万" };
  if (fans >= 1000) return { delta: -3, reason: "粉丝 ≥1000" };
  if (fans >= 100) return { delta: 8, reason: "粉丝 <1000 且 ≥100" };
  if (fans >= 10) return { delta: 15, reason: "粉丝 <100 且 ≥10" };
  return { delta: 20, reason: "粉丝 <10" };
}

function officialScore(type?: number): { delta: number; reason: string } | null {
  if (type === 1) return { delta: -5, reason: "个人认证" };
  if (type === 2) return { delta: -10, reason: "机构认证" };
  if (type === 0 || type === undefined) return { delta: 3, reason: "无认证" };
  return null;
}

function attentionScore(fans: number, attention?: number): { delta: number; reason: string } | null {
  if (attention === undefined) return null;
  if (attention >= 50 && attention > fans * 2) {
    return { delta: 8, reason: "关注多、粉丝少（关注 ≥50 且 >2×粉丝）" };
  }
  if (attention === 0 && fans < 100) return { delta: 4, reason: "零关注、粉丝 <100" };
  if (attention > 0 && fans >= 1000 && fans / attention > 20) {
    return { delta: -3, reason: "粉丝/关注 >20" };
  }
  return null;
}

function keywordScore(name: string, sign: string): { delta: number; reason: string } | null {
  const hits = scanKeywords(`${name}\n${sign}`);
  if (hits.length === 0) return null;
  const contact = hits.some((hit) => hit.category === "contact");
  const scamTerms = hits.filter((hit) => hit.category === "scam").length;
  const delta = (contact ? 12 : 0) + Math.min(scamTerms * 6, 12);
  if (delta === 0) return null;
  const parts = [
    ...(contact ? ["联系方式"] : []),
    ...(scamTerms > 0 ? [`套路词 ×${scamTerms}`] : []),
  ];
  return { delta, reason: `昵称/签名含${parts.join("、")}` };
}

function accountScaleScore(input: AuthorRiskInput): Array<{ delta: number; reason: string }> {
  const { fans, video_count: videoCount, total_views: totalViews } = input;
  if (fans === undefined) return [];
  const results: Array<{ delta: number; reason: string }> = [];

  // 新号且没有累计播放：一次性/小号
  if (videoCount !== undefined && totalViews !== undefined && videoCount < 5 && totalViews < 10_000) {
    results.push({ delta: 3, reason: "投稿 <5 且累计播放 <1万" });
  }

  // 高累计播放是弱背书，只给成立账号小幅降分
  if (totalViews !== undefined) {
    if (totalViews >= 100_000_000) results.push({ delta: -4, reason: "累计播放 ≥1亿" });
    else if (totalViews >= 10_000_000) results.push({ delta: -2, reason: "累计播放 ≥1000万" });
  }

  // 高产但单稿粉丝极少：批量铺稿/矩阵号
  if (videoCount !== undefined && videoCount >= 100 && fans / videoCount < 10) {
    results.push({ delta: 4, reason: "投稿 ≥100 且单稿粉丝 <10" });
  }

  // 粉丝过千却几乎没有播放：粉丝可能买量/僵尸粉
  if (totalViews !== undefined && fans >= 1000 && totalViews / fans < 1) {
    results.push({ delta: 4, reason: "粉丝 ≥1000 且人均播放 <1" });
  }

  return results;
}

export function scoreAuthor(input: AuthorRiskInput): AuthorRiskScore {
  const history = input.history_level;
  if (input.fans === undefined) {
    const level = raiseToHistory("unknown", history);
    return {
      level,
      score: null,
      reasons: [`缺少粉丝数，无法计算账号分${level === "unknown" ? "" : `；历史结论为 ${level}`}`],
    };
  }

  let score = BASE_SCORE;
  const reasons: string[] = [`基线 ${BASE_SCORE}`];

  const fansPart = fansScore(input.fans);
  score += fansPart.delta;
  reasons.push(`${fansPart.reason} ${fansPart.delta > 0 ? "+" : ""}${fansPart.delta}`);

  const officialPart = officialScore(input.official_type);
  if (officialPart) {
    score += officialPart.delta;
    reasons.push(`${officialPart.reason} ${officialPart.delta > 0 ? "+" : ""}${officialPart.delta}`);
  }

  const attentionPart = attentionScore(input.fans, input.attention);
  if (attentionPart) {
    score += attentionPart.delta;
    reasons.push(`${attentionPart.reason} ${attentionPart.delta > 0 ? "+" : ""}${attentionPart.delta}`);
  }

  const keywordPart = keywordScore(input.name ?? "", input.sign ?? "");
  if (keywordPart) {
    score += keywordPart.delta;
    reasons.push(`${keywordPart.reason} +${keywordPart.delta}`);
  }

  for (const part of accountScaleScore(input)) {
    score += part.delta;
    reasons.push(`${part.reason} ${part.delta > 0 ? "+" : ""}${part.delta}`);
  }

  const computed = levelFromScore(score);
  const level = raiseToHistory(computed, history);
  if (level !== computed) reasons.push(`历史结论上调：${computed} → ${level}`);
  return { level, score, reasons };
}
