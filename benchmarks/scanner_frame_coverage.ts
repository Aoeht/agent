// benchmarks/scanner_frame_coverage.ts
/**
 * 抽帧窗口覆盖率评测（recall@budget）：人工标注的风险窗口有多少被采样帧盖住、
 * 覆盖帧落在第几张九宫格。回答"预算档位砍掉后有没有漏证据"。
 *
 * 输入：
 * - 标注文件（默认 work/annotation/labels.json，格式 {videos:{BV:{risk,windows:[{start_s,end_s,note}]}}}）
 * - 抽帧产物目录（frame CLI 的 --out，每个 BV 一个 <dir>/<BV>/manifest.json）
 *
 * 口径：
 * - 窗口 [start_s, end_s) 被覆盖 = 存在采样帧 t ∈ [start_s, end_s)；覆盖帧格号 = floor(帧序/每格帧数)+1。
 * - note 命中 评论区/评论/弹幕/置顶 的窗口归为 comment 类：证据住在评论区/弹幕里，
 *   帧管线定义上无法保证覆盖，单列统计、不计入主指标（帧偶尔也能拍到置顶评论画面，如实记录）。
 * - 主指标 = visual 窗口覆盖率，overall + 按实际预算档位（manifest policy.author_level）分组 + recall@k。
 * - 缺 manifest 的视频单独列出，不进分母（没抽帧不是覆盖失败）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_FRAMES_PER_GRID } from "../src/frame/types";

export interface GoldWindow {
  start_s: number;
  end_s: number;
  note: string;
}

export type WindowClass = "comment" | "visual";

const COMMENT_NOTE_PATTERN = /评论区|评论|弹幕|置顶/;

/** note 指向评论区/弹幕证据 → comment 类（帧管线覆盖不了的地板，单列） */
export function classifyWindow(note: string | undefined): WindowClass {
  return note && COMMENT_NOTE_PATTERN.test(note) ? "comment" : "visual";
}

/** 帧序（1 起）→ 九宫格序号 */
export function frameGridIndex(frameOrder: number, perGrid: number = MAX_FRAMES_PER_GRID): number {
  return Math.floor((frameOrder - 1) / perGrid) + 1;
}

export interface WindowCoverage {
  covered: boolean;
  /** 首个覆盖帧的九宫格序号；未覆盖为 null */
  first_grid: number | null;
  /** 首个覆盖帧的时间点；未覆盖为 null */
  frame_t: number | null;
}

/** 窗口 [start_s, end_s) 是否被采样帧覆盖；帧序按数组顺序（即拼图顺序） */
export function coverWindow(
  frames: Array<{ t: number }>,
  window: { start_s: number; end_s: number },
  perGrid: number = MAX_FRAMES_PER_GRID,
): WindowCoverage {
  const order = frames.findIndex((f) => f.t >= window.start_s && f.t < window.end_s);
  if (order < 0) return { covered: false, first_grid: null, frame_t: null };
  return { covered: true, first_grid: frameGridIndex(order + 1, perGrid), frame_t: frames[order]!.t };
}

export interface ManifestSource {
  /** 抽帧 manifest（FrameBundle）；缺失返回 null 由上层计 missing */
  frames: Array<{ t: number }>;
  author_level?: string;
}

export interface CoverageCase {
  bv: string;
  risk: string;
  windows: GoldWindow[];
  manifest: ManifestSource | null;
}

export interface WindowRow {
  bv: string;
  risk: string;
  level: string;
  klass: WindowClass;
  start_s: number;
  end_s: number;
  note: string;
  covered: boolean;
  first_grid: number | null;
  frame_t: number | null;
}

export interface GroupStat {
  windows: number;
  covered: number;
  /** 覆盖率；分母为 0 时 null */
  coverage: number | null;
}

export interface FrameCoverageReport {
  generated_at: string;
  per_grid: number;
  totals: {
    videos: number;
    videos_missing_manifest: number;
    windows: number;
    visual_windows: number;
    visual_covered: number;
    comment_windows: number;
    comment_covered: number;
  };
  /** 主指标：visual 窗口覆盖率，overall + 按实际预算档位 + recall@k */
  visual: {
    overall: GroupStat;
    by_level: Record<string, GroupStat>;
    recall_at_k: Record<string, number | null>;
  };
  comment: GroupStat;
  missing_manifest: string[];
  uncovered: WindowRow[];
  rows: WindowRow[];
}

