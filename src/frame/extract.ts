// src/frame/extract.ts
/**
 * 确定性抽帧：窗口内取首尾帧、场景切换帧与固定间隔帧，去重后限流。
 * 抽帧不做任何语义判断，只保证"窗口内时间点可复现、帧文件可追溯"。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractedFrame, FramePlan, FrameReason, FrameWindow } from "./types";

export interface FrameSampleOptions {
  /** 固定间隔秒数（默认 2.5） */
  intervalS?: number;
  /** 单窗口最多抽几帧（默认 9，正好一张九宫格） */
  maxFramesPerWindow?: number;
  /** 场景切换阈值（默认 0.3，越高越严格） */
  sceneThreshold?: number;
  /** ffmpeg 并发数（默认 3） */
  concurrency?: number;
  /** 保存原帧的 JPEG 质量（默认 2，越小越好） */
  jpegQuality?: number;
  /** 原帧最大宽度（默认 1280；九宫格缩略图另算） */
  maxWidth?: number;
}

const DEFAULTS = {
  intervalS: 2.5,
  maxFramesPerWindow: 9,
  sceneThreshold: 0.3,
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

const REASON_RANK: Record<FrameReason, number> = { scene: 3, edge: 2, interval: 1 };

/** 从有序候选里等距取 count 个，保证名额花在整段窗口而不是挤在前几秒 */
function takeEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= items.length) return items.slice();
  if (count === 1) return [items[Math.floor(items.length / 2)]!];
  const picked: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (items.length - 1)) / (count - 1));
    picked.push(items[index]!);
  }
  return picked;
}

/**
 * 选时间点：首尾帧必留，场景帧优先，剩余用固定间隔补齐；0.5 秒内视为同一帧。
 * 结果按时间排序，数量不超过 maxFrames。
 */
export function pickFrameTimes(
  window: FrameWindow,
  sceneTimes: number[],
  options: { intervalS?: number; maxFrames?: number } = {},
): Array<{ t: number; reason: FrameReason }> {
  const intervalS = options.intervalS ?? DEFAULTS.intervalS;
  const maxFrames = Math.max(1, options.maxFrames ?? DEFAULTS.maxFramesPerWindow);
  const start = window.start_s;
  const end = window.end_s;
  const candidates = new Map<number, { t: number; reason: FrameReason }>();

  const add = (rawT: number, reason: FrameReason) => {
    if (!Number.isFinite(rawT)) return;
    const t = Math.max(start, Math.min(end - 0.05, rawT));
    const key = Math.round(t * 2) / 2;
    const existing = candidates.get(key);
    if (existing === undefined || REASON_RANK[reason] > REASON_RANK[existing.reason]) {
      candidates.set(key, { t, reason });
    }
  };

  add(start + 0.05, "edge");
  add(end - 0.05, "edge");
  for (const t of sceneTimes) add(t, "scene");
  for (let t = start; t < end; t += intervalS) add(t, "interval");

  const all = [...candidates.values()].sort((a, b) => a.t - b.t);
  if (all.length <= maxFrames) return all;
  if (maxFrames === 1) return [all[0]!];

  // 首尾必留；场景帧优先但要在窗口内等距铺开；剩余名额再用间隔帧均匀补齐
  const first = all[0]!;
  const last = all.at(-1)!;
  const forced = new Set([first.t, last.t]);
  const pool = all.filter((item) => !forced.has(item.t)).sort((a, b) => a.t - b.t);
  const scenes = pool.filter((item) => item.reason === "scene");
  const rest = pool.filter((item) => item.reason !== "scene");
  const chosen = [first, last];
  const remaining = maxFrames - chosen.length;
  const scenePicks = takeEvenly(scenes, Math.min(remaining, scenes.length));
  chosen.push(...scenePicks);
  chosen.push(...takeEvenly(rest, maxFrames - chosen.length));
  return chosen.sort((a, b) => a.t - b.t);
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

/** 对一份规划逐个窗口抽帧；返回的 path 是实际落盘的帧文件 */
export async function sampleFrames(params: {
  videoPath: string;
  plan: FramePlan;
  outDir: string;
  options?: FrameSampleOptions;
}): Promise<ExtractedFrame[]> {
  const { videoPath, plan, outDir } = params;
  const options = params.options ?? {};
  const intervalS = options.intervalS ?? DEFAULTS.intervalS;
  const maxFrames = options.maxFramesPerWindow ?? DEFAULTS.maxFramesPerWindow;
  const sceneThreshold = options.sceneThreshold ?? DEFAULTS.sceneThreshold;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const jpegQuality = options.jpegQuality ?? DEFAULTS.jpegQuality;
  const maxWidth = options.maxWidth ?? DEFAULTS.maxWidth;

  await fs.mkdir(outDir, { recursive: true });
  const frames: ExtractedFrame[] = [];

  for (const [index, window] of plan.windows.entries()) {
    const windowIndex = index + 1;
    const sceneTimes = await detectSceneTimes(videoPath, window, sceneThreshold);
    const times = pickFrameTimes(window, sceneTimes, { intervalS, maxFrames });
    const extracted = await mapLimit(times, concurrency, async ({ t, reason }) => {
      const name = `w${windowIndex}_${t.toFixed(1).replace(".", "-")}s.jpg`;
      const outPath = path.join(outDir, name);
      await extractFrameAt(videoPath, t, outPath, { jpegQuality, maxWidth });
      return {
        path: outPath,
        t,
        window_index: windowIndex,
        reason,
        sha256: await sha256(outPath),
      } satisfies ExtractedFrame;
    });
    frames.push(...extracted);
  }

  return frames;
}
