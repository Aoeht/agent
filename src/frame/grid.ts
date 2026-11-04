// src/frame/grid.ts
/**
 * 九宫格拼图：把最多 9 帧拼成一张 3×3 大图，每格左上角烧录
 * "W窗 C格 时间"标签。跨窗口连续填充：一个窗口不足 9 帧时，用后续窗口的帧补齐，
 * 只有最后一张图允许留空。一次视觉请求只发一张图，既避开图片通道张数上限，
 * 又让模型能按格位回报证据（"第 5 格 10.0s 出现收款码"）。
 *
 * 拼图只做缩略定位，不承担读小字：原帧仍单独保留，需要时可单帧放大 + OCR。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_FRAMES_PER_GRID,
  type ExtractedFrame,
  type FrameGrid,
  type GridCell,
} from "./types";

export interface GridOptions {
  /** 按画面方向选格子尺寸：横屏 640×360，竖屏 360×640；显式 tileWidth/tileHeight 优先 */
  orientation?: "landscape" | "portrait" | "square";
  /** 单格宽（默认按 orientation） */
  tileWidth?: number;
  /** 单格高（默认按 orientation） */
  tileHeight?: number;
  /** 标签字体；缺省自动找系统字体，找不到就不烧录标签 */
  fontPath?: string;
  /** JPEG 质量（默认 2） */
  jpegQuality?: number;
}

export class FrameGridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameGridError";
  }
}

const DEFAULTS = { tileWidth: 640, tileHeight: 360, jpegQuality: 2 } as const;

const ORIENTATION_TILES = {
  landscape: { tileWidth: 640, tileHeight: 360 },
  portrait: { tileWidth: 360, tileHeight: 640 },
  square: { tileWidth: 480, tileHeight: 480 },
} as const;

function resolveTileSize(options: GridOptions): { tileWidth: number; tileHeight: number } {
  const base = ORIENTATION_TILES[options.orientation ?? "landscape"];
  return {
    tileWidth: options.tileWidth ?? base.tileWidth,
    tileHeight: options.tileHeight ?? base.tileHeight,
  };
}

const CANDIDATE_FONTS = [
  "C:/Windows/Fonts/arial.ttf",
  "C:/Windows/Fonts/msyh.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
];

function findFont(explicit?: string): string | undefined {
  if (explicit !== undefined) return existsSync(explicit) ? explicit : undefined;
  return CANDIDATE_FONTS.find((candidate) => existsSync(candidate));
}

