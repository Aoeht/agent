// benchmarks/scanner_eval.ts
/**
 * scanner 子代理评测：批量跑（或重放）三维度诈骗风险判定，对照人工标注算 precision/recall。
 *
 * 评测对象是 scanner 的固定 JSON 报告（src/tools/delegate_task.ts 的 SCANNER_REPORT_SCHEMA）：
 * 每个视频 video/author/comments 三维度 + overall 各一个 risk_level。口径：
 * - 二元任务：risky = high|medium，safe = low|clean；P/R/F1 只在可判定对（双方都非 unknown）上算。
 * - 弃权（无法判断/报告缺失）是设计的合法行为，单独记 abstainRate，不计入 P/R 的分母也不当错误。
 * - 标注为 unknown 的维度（标注员判不了）不进任何分母；模型在这些维度上给了判断则记入
 *   goldUnknownPredicted 单独观察，不算对也不算错。
 * - 附严格一致率（4 档完全相等）与等级误差 MAE（clean=0/low=1/medium=2/high=3）作序数参考。
 *
 * 三种模式（同 memory_recall_eval 的 mock/real 分工）：
 * - --self-check：内置合成对照集 + canned 报告，零网络零调用，验证解析与打分管道本身；
 * - --replay（默认）：对 work/reports/ 里已保存的报告重新打分，零成本迭代口径；
 * - --live：对「有快照且有标注」的 BV 逐个真跑 scanner 子代理（走真实 delegate 管道，
 *   bili_collect 指向评测数据集目录、ingest_findings 指向评测工作目录，不污染真实发现库），
 *   原始回执与解析出的报告分别落盘，之后可随时 --replay 复算。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import { ToolRegistry } from "../src/core/registry";
import type { ToolDefinition } from "../src/core/types";
import { createDelegateTaskTool, type DelegateBudget } from "../src/tools/delegate_task";
import { createBiliCollectTool } from "../src/tools/bili_collect";
import { createIngestFindingsTool } from "../src/tools/ingest_findings";
import { createInspectLinkTool } from "../src/tools/inspect_link";
import { createRagSearchTool } from "../src/tools/rag_search";
import { cannedCases, cannedReports } from "./scanner/fixtures";

// ---------- 口径与归一 ----------

/** 报告与标注共用的风险等级；unknown 是合法状态（无法判断），不是解析失败的兜底垃圾桶 */
export type RiskLevel = "high" | "medium" | "low" | "clean" | "unknown";

const LEVEL_ALIASES: Array<[RiskLevel, string[]]> = [
  ["high", ["high", "高", "高风险", "高危"]],
  ["medium", ["medium", "med", "中", "中风险", "中危", "存疑"]],
  ["low", ["low", "低", "低风险", "低危"]],
  ["clean", ["clean", "无风险", "正常", "未发现风险", "安全"]],
  ["unknown", ["unknown", "无法判断", "数据不足", "不确定", "none", "na", ""]],
];

/** 4 档序数（MAE 用）；unknown 不参与序数比较 */
export const LEVEL_ORDER: Record<Exclude<RiskLevel, "unknown">, number> = { clean: 0, low: 1, medium: 2, high: 3 };

/** 报告枚举与中文自然标签统一归一到 RiskLevel；认不出的值按 unknown 处理（不抛错） */
export function normalizeLevel(input: unknown): RiskLevel {
  if (typeof input !== "string") return "unknown";
  const value = input.trim().toLowerCase();
  for (const [level, aliases] of LEVEL_ALIASES) {
    if (aliases.some(alias => alias.toLowerCase() === value)) return level;
  }
  return "unknown";
}

export interface ScannerGold {
  video: RiskLevel;
  author: RiskLevel;
  comments: RiskLevel;
  overall: RiskLevel;
}

export interface ScannerGoldCase {
  /** BV 号，同时是快照文件名与报告文件名 */
  id: string;
  category: string;
  gold: ScannerGold;
  notes?: string;
}

