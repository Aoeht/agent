// src/frame/cli.ts
/**
 * 抽帧 CLI：读快照 → 视觉画像 → 窗口规划（模型回执文件 / 启发式冒烟）→ 预算内取样 → 九宫格。
 *
 *   # 1) 先让大模型规划：导出提示词，喂给任意模型，把 JSON 回执存成 plan.json
 *   bun run src/frame/cli.ts --bvid BV1xxx --print-prompt
 *
 *   # 2) 按模型规划抽帧（--video 指向已采集的视频文件）
 *   bun run src/frame/cli.ts --bvid BV1xxx --video work/videos/BV1xxx.mp4 --plan work/plan.json
 *
 *   # 3) 无模型时冒烟：直接用确定性粗定位窗口
 *   bun run src/frame/cli.ts --bvid BV1xxx --video work/videos/BV1xxx.mp4 --heuristic
 *
 * 只识别首个分 P（page=1）；作者档位默认按快照 author 计算，决定九宫格预算。
 * 产物（默认 dataset/<BV号>/frames/）：
 *   frames/       原分辨率帧（供 OCR / 单帧放大）
 *   grids/        每 9 帧一张九宫格（横屏 1920×1080 / 竖屏 1080×1920）
 *   manifest.json 窗口、帧、格位映射、视觉画像、预算与策略版本
 */
import fs from "node:fs/promises";
import path from "node:path";
import { scoreAuthor, type AuthorRiskLevel } from "../bili/author_risk";
import { loadSnapshot, loadTranscriptFile, normalizeTranscript, resolveBvid } from "../bili/snapshot";
import { loadAuthorHistory } from "../bili/author_history";
import { sampleFrames, probeDuration } from "./extract";
import { composeGrids } from "./grid";
import {
  attachFocusTimes,
  buildWindowPlannerMessages,
  heuristicWindows,
  parseFramePlan,
} from "./plan";
import { frameBudgetFor } from "./policy";
import { probeVideoProfile, type VideoProfile } from "./profile";
import {
  FRAME_POLICY_VERSION,
  PLANNER_PROMPT_VERSION,
  type FrameBundle,
  type FramePlan,
  type FrameWindow,
} from "./types";

const LEVELS: AuthorRiskLevel[] = ["high", "medium", "low", "clean", "unknown"];

interface CliArgs {
  bvid: string;
  snapshot?: string;
  transcript?: string;
  findings?: string;
  video?: string;
  planFile?: string;
  heuristic: boolean;
  printPrompt: boolean;
  outDir?: string;
  maxWindows?: number;
  authorLevel?: AuthorRiskLevel;
  maxGrids?: number;
  probeEveryS?: number;
  noProfile: boolean;
  noScenes: boolean;
}

