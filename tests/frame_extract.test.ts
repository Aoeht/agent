import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectSceneTimes, pickFrameTimes, probeDuration, sampleFrames } from "../src/frame/extract";
import type { FramePlan } from "../src/frame/types";

const ffmpegReady = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

function runFfmpeg(args: string[]): void {
  const proc = Bun.spawnSync(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`ffmpeg 失败：${proc.stderr.toString().split("\n").slice(-3).join("\n")}`);
  }
}

describe("时间点选择（纯函数）", () => {
  test("首尾必留，场景帧优先，0.5 秒内去重", () => {
    const times = pickFrameTimes(
      { start_s: 0, end_s: 10, reason: "test" },
      [2, 5],
      { intervalS: 2.5, maxFrames: 6 },
    );
    const values = times.map((item) => item.t);
    expect(values[0]).toBeCloseTo(0.05, 2);
    expect(values.at(-1)).toBeCloseTo(9.95, 2);
    expect(values.filter((t) => Math.abs(t - 2) < 0.01)).toHaveLength(1);
    expect(values.filter((t) => Math.abs(t - 5) < 0.01)).toHaveLength(1);
    expect(times.find((item) => Math.abs(item.t - 2) < 0.01)?.reason).toBe("scene");
  });

  test("限流时优先保留场景帧并始终包含首尾", () => {
    const times = pickFrameTimes(
      { start_s: 0, end_s: 10, reason: "test" },
      [2, 5],
      { intervalS: 2.5, maxFrames: 3 },
    );
    expect(times.map((item) => item.t)).toHaveLength(3);
    expect(times[0]!.reason).toBe("edge");
    expect(times.at(-1)!.reason).toBe("edge");
    expect(times.some((item) => item.reason === "scene")).toBe(true);
  });

  test("maxFrames=1 只留一帧", () => {
    const times = pickFrameTimes({ start_s: 0, end_s: 10, reason: "test" }, [2], { maxFrames: 1 });
    expect(times).toHaveLength(1);
  });

  test("名额有限时在整段窗口均匀铺开，不挤在前几秒", () => {
    const times = pickFrameTimes(
      { start_s: 0, end_s: 30, reason: "test" },
      [],
      { intervalS: 2.5, maxFrames: 5 },
    );
    const values = times.map((item) => item.t);
    expect(values).toHaveLength(5);
    expect(values[0]).toBeCloseTo(0.05, 2);
    expect(values.at(-1)).toBeCloseTo(29.95, 1);
    expect(values.some((t) => t > 20)).toBe(true);
  });
});

const describeWithFfmpeg = ffmpegReady ? describe : describe.skip;

describeWithFfmpeg("真实 ffmpeg 抽帧", () => {
  let workDir = "";
  let videoPath = "";

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-agent-frame-extract-"));
    videoPath = path.join(workDir, "sample.mp4");
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
      "-t", "12", "-pix_fmt", "yuv420p",
      videoPath,
    ]);
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("读取时长", async () => {
    expect(await probeDuration(videoPath)).toBeCloseTo(12, 1);
  });

  test("场景切换时间点带窗口偏移", async () => {
    const sceneVideo = path.join(workDir, "scenes.mp4");
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:d=2",
      "-f", "lavfi", "-i", "smptebars=size=320x180:rate=25:d=2",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-pix_fmt", "yuv420p",
      sceneVideo,
    ]);
    const full = await detectSceneTimes(sceneVideo, { start_s: 0, end_s: 4, reason: "test" }, 0.3);
    expect(full.some((t) => Math.abs(t - 2) < 0.2)).toBe(true);

    const offset = await detectSceneTimes(sceneVideo, { start_s: 1, end_s: 4, reason: "test" }, 0.3);
    // -ss 从 1s 开始后 pts_time 会重置，必须加回窗口起点
    expect(offset.some((t) => Math.abs(t - 2) < 0.2)).toBe(true);
  });

  test("按窗口抽帧并落盘、哈希稳定", async () => {
    const plan: FramePlan = {
      bvid: "BV1FRAMETEST",
      policy_version: "frames/v1",
      planner_version: "planner/v1",
      windows: [{ start_s: 1, end_s: 6, reason: "测试窗口" }],
    };
    const frames = await sampleFrames({
      videoPath,
      plan,
      outDir: path.join(workDir, "frames"),
      options: { intervalS: 2.5, maxFramesPerWindow: 6, sceneThreshold: 0.9, concurrency: 2 },
    });

    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.length).toBeLessThanOrEqual(6);
    const seen = new Set<number>();
    for (const frame of frames) {
      expect(frame.t).toBeGreaterThanOrEqual(1);
      expect(frame.t).toBeLessThanOrEqual(6);
      expect(frame.window_index).toBe(1);
      expect(frame.sha256).toMatch(/^[0-9a-f]{64}$/);
      const stat = await fs.stat(frame.path);
      expect(stat.size).toBeGreaterThan(0);
      const key = Math.round(frame.t * 2);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