export interface ParsedScannerReport {
  bvid?: string;
  risk_level: RiskLevel;
  confidence?: number;
  video: { risk_level: RiskLevel };
  author: { risk_level: RiskLevel };
  comments: { risk_level: RiskLevel };
}

const EMPTY_DIM = { risk_level: "unknown" as const };

function tryParseReport(text: string): ParsedScannerReport | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    if (typeof raw.risk_level !== "string") return null;
    const dim = (key: string) => {
      const value = raw[key];
      return { risk_level: normalizeLevel(typeof value === "object" && value !== null ? (value as Record<string, unknown>).risk_level : undefined) };
    };
    return {
      ...(typeof raw.bvid === "string" ? { bvid: raw.bvid } : {}),
      risk_level: normalizeLevel(raw.risk_level),
      ...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
      video: dim("video"),
      author: dim("author"),
      comments: dim("comments"),
    };
  } catch {
    return null;
  }
}

/** 从 `{` 起做括号配平截取一个完整 JSON 对象；字符串内的花括号与转义不参与计数 */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从 scanner 最终回执里提取报告：优先取最后一个 ```json 围栏块（提示词要求"结论后附 JSON 代码块"），
 * 逐个向前尝试；都没有时用 "risk_level" 锚点做括号配平兜底（覆盖模型忘写围栏的情况）。
 * 提取不到或结构不对返回 null —— 上层按整例弃权计，不抛错。
 */
export function parseScannerReport(text: string): ParsedScannerReport | null {
  if (typeof text !== "string" || !text) return null;
  const fenced: string[] = [];
  const fencePattern = /```json\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fencePattern.exec(text)) !== null) fenced.push(fenceMatch[1]!);
  for (let i = fenced.length - 1; i >= 0; i--) {
    const parsed = tryParseReport(fenced[i]!);
    if (parsed) return parsed;
  }
  // 无围栏兜底：从每个 "risk_level" 锚点向左逐个候选 `{` 配平。锚点可能落在外层对象里某个
  // 维度自己的 "risk_level" 上（配平会先截到内层小对象），所以向左继续找外层 `{`：
  // 优先接受带 bvid 或任一维度等级的完整报告；全是残片时退回第一个能解析的（总比整例弃权好）。
  const anchorPattern = /"risk_level"/g;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(text)) !== null) {
    let fallback: ParsedScannerReport | null = null;
    let start = text.lastIndexOf("{", match.index);
    while (start >= 0) {
      const candidate = balancedSlice(text, start);
      if (candidate) {
        const parsed = tryParseReport(candidate);
        if (parsed) {
          if (parsed.bvid || parsed.video.risk_level !== "unknown" ||
              parsed.author.risk_level !== "unknown" || parsed.comments.risk_level !== "unknown") {
            return parsed;
          }
          fallback ??= parsed;
        }
      }
      if (start === 0) break;
      start = text.lastIndexOf("{", start - 1);
    }
    if (fallback) return fallback;
  }
  return null;
}

// ---------- 打分 ----------

export const SCORED_DIMENSIONS = ["video", "author", "comments", "overall"] as const;
export type ScoredDimension = (typeof SCORED_DIMENSIONS)[number];

/** 单对的判定结果；gold-unknown-predicted / correct-abstain 不进 P/R */
export type PairKind = "tp" | "fp" | "tn" | "fn" | "abstain" | "gold-unknown-predicted" | "correct-abstain";

const isRisky = (level: RiskLevel) => level === "high" || level === "medium";

export function pairOutcome(gold: RiskLevel, pred: RiskLevel): PairKind {
  if (gold === "unknown") return pred === "unknown" ? "correct-abstain" : "gold-unknown-predicted";
  if (pred === "unknown") return "abstain";
  if (isRisky(pred)) return isRisky(gold) ? "tp" : "fp";
  return isRisky(gold) ? "fn" : "tn";
}

