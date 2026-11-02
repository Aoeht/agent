// src/frame/cli.ts
/**
 * 抽帧 CLI：读快照 → 窗口规划（模型回执文件 / 启发式冒烟）→ 抽帧 → 九宫格。
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
 * 产物（默认 dataset/<BV号>/frames/）：
 *   frames/       原分辨率帧（供 OCR / 单帧放大）
 *   grids/        每窗口一张 3×3 九宫格（1920×1080）
 *   manifest.json 窗口、帧、格位映射、策略版本
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadSnapshot, resolveBvid } from "../bili/snapshot";
import { sampleFrames, probeDuration } from "./extract";
import { composeGrids } from "./grid";
import {
  buildWindowPlannerMessages,
  heuristicWindows,
  parseFramePlan,
} from "./plan";
import {
  FRAME_POLICY_VERSION,
  PLANNER_PROMPT_VERSION,
  type FrameBundle,
  type FramePlan,
  type FrameWindow,
} from "./types";

interface CliArgs {
  bvid: string;
  snapshot?: string;
  video?: string;
  planFile?: string;
  heuristic: boolean;
  printPrompt: boolean;
  outDir?: string;
  intervalS?: number;
  maxWindows?: number;
}

function usage(): string {
  return [
    "用法: bun run src/frame/cli.ts --bvid <BV号> [选项]",
    "",
    "  --video <path>        视频文件（抽帧必需；--print-prompt 时可不给）",
    "  --snapshot <path>     快照文件，默认 dataset/<BV号>.json",
    "  --plan <path>         模型规划回执（JSON 或带代码块的原文）",
    "  --heuristic           不调模型，直接用确定性粗定位窗口（冒烟用）",
    "  --print-prompt        只输出窗口规划提示词并退出",
    "  --out <dir>           产物目录，默认 dataset/<BV号>/frames",
    "  --interval <sec>      窗口内固定间隔，默认 2.5",
    "  --max-windows <n>     最多保留几个窗口，默认 2",
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
  const intervalRaw = valueOf("--interval");
  const maxWindowsRaw = valueOf("--max-windows");
  const intervalS = intervalRaw === undefined ? undefined : Number.parseFloat(intervalRaw);
  const maxWindows = maxWindowsRaw === undefined ? undefined : Number.parseInt(maxWindowsRaw, 10);
  if (intervalS !== undefined && (!Number.isFinite(intervalS) || intervalS <= 0)) {
    throw new Error(`--interval 必须是正数：${intervalRaw}`);
  }
  if (maxWindows !== undefined && (!Number.isInteger(maxWindows) || maxWindows < 1)) {
    throw new Error(`--max-windows 必须是正整数：${maxWindowsRaw}`);
  }
  return {
    bvid,
    ...(valueOf("--snapshot") === undefined ? {} : { snapshot: valueOf("--snapshot")! }),
    ...(valueOf("--video") === undefined ? {} : { video: valueOf("--video")! }),
    ...(valueOf("--plan") === undefined ? {} : { planFile: valueOf("--plan")! }),
    heuristic: argv.includes("--heuristic"),
    printPrompt: argv.includes("--print-prompt"),
    ...(valueOf("--out") === undefined ? {} : { outDir: valueOf("--out")! }),
    ...(intervalS === undefined ? {} : { intervalS }),
    ...(maxWindows === undefined ? {} : { maxWindows }),
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
      ...(args.maxWindows === undefined ? {} : { maxWindows: args.maxWindows }),
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
  const windows = clampWindows(plan.windows, durationS);
  if (windows.length === 0) throw new Error("规划窗口全部落在视频时长之外");

  const outDir = path.resolve(args.outDir ?? path.join(datasetDir, args.bvid, "frames"));
  const frameDir = path.join(outDir, "frames");
  const gridDir = path.join(outDir, "grids");

  const frames = await sampleFrames({
    videoPath,
    plan: { ...plan, windows },
    outDir: frameDir,
    ...(args.intervalS === undefined ? {} : { options: { intervalS: args.intervalS } }),
  });
  const grids = await composeGrids(frames, gridDir);

  const bundle: FrameBundle = {
    bvid: args.bvid,
    policy_version: plan.policy_version,
    planner_version: plan.planner_version,
    plan_source: args.planFile === undefined ? "heuristic" : "plan_file",
    ...(plan.notes === undefined ? {} : { plan_notes: plan.notes }),
    video_path: videoPath,
    duration_s: durationS,
    generated_at: new Date().toISOString(),
    windows,
    frames,
    grids,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  console.log(`视频时长 ${durationS.toFixed(1)}s，窗口 ${windows.length} 个，帧 ${frames.length} 张，拼图 ${grids.length} 张`);
  for (const [index, window] of windows.entries()) {
    console.log(`  窗口 ${index + 1}: ${window.start_s.toFixed(1)}-${window.end_s.toFixed(1)}s ${window.reason}`);
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
