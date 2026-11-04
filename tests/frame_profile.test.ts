import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dhash, hammingDistance, probeVideoMeta, probeVideoProfile } from "../src/frame/profile";

const ffmpegReady = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

function runFfmpeg(args: string[]): void {
  const proc = Bun.spawnSync(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`ffmpeg 失败：${proc.stderr.toString().split("\n").slice(-3).join("\n")}`);
  }
}

describe("dHash 纯函数", () => {
  test("同图同哈希，不同图距离大", () => {
    const dark = new Uint8Array(64 * 36).fill(20);
    const bright = new Uint8Array(64 * 36).fill(220);
    expect(dhash(dark)).toBe(dhash(dark));
    expect(hammingDistance(dhash(dark), dhash(bright))).toBe(0);
    const gradient = new Uint8Array(64 * 36);
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 64; x += 1) gradient[y * 64 + x] = Math.round(((63 - x) / 63) * 255);
    }
    expect(hammingDistance(dhash(gradient), dhash(dark))).toBeGreaterThan(0);
    expect(hammingDistance(dhash(gradient), dhash(gradient))).toBe(0);
  });
});

const describeWithFfmpeg = ffmpegReady ? describe : describe.skip;

describeWithFfmpeg("视频画像预扫描", () => {
  let workDir = "";

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-agent-frame-profile-"));
    // 静态画面 + 音轨
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x336699:s=320x180:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
      "-t", "10", "-pix_fmt", "yuv420p", "-shortest",
      path.join(workDir, "static.mp4"),
    ]);
    // 三页幻灯片，每页 3 秒；颜色必须灰度差异明显，否则 1fps 探针看不到切页
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=white:s=320x180:rate=10:d=3",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:rate=10:d=3",
      "-f", "lavfi", "-i", "color=c=red:s=320x180:rate=10:d=3",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-pix_fmt", "yuv420p",
      path.join(workDir, "slides.mp4"),
    ]);
    // 每 1 秒换一种测试图案：结构完全不同，避免 dHash 把它们当重复画面。
    // 只旋转色相（hue）时灰度几乎不变，1fps 探针看不到切页，不能用来测快切。
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:d=1",
      "-f", "lavfi", "-i", "smptebars=size=320x180:rate=10:d=1",
      "-f", "lavfi", "-i", "rgbtestsrc=size=320x180:rate=10:d=1",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:d=1",
      "-f", "lavfi", "-i", "smptehdbars=size=320x180:rate=10:d=1",
      "-f", "lavfi", "-i", "yuvtestsrc=size=320x180:rate=10:d=1",
      "-filter_complex", "[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0[v]",
      "-map", "[v]", "-pix_fmt", "yuv420p",
      path.join(workDir, "cuts.mp4"),
    ]);
    // 竖屏
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=180x320:rate=10",
      "-t", "8", "-pix_fmt", "yuv420p",
      path.join(workDir, "portrait.mp4"),
    ]);
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("元信息：时长、分辨率、音轨", async () => {
    const meta = await probeVideoMeta(path.join(workDir, "static.mp4"));
    expect(meta.duration_s).toBeCloseTo(10, 1);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(180);
    expect(meta.has_audio).toBe(true);
    expect(meta.fps).toBeCloseTo(10, 1);
  });

  test("静态视频识别为 static，探针点覆盖全片", async () => {
    const profile = await probeVideoProfile(path.join(workDir, "static.mp4"));
    expect(profile.kind).toBe("static");
    expect(profile.orientation).toBe("landscape");
    expect(profile.summary.static_ratio).toBeGreaterThan(0.9);
    expect(profile.summary.cut_count).toBe(0);
    expect(profile.summary.sample_count).toBeGreaterThanOrEqual(9);
  });

  test("幻灯片识别为 slideshow，切页点接近 3s/6s", async () => {
    const profile = await probeVideoProfile(path.join(workDir, "slides.mp4"));
    expect(profile.kind).toBe("slideshow");
    const cuts = profile.samples.filter((sample) => sample.change >= 0.25).map((sample) => sample.t);
    expect(cuts.some((t) => Math.abs(t - 3) <= 1)).toBe(true);
    expect(cuts.some((t) => Math.abs(t - 6) <= 1)).toBe(true);
  });

  test("快速换色识别为 fast_cut", async () => {
    const profile = await probeVideoProfile(path.join(workDir, "cuts.mp4"));
    expect(profile.kind).toBe("fast_cut");
    expect(profile.summary.big_change_ratio).toBeGreaterThan(0.5);
  });

  test("竖屏按显示方向判定", async () => {
    const profile = await probeVideoProfile(path.join(workDir, "portrait.mp4"));
    expect(profile.orientation).toBe("portrait");
    expect(profile.meta.width).toBe(180);
    expect(profile.meta.height).toBe(320);
  });
});