export interface DimensionPair {
  gold: RiskLevel;
  pred: RiskLevel;
  kind: PairKind;
  /** 4 档完全一致（双方均可判定且相等） */
  exact: boolean;
  /** 序数误差 |gold-pred|；任一方 unknown 时为 null */
  delta: number | null;
}

const ABSTAIN_REPORT: ParsedScannerReport = {
  risk_level: "unknown",
  video: EMPTY_DIM,
  author: EMPTY_DIM,
  comments: EMPTY_DIM,
};

export function scoreCase(gold: ScannerGold, report: ParsedScannerReport | null): Record<ScoredDimension, DimensionPair> {
  const pred = report ?? ABSTAIN_REPORT;
  const pair = (goldLevel: RiskLevel, predLevel: RiskLevel): DimensionPair => ({
    gold: goldLevel,
    pred: predLevel,
    kind: pairOutcome(goldLevel, predLevel),
    exact: goldLevel !== "unknown" && predLevel !== "unknown" && goldLevel === predLevel,
    delta: goldLevel !== "unknown" && predLevel !== "unknown"
      ? Math.abs(LEVEL_ORDER[goldLevel as Exclude<RiskLevel, "unknown">] - LEVEL_ORDER[predLevel as Exclude<RiskLevel, "unknown">])
      : null,
  });
  return {
    video: pair(gold.video, pred.video.risk_level),
    author: pair(gold.author, pred.author.risk_level),
    comments: pair(gold.comments, pred.comments.risk_level),
    overall: pair(gold.overall, pred.risk_level),
  };
}

export interface DimensionTally {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  abstain: number;
  goldUnknownPredicted: number;
  correctAbstain: number;
  /** 双方可判定的对数（exact/MAE 的分母） */
  comparable: number;
  exact: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** 可判定对中弃权的比例：abstain / (tp+fp+tn+fn+abstain) */
  abstainRate: number;
  exactMatchRate: number | null;
  mae: number | null;
}

