// src/frame/extract.ts
/**
 * 确定性抽帧：视觉画像 + 场景硬切 + 可疑弹幕时间点生成候选，
 * 再按作者档位预算跨窗口选帧；静态段落只取 1 帧，连续变化段落按上限间隔取样。
 * 抽帧不做任何语义判断，只保证"时间点可复现、帧文件可追溯"。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { frameBudgetFor, type FrameBudget } from "./policy";
import type { VideoProfile } from "./profile";
import { appendCoverageWindows, selectFrameCandidates, type SelectionOptions } from "./select";
import type { ExtractedFrame, FramePlan, FrameWindow } from "./types";

export interface FrameSampleOptions {
  /** 场景像素变化阈值（默认 0.35，超过才抽） */
  sceneThreshold?: number;
  /** ffmpeg 并发数（默认 3） */
  concurrency?: number;
  /** 保存原帧的 JPEG 质量（默认 2，越小越好） */
  jpegQuality?: number;
  /** 原帧最大宽度（默认 1280；九宫格缩略图另算） */
  maxWidth?: number;
  /** 关闭场景检测：只用视觉画像与覆盖探针（覆盖窗口本来就不跑） */
  detectScenes?: boolean;
  /** 候选生成与去重参数 */
  selection?: SelectionOptions;
}

export interface SampleFramesParams {
  videoPath: string;
  plan: FramePlan;
  outDir: string;
  durationS?: number;
  profile?: VideoProfile;
  /** 缺省按 unknown 档（10 张九宫格） */
  budget?: FrameBudget;
  options?: FrameSampleOptions;
}

export interface SampleFramesResult {
  frames: ExtractedFrame[];
  /** 含自动补的全片覆盖窗口 */
  windows: FrameWindow[];
  candidate_count: number;
  /** 候选多于预算，发生了截断 */
  truncated: boolean;
  budget: FrameBudget;
}

const DEFAULTS = {
  sceneThreshold: 0.35,
  concurrency: 3,
  jpegQuality: 2,
  maxWidth: 1280,
} as const;

export class FrameExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameExtractError";
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new FrameExtractError(`无法执行 ${command}：${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(new FrameExtractError(`${command} 退出码 ${code}${tail ? `：${tail}` : ""}`));
      }
    });
  });
}

/** 读取视频时长（秒）；ffprobe 不可用或文件损坏时抛错 */
export async function probeDuration(videoPath: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    videoPath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new FrameExtractError(`无法读取视频时长：${videoPath}`);
  }
  return duration;
}

/**
 * 场景切换时间点。用 ffmpeg 的 scene 打分把"画面变化大"的时刻挑出来，
 * 失败时返回空数组（间隔帧仍然可用，不阻塞主流程）。
 */
export async function detectSceneTimes(
  videoPath: string,
  window: FrameWindow,
  threshold: number,
): Promise<number[]> {
  const duration = Math.max(0.1, window.end_s - window.start_s);
  try {
    const { stderr } = await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-loglevel", "info",
      "-ss", window.start_s.toFixed(3),
      "-i", videoPath,
      "-t", duration.toFixed(3),
      "-an", "-sn",
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ]);
    const times: number[] = [];
    for (const match of stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
      const value = Number.parseFloat(match[1]!);
      if (Number.isFinite(value)) times.push(window.start_s + value);
    }
    return times;
  } catch {
    return [];
  }
}

/** 单帧落盘：原分辨率（最多 maxWidth 宽），供 OCR/单帧放大；九宫格另做缩略 */
export async function extractFrameAt(
  videoPath: string,
  t: number,
  outPath: string,
  options: { jpegQuality?: number; maxWidth?: number } = {},
): Promise<void> {
  const quality = options.jpegQuality ?? DEFAULTS.jpegQuality;
  const maxWidth = options.maxWidth ?? DEFAULTS.maxWidth;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-ss", t.toFixed(3),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", String(quality),
    "-vf", `scale='min(${maxWidth},iw)':-2`,
    outPath,
  ]);
  const stat = await fs.stat(outPath).catch(() => undefined);
  if (stat === undefined || stat.size === 0) {
    throw new FrameExtractError(`抽帧失败，未生成文件：${outPath}`);
  }
}

async function sha256(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 抽帧主入口：补全片覆盖窗口 → 非覆盖窗口做硬切检测 → 按视觉画像生成候选 →
 * 预算内跨窗口选帧并落盘。返回最终窗口列表，manifest 与调用方共用同一份。
 */
export async function sampleFrames(params: SampleFramesParams): Promise<SampleFramesResult> {
  const { videoPath, plan, outDir, profile } = params;
  const options = params.options ?? {};
  const budget = params.budget ?? frameBudgetFor("unknown");
  const sceneThreshold = options.sceneThreshold ?? DEFAULTS.sceneThreshold;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const jpegQuality = options.jpegQuality ?? DEFAULTS.jpegQuality;
  const maxWidth = options.maxWidth ?? DEFAULTS.maxWidth;

  const fallbackDuration = plan.windows.reduce((max, window) => Math.max(max, window.end_s), 0);
  const durationS = params.durationS ?? profile?.meta.duration_s ?? fallbackDuration;
  const windows = appendCoverageWindows(plan.windows, durationS, budget, options.selection);

  const sceneTimes = new Map<number, number[]>();
  if (options.detectScenes !== false) {
    for (const [index, window] of windows.entries()) {
      if (window.source === "coverage") continue;
      sceneTimes.set(index + 1, await detectSceneTimes(videoPath, window, sceneThreshold));
    }
  }

  const selection = selectFrameCandidates({
    windows,
    budget,
    ...(profile === undefined ? {} : { profile }),
    sceneTimes,
    ...(options.selection === undefined ? {} : { options: options.selection }),
  });

  await fs.mkdir(outDir, { recursive: true });
  const frames = await mapLimit(selection.selected, concurrency, async (candidate) => {
    const name = `w${candidate.window_index}_${candidate.t.toFixed(1).replace(".", "-")}s.jpg`;
    const outPath = path.join(outDir, name);
    await extractFrameAt(videoPath, candidate.t, outPath, { jpegQuality, maxWidth });
    return {
      path: outPath,
      t: candidate.t,
      window_index: candidate.window_index,
      reason: candidate.reason,
      sha256: await sha256(outPath),
    } satisfies ExtractedFrame;
  });

  return {
    frames,
    windows,
    candidate_count: selection.candidate_count,
    truncated: selection.candidate_count > selection.selected.length,
    budget,
  };
}