/** ffmpeg 滤镜里的字体路径：统一斜杠，冒号是选项分隔符，必须转义 */
function escapeFontPath(fontPath: string): string {
  return fontPath.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new FrameGridError(`无法执行 ffmpeg：${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(new FrameGridError(`九宫格拼接失败（退出码 ${code}）${tail ? `：${tail}` : ""}`));
      }
    });
  });
}

function labelFor(frame: ExtractedFrame | undefined, cellIndex: number): string {
  if (frame === undefined) return "empty";
  return `W${frame.window_index} C${cellIndex} ${frame.t.toFixed(1)}s`;
}

/** 单格滤镜：等比缩放 + 黑边补齐 + 左上角标签 */
function cellFilter(
  inputIndex: number,
  outputLabel: string,
  label: string,
  options: { tileWidth: number; tileHeight: number; fontPath?: string },
): string {
  const { tileWidth, tileHeight } = options;
  const base =
    `[${inputIndex}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease,` +
    `pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const draw = options.fontPath === undefined
    ? ""
    : `,drawtext=fontfile='${escapeFontPath(options.fontPath)}':text='${label}':x=8:y=8:` +
      `fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55`;
  return `${base}${draw}[${outputLabel}]`;
}

/**
 * 把最多 9 帧拼成一张 3×3 图；不足 9 帧的空位用黑格占位，格位编号保持稳定。
 * 返回的 cells 只列真实帧，index 是模型回报证据时使用的格位。
 */
export async function composeNineGrid(
  frames: ExtractedFrame[],
  outPath: string,
  options: GridOptions = {},
): Promise<FrameGrid> {
  if (frames.length === 0) throw new FrameGridError("没有可拼图的帧");
  if (frames.length > MAX_FRAMES_PER_GRID) {
    throw new FrameGridError(`单张九宫格最多 ${MAX_FRAMES_PER_GRID} 帧，收到 ${frames.length} 帧`);
  }
  const { tileWidth, tileHeight } = resolveTileSize(options);
  const jpegQuality = options.jpegQuality ?? DEFAULTS.jpegQuality;
  const fontPath = findFont(options.fontPath);
  const gridWidth = tileWidth * 3;
  const gridHeight = tileHeight * 3;

  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  const inputCount = 9;
  const cells: GridCell[] = [];

  for (let i = 0; i < inputCount; i += 1) {
    const frame = frames[i];
    if (frame !== undefined) {
      args.push("-i", frame.path);
      cells.push({ index: i + 1, t: frame.t, frame_path: frame.path });
    } else {
      // 空位用 1 帧纯黑源，保证 xstack 的输入数与尺寸固定
      args.push("-f", "lavfi", "-i", `color=c=black:s=${tileWidth}x${tileHeight}:d=1`);
    }
  }

  const filterLines: string[] = [];
  for (let i = 0; i < inputCount; i += 1) {
    const frame = frames[i];
    // filter_complex_script 用分号分隔滤镜链；只换行会被当成同一条链
    filterLines.push(
      `${cellFilter(i, `v${i}`, labelFor(frame, i + 1), {
        tileWidth,
        tileHeight,
        ...(fontPath === undefined ? {} : { fontPath }),
      })};`,
    );
  }
  const layout = [
    "0_0", `${tileWidth}_0`, `${tileWidth * 2}_0`,
    `0_${tileHeight}`, `${tileWidth}_${tileHeight}`, `${tileWidth * 2}_${tileHeight}`,
    `0_${tileHeight * 2}`, `${tileWidth}_${tileHeight * 2}`, `${tileWidth * 2}_${tileHeight * 2}`,
  ].join("|");
  filterLines.push(
    `${Array.from({ length: inputCount }, (_, i) => `[v${i}]`).join("")}` +
    `xstack=inputs=${inputCount}:layout=${layout}[out]`,
  );

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const filterPath = `${outPath}.filter.txt`;
  await fs.writeFile(filterPath, filterLines.join("\n"), "utf8");
  try {
    await runFfmpeg([
      ...args,
      "-filter_complex_script", filterPath,
      "-map", "[out]",
      "-frames:v", "1",
      "-q:v", String(jpegQuality),
      outPath,
    ]);
  } finally {
    await fs.rm(filterPath, { force: true });
  }

  const stat = await fs.stat(outPath).catch(() => undefined);
  if (stat === undefined || stat.size === 0) {
    throw new FrameGridError(`九宫格未生成：${outPath}`);
  }
  return {
    path: outPath,
    width: gridWidth,
    height: gridHeight,
    window_indexes: [...new Set(frames.map((frame) => frame.window_index))].sort((a, b) => a - b),
    cells,
  };
}

/**
 * 按窗口顺序 + 时间顺序排成一条帧流，每 9 帧拼一张。
 * 后一个窗口的帧会填进前一窗口留下的空位，只有最后一张允许不满 9 格。
 */
export async function composeGrids(
  frames: ExtractedFrame[],
  outDir: string,
  options: GridOptions = {},
): Promise<FrameGrid[]> {
  if (frames.length === 0) return [];
  const sorted = frames
    .slice()
    .sort((a, b) => a.window_index - b.window_index || a.t - b.t);
  await fs.mkdir(outDir, { recursive: true });
  const grids: FrameGrid[] = [];
  for (let chunk = 0; chunk * MAX_FRAMES_PER_GRID < sorted.length; chunk += 1) {
    const slice = sorted.slice(chunk * MAX_FRAMES_PER_GRID, (chunk + 1) * MAX_FRAMES_PER_GRID);
    const name = `grid_${String(chunk + 1).padStart(3, "0")}.jpg`;
    grids.push(await composeNineGrid(slice, path.join(outDir, name), options));
  }
  return grids;
}