export function tallyPairs(pairs: DimensionPair[]): DimensionTally {
  const count = { tp: 0, fp: 0, tn: 0, fn: 0, abstain: 0, "gold-unknown-predicted": 0, "correct-abstain": 0 } as Record<PairKind, number>;
  let comparable = 0;
  let exact = 0;
  let deltaSum = 0;
  for (const pair of pairs) {
    count[pair.kind]++;
    if (pair.kind !== "abstain" && pair.kind !== "gold-unknown-predicted" && pair.kind !== "correct-abstain") {
      comparable++;
      if (pair.exact) exact++;
      if (pair.delta !== null) deltaSum += pair.delta;
    }
  }
  const precision = count.tp + count.fp > 0 ? count.tp / (count.tp + count.fp) : null;
  const recall = count.tp + count.fn > 0 ? count.tp / (count.tp + count.fn) : null;
  const f1Denominator = 2 * count.tp + count.fp + count.fn;
  return {
    tp: count.tp, fp: count.fp, tn: count.tn, fn: count.fn,
    abstain: count.abstain,
    goldUnknownPredicted: count["gold-unknown-predicted"],
    correctAbstain: count["correct-abstain"],
    comparable, exact,
    precision, recall,
    f1: f1Denominator > 0 ? (2 * count.tp) / f1Denominator : null,
    abstainRate: comparable + count.abstain > 0 ? count.abstain / (comparable + count.abstain) : 0,
    exactMatchRate: comparable > 0 ? exact / comparable : null,
    mae: comparable > 0 ? deltaSum / comparable : null,
  };
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

// ---------- 评测运行 ----------

export interface ScanOutcome {
  /** scanner 的最终回执原文（live=delegate 观察串；replay=落盘的报告 JSON 文本） */
  raw: string;
  /** 预测器已解析的报告；缺省时由 runScannerEval 自己从 raw 提取 */
  report?: ParsedScannerReport | null;
}

export type ScanPredictor = (c: ScannerGoldCase) => Promise<ScanOutcome>;

export interface CaseRow {
  id: string;
  category: string;
  /** 是否拿到了结构化报告（false = 整例弃权） */
  reportFound: boolean;
  pairs: Record<ScoredDimension, DimensionPair>;
}

export interface ScannerEvalReport {
  fixtureVersion: 1;
  mode: "canned" | "replay" | "live";
  model?: string;
  totalCases: number;
  reportMissing: number;
  dimensions: Record<ScoredDimension, DimensionTally>;
  /** video+author+comments 三维度合并（overall 是综合结论，与维度重复合并会重复计数，单列） */
  micro: DimensionTally;
  /** 三维度 P/R/F1 各自非空值的平均 */
  macro: { precision: number | null; recall: number | null; f1: number | null };
  perCategory: Array<{ category: string; cases: number } & DimensionTally>;
  cases: CaseRow[];
}

export async function runScannerEval(
  cases: ScannerGoldCase[],
  predict: ScanPredictor,
  options: { mode: ScannerEvalReport["mode"]; model?: string } = { mode: "canned" },
): Promise<ScannerEvalReport> {
  const rows: CaseRow[] = [];
  for (const testCase of cases) {
    const outcome = await predict(testCase);
    const report = outcome.report !== undefined ? outcome.report : parseScannerReport(outcome.raw);
    rows.push({
      id: testCase.id,
      category: testCase.category,
      reportFound: report !== null,
      pairs: scoreCase(testCase.gold, report),
    });
  }
  const dimensionTally = (dimension: ScoredDimension) => tallyPairs(rows.map(row => row.pairs[dimension]!));
  const dimensions = Object.fromEntries(SCORED_DIMENSIONS.map(dimension => [dimension, dimensionTally(dimension)])) as Record<ScoredDimension, DimensionTally>;
  const pooled = tallyPairs(rows.flatMap(row => SCORED_DIMENSIONS.filter(dimension => dimension !== "overall").map(dimension => row.pairs[dimension]!)));
  const macro = {
    precision: mean(["video", "author", "comments"].map(dimension => dimensions[dimension as ScoredDimension].precision).filter((value): value is number => value !== null)),
    recall: mean(["video", "author", "comments"].map(dimension => dimensions[dimension as ScoredDimension].recall).filter((value): value is number => value !== null)),
    f1: mean(["video", "author", "comments"].map(dimension => dimensions[dimension as ScoredDimension].f1).filter((value): value is number => value !== null)),
  };
  const byCategory = new Map<string, CaseRow[]>();
  for (const row of rows) byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
  const perCategory = [...byCategory.entries()].map(([category, categoryRows]) => ({
    category,
    cases: categoryRows.length,
    ...tallyPairs(categoryRows.flatMap(row => SCORED_DIMENSIONS.filter(dimension => dimension !== "overall").map(dimension => row.pairs[dimension]!))),
  }));
  return {
    fixtureVersion: 1,
    mode: options.mode,
    ...(options.model ? { model: options.model } : {}),
    totalCases: rows.length,
    reportMissing: rows.filter(row => !row.reportFound).length,
    dimensions, micro: pooled, macro, perCategory, cases: rows,
  };
}

const levelCell = (pair: DimensionPair) => `${pair.gold}/${pair.pred === "unknown" ? "—" : pair.pred}`;

export function renderScannerReport(report: ScannerEvalReport): string {
  const tallyRow = (label: string, tally: DimensionTally) =>
    `| ${label} | ${tally.tp} | ${tally.fp} | ${tally.tn} | ${tally.fn} | ${tally.abstain} | ` +
    `${tally.precision === null ? "—" : tally.precision.toFixed(3)} | ${tally.recall === null ? "—" : tally.recall.toFixed(3)} | ${tally.f1 === null ? "—" : tally.f1.toFixed(3)} | ` +
    `${tally.abstainRate.toFixed(3)} | ${tally.exactMatchRate === null ? "—" : tally.exactMatchRate.toFixed(3)} | ${tally.mae === null ? "—" : tally.mae.toFixed(2)} |`;
  return [
    "# Scanner 三维度评测", "",
    `模式：${report.mode}${report.model ? `；模型：${report.model}` : ""}；用例：${report.totalCases}（缺报告：${report.reportMissing}）。`, "",
    "口径：risky = high|medium，safe = low|clean；P/R/F1 只在可判定对（双方都非 unknown）上算；",
    "弃权（无法判断/报告缺失）单独计弃权率，不当错误；标注为 unknown 的维度不进任何分母，",
    "模型在其上给出判断的记入 goldUnknownPredicted 仅作观察。严格一致 = 4 档完全相等；", 
    "等级误差 MAE 按 clean=0/low=1/medium=2/high=3。", "",
    "| 维度 | tp | fp | tn | fn | 弃权 | P | R | F1 | 弃权率 | 严格一致 | MAE |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...SCORED_DIMENSIONS.map(dimension => tallyRow(dimension, report.dimensions[dimension]!)),
    tallyRow("**micro（三维度合并）**", report.micro),
    "", `宏平均：P=${report.macro.precision === null ? "—" : report.macro.precision.toFixed(3)}，` +
      `R=${report.macro.recall === null ? "—" : report.macro.recall.toFixed(3)}，F1=${report.macro.f1 === null ? "—" : report.macro.f1.toFixed(3)}。`, "",
    "## 分类别（三维度合并）", "",
    "| 类别 | 用例 | tp | fp | tn | fn | 弃权 | P | R | F1 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.perCategory.map(row => `| ${row.category} | ${row.cases} | ${row.tp} | ${row.fp} | ${row.tn} | ${row.fn} | ${row.abstain} | ` +
      `${row.precision === null ? "—" : row.precision.toFixed(3)} | ${row.recall === null ? "—" : row.recall.toFixed(3)} | ${row.f1 === null ? "—" : row.f1.toFixed(3)} |`), "",
    "## 逐例", "",
    "| 用例 | 类别 | 报告 | video | author | comments | overall |",
    "|---|---|---|---|---|---|---|",
    ...report.cases.map(row => `| ${row.id} | ${row.category} | ${row.reportFound ? "✔" : "缺失"} | ` +
      SCORED_DIMENSIONS.map(dimension => levelCell(row.pairs[dimension]!)).join(" | ") + " |"), "",
  ].join("\n");
}

