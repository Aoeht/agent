import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodableDuration, dhash, hammingDistance, pickVideoStream, probeVideoMeta, probeVideoProfile } from "../src/frame/profile";
import { extractFrameAt, probeDuration } from "../src/frame/extract";

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

describe("时长口径纯函数", () => {
  const cover = { codec_type: "video", duration: "15.000000", disposition: { attached_pic: 1 } };
  const real = { codec_type: "video", duration: "12.000000", disposition: { attached_pic: 0 } };
  const audio = { codec_type: "audio", duration: "15.000000" };

  test("封面流排在前面也要跳过，取 ffmpeg 实际解码的那条", () => {
    expect(pickVideoStream([cover, real, audio])).toBe(real);
    expect(pickVideoStream([real, audio, cover])).toBe(real);
    expect(pickVideoStream([audio])).toBeUndefined();
    expect(pickVideoStream([])).toBeUndefined();
  });

  test("只有封面流时退回它，不返回 undefined", () => {
    expect(pickVideoStream([cover])).toBe(cover);
  });

  test("容器时长被音轨/封面撑长时，取视频流时长", () => {
    expect(decodableDuration(real, { duration: "15.000000" })).toBe(12);
  });

  test("流时长缺失（N/A）时回退容器时长", () => {
    expect(decodableDuration({ codec_type: "video", duration: "N/A" }, { duration: "15.0" })).toBe(15);
    expect(decodableDuration(undefined, { duration: "15.0" })).toBe(15);
    expect(decodableDuration({ codec_type: "video" }, { duration: "15.0" })).toBe(15);
  });

  test("两个时长都不可用时返回 NaN，由调用方抛错", () => {
    expect(Number.isNaN(decodableDuration(undefined, {}))).toBe(true);
    expect(Number.isNaN(decodableDuration({ duration: "0" }, { duration: "N/A" }))).toBe(true);
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

describeWithFfmpeg("容器时长 ≠ 视频流时长（B 站 mp4 形态）", () => {
  let workDir = "";
  let videoPath = "";

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-agent-frame-duration-"));
    videoPath = path.join(workDir, "cover.mp4");
    // 视频 12s、音轨 15s、外加一条 640x360 的 attached_pic 封面流：
    // 容器时长被撑到 15s，封面流时长也是 15s，只有真视频流是 12s。
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=15",
      "-f", "lavfi", "-i", "color=c=red:s=640x360:d=1",
      "-map", "0:v:0", "-map", "1:a:0", "-map", "2:v:0",
      "-c:v:0", "libx264", "-pix_fmt", "yuv420p",
      "-c:v:1", "png", "-disposition:v:1", "attached_pic",
      "-c:a", "aac", videoPath,
    ]);
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("probeVideoMeta 取视频流时长与真视频分辨率，不被封面/音轨带偏", async () => {
    const meta = await probeVideoMeta(videoPath);
    expect(meta.duration_s).toBeCloseTo(12, 1);
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(180);
    expect(meta.has_audio).toBe(true);
  });

  test("probeDuration 与 probeVideoMeta 同口径", async () => {
    const meta = await probeVideoMeta(videoPath);
    expect(await probeDuration(videoPath)).toBeCloseTo(meta.duration_s, 6);
  });

  test("按视频流时长排末帧能抽出来，按容器时长排会 EOF", async () => {
    const dur = await probeDuration(videoPath);
    // 30s 分段规则下这片只有 1 段，末帧 = 8.5/9 × 时长
    const lastT = (8.5 / 9) * dur;
    const okPath = path.join(workDir, "ok.jpg");
    await extractFrameAt(videoPath, lastT, okPath);
    expect((await fs.stat(okPath)).size).toBeGreaterThan(0);

    // 容器时长 15s 会把末帧排到 14.17s，越过 12s 的真实流末尾
    const beyondT = (8.5 / 9) * 15;
    const badPath = path.join(workDir, "bad.jpg");
    await expect(extractFrameAt(videoPath, beyondT, badPath)).rejects.toThrow();
  });
});