function groupStat(rows: WindowRow[]): GroupStat {
  const covered = rows.filter((r) => r.covered).length;
  return { windows: rows.length, covered, coverage: rows.length ? covered / rows.length : null };
}

const RECALL_K = [1, 3, 5, 10] as const;

export function summarizeFrameCoverage(cases: CoverageCase[], perGrid: number = MAX_FRAMES_PER_GRID): FrameCoverageReport {
  const rows: WindowRow[] = [];
  const missing: string[] = [];
  for (const c of cases) {
    if (!c.manifest) { missing.push(c.bv); continue; }
    for (const w of c.windows) {
      const result = coverWindow(c.manifest.frames, w, perGrid);
      rows.push({
        bv: c.bv, risk: c.risk, level: c.manifest.author_level ?? "unknown",
        klass: classifyWindow(w.note),
        start_s: w.start_s, end_s: w.end_s, note: w.note ?? "",
        covered: result.covered, first_grid: result.first_grid, frame_t: result.frame_t,
      });
    }
  }
  const visual = rows.filter((r) => r.klass === "visual");
  const comment = rows.filter((r) => r.klass === "comment");
  const byLevel: Record<string, GroupStat> = {};
  for (const row of visual) {
    (byLevel[row.level] ??= { windows: 0, covered: 0, coverage: null });
    byLevel[row.level]!.windows += 1;
    if (row.covered) byLevel[row.level]!.covered += 1;
  }
  for (const stat of Object.values(byLevel)) stat.coverage = stat.windows ? stat.covered / stat.windows : null;
  const recallAtK: Record<string, number | null> = {};
  for (const k of RECALL_K) {
    recallAtK[`@${k}`] = visual.length
      ? visual.filter((r) => r.covered && (r.first_grid ?? Number.MAX_SAFE_INTEGER) <= k).length / visual.length
      : null;
  }
  return {
    generated_at: new Date().toISOString(),
    per_grid: perGrid,
    totals: {
      videos: cases.length,
      videos_missing_manifest: missing.length,
      windows: rows.length,
      visual_windows: visual.length,
      visual_covered: visual.filter((r) => r.covered).length,
      comment_windows: comment.length,
      comment_covered: comment.filter((r) => r.covered).length,
    },
    visual: { overall: groupStat(visual), by_level: byLevel, recall_at_k: recallAtK },
    comment: groupStat(comment),
    missing_manifest: missing,
    uncovered: rows.filter((r) => !r.covered),
    rows,
  };
}

export function renderFrameCoverageReport(report: FrameCoverageReport): string {
  const lines = [
    `# 抽帧窗口覆盖率（per_grid=${report.per_grid}）`,
    "",
    `视频 ${report.totals.videos}（缺 manifest ${report.totals.videos_missing_manifest}）；`
      + `窗口 ${report.totals.windows} = visual ${report.totals.visual_windows} + comment ${report.totals.comment_windows}。`,
    "",
    `## 主指标：visual 窗口覆盖 ${report.totals.visual_covered}/${report.totals.visual_windows}`
      + `（${report.visual.overall.coverage === null ? "-" : (report.visual.overall.coverage * 100).toFixed(1) + "%"}）`,
    "",
    "| 预算档 | 覆盖/窗口 | 覆盖率 |",
    "|---|---:|---:|",
  ];
  for (const [level, stat] of Object.entries(report.visual.by_level)) {
    lines.push(`| ${level} | ${stat.covered}/${stat.windows} | ${stat.coverage === null ? "-" : (stat.coverage * 100).toFixed(1) + "%"} |`);
  }
  lines.push("",
    `recall@k（visual）：${Object.entries(report.visual.recall_at_k).map(([k, v]) => `${k}=${v === null ? "-" : v.toFixed(2)}`).join(" ")}`,
    "",
    `comment 类（帧管线不保证覆盖）：${report.totals.comment_covered}/${report.totals.comment_windows}`,
    "",
    `## 未覆盖 visual 窗口 ${report.uncovered.filter(r => r.klass === "visual").length} 个`,
    "");
  for (const row of report.uncovered.filter((r) => r.klass === "visual")) {
    lines.push(`- ${row.bv} ${row.start_s}-${row.end_s}s（${row.level}）${row.note.slice(0, 60)}`);
  }
  if (report.missing_manifest.length) {
    lines.push("", `## 缺 manifest（未计入分母）`, "", ...report.missing_manifest.map((bv) => `- ${bv}`));
  }
  return lines.join("\n");
}