// ---------- 数据加载与预测器 ----------

/** 标注文件格式：{ version: 1, cases: [{ id, category, gold: { video, author, comments, overall }, notes? }] } */
export async function loadLabels(labelsPath: string): Promise<ScannerGoldCase[]> {
  const text = await fs.readFile(labelsPath, "utf-8");
  const raw = JSON.parse(text) as { version?: number; cases?: Array<Record<string, unknown>> };
  if (!Array.isArray(raw.cases)) throw new Error(`标注文件缺少 cases 数组：${labelsPath}`);
  return raw.cases.map(entry => {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new Error(`标注文件存在缺少 id 的条目：${labelsPath}`);
    const gold = entry.gold as Record<string, unknown> | undefined;
    if (typeof gold !== "object" || gold === null) throw new Error(`标注 ${id} 缺少 gold 对象`);
    const level = (key: string) => normalizeLevel(gold[key]);
    return {
      id,
      category: typeof entry.category === "string" && entry.category.trim() ? entry.category.trim() : "未分类",
      gold: { video: level("video"), author: level("author"), comments: level("comments"), overall: level("overall") },
      ...(typeof entry.notes === "string" ? { notes: entry.notes } : {}),
    } satisfies ScannerGoldCase;
  });
}

export interface ScannerSourceRegistryOptions {
  datasetDir: string;
  /** ingest_findings 落盘位置：评测一律指向评测工作目录，绝不写真实 .agent-data/findings.jsonl */
  findingsStorePath: string;
  /** 测试注入的假工具；缺省用真实工厂（datasetDir 由评测侧固定，子代理不可指定任意路径） */
  biliCollect?: ToolDefinition;
  inspectLink?: ToolDefinition;
  ragSearch?: ToolDefinition;
}

