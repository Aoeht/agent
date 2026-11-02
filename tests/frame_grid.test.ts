import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeGrids, composeNineGrid, FrameGridError } from "../src/frame/grid";
import type { ExtractedFrame } from "../src/frame/types";

const ffmpegReady = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

function frame(index: number, windowIndex: number, imagePath: string): ExtractedFrame {
  return {
    path: imagePath,
    t: index * 2,
    window_index: windowIndex,
    reason: "interval",
    sha256: "0".repeat(64),
  };
}

function probeSize(filePath: string): { width: number; height: number } {
  const proc = Bun.spawnSync([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", filePath,
  ]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const [width, height] = proc.stdout.toString().trim().split(",").map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

const describeWithFfmpeg = ffmpegReady ? describe : describe.skip;

describeWithFfmpeg("九宫格拼图", () => {
  let workDir = "";
  let imagePath = "";

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-agent-frame-grid-"));
    imagePath = path.join(workDir, "tile.jpg");
    const proc = Bun.spawnSync([
      "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x336699:s=640x360:d=1",
      "-frames:v", "1", imagePath,
    ]);
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("五帧拼成固定 3×3、格位行优先、空格占位", async () => {
    const frames = Array.from({ length: 5 }, (_, index) => frame(index, 1, imagePath));
    const outPath = path.join(workDir, "grid_w1.jpg");
    const grid = await composeNineGrid(frames, outPath);

    expect(grid.width).toBe(1920);
    expect(grid.height).toBe(1080);
    expect(grid.cells).toHaveLength(5);
    expect(grid.cells.map((cell) => cell.index)).toEqual([1, 2, 3, 4, 5]);
    expect(probeSize(grid.path)).toEqual({ width: 1920, height: 1080 });
    const stat = await fs.stat(outPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  test("超过 9 帧拒绝拼单张", async () => {
    const frames = Array.from({ length: 10 }, (_, index) => frame(index, 1, imagePath));
    await expect(composeNineGrid(frames, path.join(workDir, "too-many.jpg"))).rejects.toThrow(FrameGridError);
  });

  test("没有帧时报错", async () => {
    await expect(composeNineGrid([], path.join(workDir, "empty.jpg"))).rejects.toThrow(FrameGridError);
  });

  test("按窗口生成多张九宫格", async () => {
    const frames = [
      ...Array.from({ length: 3 }, (_, index) => frame(index, 1, imagePath)),
      ...Array.from({ length: 2 }, (_, index) => frame(index, 2, imagePath)),
    ];
    const grids = await composeGrids(frames, path.join(workDir, "grids"));
    expect(grids).toHaveLength(2);
    expect(path.basename(grids[0]!.path)).toBe("grid_w1.jpg");
    expect(path.basename(grids[1]!.path)).toBe("grid_w2.jpg");
    expect(grids[0]!.cells).toHaveLength(3);
    expect(grids[1]!.cells).toHaveLength(2);
  });
});