function usage(): string {
  return [
    "用法: bun run src/frame/cli.ts --bvid <BV号> [选项]",
    "",
    "  --video <path>        视频文件（抽帧必需；--print-prompt 时可不给）",
    "  --snapshot <path>     快照文件，默认 dataset/<BV号>.json",
    "  --transcript <path>   本次使用的 SRT / transcript JSON（覆盖快照转写）",
    "  --findings <path>     作者历史 JSONL，默认 .agent-data/findings.jsonl",
    "  --plan <path>         模型规划回执（JSON 或带代码块的原文）",
    "  --heuristic           不调模型，直接用确定性粗定位窗口（冒烟用）",
    "  --print-prompt        只输出窗口规划提示词并退出",
    "  --out <dir>           产物目录，默认 dataset/<BV号>/frames",
    "  --author-level <lvl>  覆盖作者档位：high|medium|low|clean|unknown",
    "  --max-grids <n>       覆盖全局九宫格预算（默认按作者档位）",
    "  --probe-every <sec>   规划窗口内的覆盖探针间隔",
    "  --no-profile          跳过视觉画像预扫描",
    "  --no-scenes           跳过窗口硬切检测",
    "  --max-windows <n>     最多保留几个模型窗口，默认不限（覆盖窗口另计）",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
  const valueOf = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const bvidInput = valueOf("--bvid");
  if (bvidInput === undefined) throw new Error(`缺少 --bvid\n\n${usage()}`);
  const bvid = resolveBvid(bvidInput);
  const maxWindowsRaw = valueOf("--max-windows");
  const maxGridsRaw = valueOf("--max-grids");
  const probeEveryRaw = valueOf("--probe-every");
  const maxWindows = maxWindowsRaw === undefined ? undefined : Number.parseInt(maxWindowsRaw, 10);
  const maxGrids = maxGridsRaw === undefined ? undefined : Number.parseInt(maxGridsRaw, 10);
  const probeEveryS = probeEveryRaw === undefined ? undefined : Number.parseFloat(probeEveryRaw);
  if (maxWindows !== undefined && (!Number.isInteger(maxWindows) || maxWindows < 1)) {
    throw new Error(`--max-windows 必须是正整数：${maxWindowsRaw}`);
  }
  if (maxGrids !== undefined && (!Number.isInteger(maxGrids) || maxGrids < 1)) {
    throw new Error(`--max-grids 必须是正整数：${maxGridsRaw}`);
  }
  if (probeEveryS !== undefined && (!Number.isFinite(probeEveryS) || probeEveryS <= 0)) {
    throw new Error(`--probe-every 必须是正数：${probeEveryRaw}`);
  }
  const levelRaw = valueOf("--author-level");
  if (levelRaw !== undefined && !LEVELS.includes(levelRaw as AuthorRiskLevel)) {
    throw new Error(`--author-level 取值必须是 ${LEVELS.join("|")}：${levelRaw}`);
  }
  return {
    bvid,
    ...(valueOf("--snapshot") === undefined ? {} : { snapshot: valueOf("--snapshot")! }),
    ...(valueOf("--transcript") === undefined ? {} : { transcript: valueOf("--transcript")! }),
    ...(valueOf("--findings") === undefined ? {} : { findings: valueOf("--findings")! }),
    ...(valueOf("--video") === undefined ? {} : { video: valueOf("--video")! }),
    ...(valueOf("--plan") === undefined ? {} : { planFile: valueOf("--plan")! }),
    heuristic: argv.includes("--heuristic"),
    printPrompt: argv.includes("--print-prompt"),
    ...(valueOf("--out") === undefined ? {} : { outDir: valueOf("--out")! }),
    ...(maxWindows === undefined ? {} : { maxWindows }),
    ...(levelRaw === undefined ? {} : { authorLevel: levelRaw as AuthorRiskLevel }),
    ...(maxGrids === undefined ? {} : { maxGrids }),
    ...(probeEveryS === undefined ? {} : { probeEveryS }),
    noProfile: argv.includes("--no-profile"),
    noScenes: argv.includes("--no-scenes"),
  };
}

function clampWindows(windows: FrameWindow[], durationS: number): FrameWindow[] {
  return windows
    .map((window) => {
      const start = Math.max(0, Math.min(window.start_s, durationS));
      const end = Math.max(0, Math.min(window.end_s, durationS));
      return { ...window, start_s: start, end_s: end };
    })
    .filter((window) => window.end_s - window.start_s >= 0.5);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const datasetDir = path.resolve(process.env.BILI_DATASET_DIR ?? "dataset");
  const snapshotPath = args.snapshot === undefined
    ? path.join(datasetDir, `${args.bvid}.json`)
    : path.resolve(args.snapshot);
  // loadSnapshot 以目录 + 文件名定位；自定义路径时用文件名反推，不假设它叫 <BV号>.json
  const snapshot = await loadSnapshot(
    path.dirname(snapshotPath),
    path.basename(snapshotPath, ".json"),
  );
  if (snapshot.bvid !== args.bvid) throw new Error("快照 BV 号与 --bvid 不一致");
  if (args.transcript !== undefined) snapshot.transcript = await loadTranscriptFile(path.resolve(args.transcript), args.bvid);

  if (args.printPrompt) {
    const messages = buildWindowPlannerMessages(snapshot, {
      ...(args.maxWindows === undefined ? {} : { maxWindows: args.maxWindows }),
    });
    process.stdout.write(`${JSON.stringify(messages, null, 2)}\n`);
    return;
  }

  if (args.video === undefined) throw new Error(`抽帧需要 --video\n\n${usage()}`);
  const videoPath = path.resolve(args.video);
  const durationS = await probeDuration(videoPath);

  let plan: FramePlan;
  if (args.planFile !== undefined) {
    const raw = await fs.readFile(path.resolve(args.planFile), "utf8");
    plan = parseFramePlan(raw, {
      bvid: args.bvid,
      durationS,
      // 外部/人工 plan 不设默认上限：文件里写了几个窗口就抽几个；要限流时显式给 --max-windows
      maxWindows: args.maxWindows ?? Number.POSITIVE_INFINITY,
    });
  } else {
    const windows = heuristicWindows(snapshot, {
      ...(args.maxWindows === undefined ? {} : { maxWindows: args.maxWindows }),
    });
    if (windows.length === 0) {
      throw new Error("快照没有可用时长，无法生成冒烟窗口；请提供 --plan");
    }
    plan = {
      bvid: args.bvid,
      policy_version: FRAME_POLICY_VERSION,
      planner_version: PLANNER_PROMPT_VERSION,
      windows,
      notes: "heuristic：未调用模型，仅用于冒烟",
    };
  }
  const planWindows = clampWindows(plan.windows, durationS).map((window) => ({
    ...window,
    source: args.planFile === undefined ? "heuristic" as const : "plan" as const,
  }));
  const windows = attachFocusTimes(snapshot, planWindows);
  if (windows.length === 0 && plan.windows.length > 0) throw new Error("规划窗口全部落在视频时长之外");

  let profile: VideoProfile | undefined;
  if (!args.noProfile) {
    try {
      profile = await probeVideoProfile(videoPath);
    } catch (error) {
      console.error(`视觉画像失败，降级为窗口+硬切取样：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ownerMid = snapshot.author?.mid ?? snapshot.video?.owner_mid;
  if (snapshot.author?.mid !== undefined && snapshot.video?.owner_mid !== undefined
    && String(snapshot.author.mid) !== String(snapshot.video.owner_mid)) throw new Error("作者 MID 与视频 owner_mid 不一致");
  const authorHistory = await loadAuthorHistory(ownerMid, {
    excludeBvid: args.bvid,
    ...(args.findings === undefined ? {} : { storePath: path.resolve(args.findings) }),
  });
  const authorRisk = scoreAuthor({ ...snapshot.author, history_level: authorHistory.level });
  const level = args.authorLevel ?? authorRisk.level;
  const budget = frameBudgetFor(level, args.maxGrids === undefined ? {} : { maxGrids: args.maxGrids });

  const outDir = path.resolve(args.outDir ?? path.join(datasetDir, args.bvid, "frames"));
  const frameDir = path.join(outDir, "frames");
  const gridDir = path.join(outDir, "grids");

  const sampled = await sampleFrames({
    videoPath,
    plan: { ...plan, windows },
    outDir: frameDir,
    durationS,
    ...(profile === undefined ? {} : { profile }),
    budget,
    options: {
      ...(args.probeEveryS === undefined ? {} : { selection: { probeEveryS: args.probeEveryS } }),
      ...(args.noScenes ? { detectScenes: false } : {}),
    },
  });
  const frames = sampled.frames;
  const grids = await composeGrids(frames, gridDir, {
    orientation: profile?.orientation ?? "landscape",
  });

  const bundle: FrameBundle = {
    bvid: args.bvid,
    page: 1,
    policy_version: plan.policy_version,
    planner_version: plan.planner_version,
    plan_source: args.planFile === undefined ? "heuristic" : "plan_file",
    ...(plan.notes === undefined ? {} : { plan_notes: plan.notes }),
    video_path: videoPath,
    duration_s: durationS,
    generated_at: new Date().toISOString(),
    inputs: {
      transcript_source: snapshot.transcript?.source ?? "none",
      transcript_segments: normalizeTranscript(snapshot).length,
      author_history: authorHistory,
    },
    windows: sampled.windows,
    frames,
    grids,
    ...(profile === undefined ? {} : { profile: profile.summary }),
    policy: {
      author_level: level,
      author_score: authorRisk.score,
      author_reasons: authorRisk.reasons,
      max_grids: budget.max_grids,
      per_window_max: budget.per_window_max,
      selected_frames: frames.length,
      truncated: sampled.truncated,
    },
  };
  const manifestPath = path.join(outDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  if (profile !== undefined) {
    console.log(
      `视觉画像：${profile.kind}，${profile.orientation}${profile.text_heavy ? "，文字密集" : ""}` +
      `（采样 ${profile.summary.sample_count} 点，静态 ${(profile.summary.static_ratio * 100).toFixed(0)}%，` +
      `大变化 ${(profile.summary.big_change_ratio * 100).toFixed(0)}%）`,
    );
  }
  console.log(
    `作者档位 ${level}（分数 ${authorRisk.score ?? "未知"}，预算 ${budget.max_grids} 张 / 单窗 ${budget.per_window_max} 帧）` +
    `${args.authorLevel === undefined ? "" : "［手动覆盖］"}`,
  );
  console.log(
    `视频时长 ${durationS.toFixed(1)}s，窗口 ${sampled.windows.length} 个` +
    `（含覆盖 ${sampled.windows.filter((window) => window.source === "coverage").length} 个），` +
    `候选 ${sampled.candidate_count} 个，帧 ${frames.length} 张，拼图 ${grids.length} 张` +
    `${sampled.truncated ? "（已按预算截断）" : ""}`,
  );
  for (const [index, window] of sampled.windows.entries()) {
    const focus = window.focus_times?.length ?? 0;
    console.log(
      `  窗口 ${index + 1}: ${window.start_s.toFixed(1)}-${window.end_s.toFixed(1)}s ` +
      `focus ${focus} 个 ${window.reason}`,
    );
  }
  for (const grid of grids) {
    console.log(`  ${grid.path}（${grid.width}×${grid.height}，${grid.cells.length} 格）`);
  }
  console.log(`manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