/** scanner 白名单之外的 4 个领域工具的注册来源：默认真实工具 + 评测侧的隔离配置 */
export function createScannerSourceRegistry(options: ScannerSourceRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(options.biliCollect ?? createBiliCollectTool({ datasetDir: options.datasetDir }));
  registry.register(options.ragSearch ?? createRagSearchTool());
  registry.register(options.inspectLink ?? createInspectLinkTool());
  registry.register(createIngestFindingsTool({ storePath: options.findingsStorePath }));
  return registry;
}

export interface LiveScanPredictorOptions {
  datasetDir: string;
  /** 评测工作目录：reports/ 存解析后的报告，raw/ 存原始回执，delegates/ 存轨迹，findings.jsonl 为隔离发现库 */
  workDir: string;
  model: string;
  /** 测试注入的 LLM 客户端；缺省由 Agent 按环境变量自建 */
  client?: OpenAI;
  budget?: DelegateBudget;
  maxIterations?: number;
  tools?: { biliCollect?: ToolDefinition; inspectLink?: ToolDefinition; ragSearch?: ToolDefinition };
}

export function createLiveScanPredictor(options: LiveScanPredictorOptions): ScanPredictor & { registry: ToolRegistry } {
  const reportsDir = path.join(options.workDir, "reports");
  const rawDir = path.join(options.workDir, "raw");
  const source = createScannerSourceRegistry({
    datasetDir: options.datasetDir,
    findingsStorePath: path.join(options.workDir, "findings.jsonl"),
    ...(options.tools ?? {}),
  });
  const delegate = createDelegateTaskTool({
    sourceRegistry: source,
    config: { model: options.model, ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}) },
    sandboxRoot: options.workDir,
    traceDir: path.join(options.workDir, "delegates"),
    ...(options.client ? { client: options.client } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
  });
  const predict = async (c: ScannerGoldCase): Promise<ScanOutcome> => {
    const observation = await delegate.execute({ role: "scanner", goal: `扫描 ${c.id} 的诈骗风险，报告风险等级与证据。` });
    const raw = typeof observation === "string" ? observation : JSON.stringify(observation);
    const report = parseScannerReport(raw);
    await fs.mkdir(rawDir, { recursive: true });
    await fs.writeFile(path.join(rawDir, `${c.id}.txt`), raw, "utf-8");
    if (report) {
      await fs.mkdir(reportsDir, { recursive: true });
      await fs.writeFile(path.join(reportsDir, `${c.id}.json`), JSON.stringify(report, null, 2) + "\n", "utf-8");
    }
    return { raw, report };
  };
  return Object.assign(predict, { registry: source });
}

// ---------- CLI ----------