interface CliOptions { manifests: string; labels: string; output: string; perGrid: number }

function parseArgs(argv: string[]): CliOptions {
  const known = new Set(["--manifests", "--labels", "--output", "--per-grid"]);
  const options: CliOptions = { manifests: "", labels: "work/annotation/labels.json", output: "work/frame-coverage-eval", perGrid: MAX_FRAMES_PER_GRID };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!known.has(arg)) throw new Error(`未知参数 ${arg}（用法见 --help）`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 需要一个值`);
    if (arg === "--manifests") options.manifests = value;
    else if (arg === "--labels") options.labels = value;
    else if (arg === "--output") options.output = value;
    else if (arg === "--per-grid") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("--per-grid 需要正整数");
      options.perGrid = parsed;
    }
  }
  if (!options.manifests) throw new Error("缺少 --manifests <抽帧产物目录>（每个 BV 一个 <dir>/<BV>/manifest.json）");
  return options;
}

interface LabelsFile {
  videos: Record<string, { bvid?: string; risk?: string; windows?: Array<{ start_s: number; end_s: number; note?: string }> }>;
}

export async function loadWindowLabels(labelsPath: string): Promise<CoverageCase[]> {
  const raw = JSON.parse(await fs.readFile(labelsPath, "utf8")) as LabelsFile;
  if (!raw?.videos || typeof raw.videos !== "object") throw new Error(`标注文件结构不对（缺 videos）：${labelsPath}`);
  return Object.entries(raw.videos).map(([bv, entry]) => ({
    bv: entry.bvid ?? bv,
    risk: entry.risk ?? "unknown",
    windows: (entry.windows ?? []).map((w) => ({
      start_s: w.start_s,
      end_s: w.end_s,
      note: w.note ?? "",
    })),
    manifest: null,
  }));
}

async function loadManifest(dir: string, bv: string): Promise<ManifestSource | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, bv, "manifest.json"), "utf8")) as Record<string, unknown>;
    const frames = Array.isArray(raw.frames) ? (raw.frames as Array<{ t: number }>) : [];
    const policy = raw.policy as { author_level?: string } | undefined;
    return { frames, ...(policy?.author_level ? { author_level: policy.author_level } : {}) };
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log([
      "用法：",
      "  bun benchmarks/scanner_frame_coverage.ts --manifests <抽帧产物目录> [--labels work/annotation/labels.json]",
      "                                           [--output work/frame-coverage-eval] [--per-grid 9]",
      "对标注了风险窗口的视频统计抽帧覆盖率：visual 窗口为主指标（评论区/弹幕类单列），",
      "overall + 按实际预算档位分组 + recall@k；报告落 <output>/report.json 与 report.md。",
    ].join("\n"));
  } else {
    const options = parseArgs(args);
    const cases = await loadWindowLabels(options.labels);
    for (const c of cases) c.manifest = await loadManifest(options.manifests, c.bv);
    const withManifest = cases.filter((c) => c.manifest);
    if (withManifest.length === 0) throw new Error(`--manifests 下没有匹配标注 BV 的 manifest：${options.manifests}`);
    const report = summarizeFrameCoverage(cases, options.perGrid);
    await fs.mkdir(options.output, { recursive: true });
    await fs.writeFile(path.join(options.output, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
    await fs.writeFile(path.join(options.output, "report.md"), renderFrameCoverageReport(report) + "\n", "utf-8");
    console.log(renderFrameCoverageReport(report));
    console.log(`报告已保存：${options.output}`);
  }
}