function parseArgs(argv: string[]) {
  const known = new Set(["--self-check", "--live", "--replay", "--dataset", "--labels", "--output", "--model", "--limit", "--only", "--force"]);
  const options: {
    mode: "replay" | "live" | "self-check";
    dataset: string;
    labels: string;
    output: string;
    model?: string;
    limit?: number;
    only: string[];
    force: boolean;
  } = { mode: "replay", dataset: "dataset", labels: "benchmarks/scanner/labels.json", output: "work/scanner-eval", only: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!known.has(arg)) throw new Error(`未知参数 ${arg}（用法见 --help）`);
    if (arg === "--self-check" || arg === "--live") options.mode = arg === "--live" ? "live" : "self-check";
    else if (arg === "--force") options.force = true;
    else if (arg === "--only") options.only.push(argv[++i]!);
    else if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--limit 需要正整数");
      options.limit = value;
    } else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要一个值`);
      if (arg === "--dataset") options.dataset = value;
      else if (arg === "--labels") options.labels = value;
      else if (arg === "--output") options.output = value;
      else if (arg === "--model") options.model = value;
    }
  }
  return options;
}

async function persistEvalReport(workDir: string, report: ScannerEvalReport): Promise<void> {
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
  await fs.writeFile(path.join(workDir, "report.md"), renderScannerReport(report) + "\n", "utf-8");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log([
      "用法：",
      "  bun benchmarks/scanner_eval.ts --self-check [--output work/scanner-eval]        # 内置合成对照集，零调用",
      "  bun benchmarks/scanner_eval.ts --replay  [--labels ...] [--output ...]          # 对已存报告重新打分（默认）",
      "  bun benchmarks/scanner_eval.ts --live    [--dataset dataset] [--labels ...] [--model m]",
      "                                           [--limit N] [--only BVxxx ...] [--force]",
      "live 模式逐个真跑 scanner 子代理（走真实 delegate 管道）；发现库与轨迹都落在 --output 工作目录内，",
      "不污染真实 .agent-data。报告落 <output>/reports/<BV>.json，原始回执落 <output>/raw/<BV>.txt。",
    ].join("\n"));
  } else {
    const options = parseArgs(args);
    if (options.mode === "self-check") {
      const report = await runScannerEval(cannedCases, async (c) => ({ raw: cannedReports[c.id] ?? "" }), { mode: "canned" });
      await persistEvalReport(options.output, report);
      console.log(renderScannerReport(report));
      console.log(`报告已保存：${options.output}`);
    } else {
      const labels = await loadLabels(options.labels);
      const selected = options.only.length ? labels.filter(c => options.only.includes(c.id)) : labels;
      if (selected.length === 0) throw new Error(`标注文件中没有匹配的用例（--only=${options.only.join(",") || "无"}）：${options.labels}`);
      const reportsDir = path.join(options.output, "reports");
      const existingReports = new Set(
        await fs.readdir(reportsDir).then(files => files.filter(file => file.endsWith(".json")).map(file => file.slice(0, -".json".length))).catch(() => []),
      );
      if (options.mode === "live") {
        const live = selected.filter(c => !existingReports.has(c.id) || options.force);
        const capped = options.limit ? live.slice(0, options.limit) : live;
        const model = options.model ?? process.env.AGENT_MODEL ?? "glm-5.2";
        if (capped.length === 0) {
          console.log(`全部 ${selected.length} 条标注都已有报告，无需重跑（--force 强制重扫）。`);
        } else {
          console.log(`live 扫描 ${capped.length}/${selected.length} 条（模型 ${model}）；快照目录：${options.dataset}`);
          const predictor = createLiveScanPredictor({ datasetDir: options.dataset, workDir: options.output, model });
          for (const testCase of capped) {
            process.stdout.write(`扫描 ${testCase.id}（${testCase.category}）… `);
            const outcome = await predictor(testCase);
            console.log(outcome.report ? `完成（overall=${outcome.report.risk_level}）` : "未取得结构化报告，按整例弃权计");
          }
        }
      }
      // 打分一律走落盘报告（live 刚写完的也在其中），保证 live/replay 同一条打分路径
      const replayPredictor: ScanPredictor = async (c) => {
        try {
          return { raw: await fs.readFile(path.join(options.output, "reports", `${c.id}.json`), "utf-8") };
        } catch {
          return { raw: "" };
        }
      };
      const report = await runScannerEval(selected, replayPredictor, { mode: options.mode, ...(options.model ? { model: options.model } : {}) });
      await persistEvalReport(options.output, report);
      console.log(renderScannerReport(report));
      console.log(`报告已保存：${options.output}`);
    }
  }
}
