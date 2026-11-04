import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectSceneTimes, probeDuration, sampleFrames } from "../src/frame/extract";
import { frameBudgetFor } from "../src/frame/policy";
import type { FramePlan } from "../src/frame/types";

const ffmpegReady = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

function runFfmpeg(args: string[]): void {
  const proc = Bun.spawnSync(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`ffmpeg 失败：${proc.stderr.toString().split("\n").slice(-3).join("\n")}`);
  }
}

function plan(windows: FramePlan["windows"]): FramePlan {
  return {
    bvid: "BV1FRAMETEST",
    policy_version: "frames/v3",
    planner_version: "planner/v2",
    windows,
  };
}

const describeWithFfmpeg = ffmpegReady ? describe : describe.skip;

describeWithFfmpeg("真实 ffmpeg 抽帧", () => {
  let workDir = "";
  let videoPath = "";
  let staticPath = "";

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-agent-frame-extract-"));
    videoPath = path.join(workDir, "sample.mp4");
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
      "-t", "12", "-pix_fmt", "yuv420p",
      videoPath,
    ]);
    staticPath = path.join(workDir, "static.mp4");
    runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=0x336699:s=320x180:rate=10",
      "-t", "10", "-pix_fmt", "yuv420p",
      staticPath,
    ]);
  });

  afterAll(async () => {
    // Windows 上 ffmpeg 抽帧失败后可能仍短暂占用输出目录
    await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    const full = await detectSceneTimes(sceneVideo, { start_s: 0, end_s: 4, reason: "test" }, 0.35);
    expect(full.some((t) => Math.abs(t - 2) < 0.2)).toBe(true);

    const offset = await detectSceneTimes(sceneVideo, { start_s: 1, end_s: 4, reason: "test" }, 0.35);
    // -ss 从 1s 开始后 pts_time 会重置，必须加回窗口起点
    expect(offset.some((t) => Math.abs(t - 2) < 0.2)).toBe(true);
  });

  test("按窗口抽帧并落盘、哈希稳定且不超过预算", async () => {
    const budget = frameBudgetFor("medium");
    const result = await sampleFrames({
      videoPath,
      plan: plan([{ start_s: 1, end_s: 6, reason: "测试窗口", source: "plan" }]),
      outDir: path.join(workDir, "frames"),
      durationS: 12,
      budget,
      options: { sceneThreshold: 0.9, concurrency: 2, selection: { coverageMinGapS: 180 } },
    });

    expect(result.frames.length).toBeGreaterThanOrEqual(2);
    expect(result.frames.length).toBeLessThanOrEqual(budget.max_frames);
    expect(result.truncated).toBe(false);
    const seen = new Set<number>();
    for (const frame of result.frames) {
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

  test("命中可疑弹幕的窗口按 focus 时间点补帧", async () => {
    const result = await sampleFrames({
      videoPath,
      plan: plan([{ start_s: 1, end_s: 6, reason: "口播", focus_times: [3.4], source: "plan" }]),
      outDir: path.join(workDir, "frames-focus"),
      durationS: 12,
      budget: frameBudgetFor("medium"),
      options: { sceneThreshold: 0.9, concurrency: 2 },
    });
    const focus = result.frames.find((frame) => Math.abs(frame.t - 3.4) < 0.01);
    expect(focus?.reason).toBe("focus");
  });

  test("静态画面不再退化为 1fps，单窗只留少量帧", async () => {
    const budget = frameBudgetFor("clean");
    const result = await sampleFrames({
      videoPath: staticPath,
      plan: plan([{ start_s: 0, end_s: 10, reason: "静态口播", source: "plan" }]),
      outDir: path.join(workDir, "frames-static"),
      durationS: 10,
      budget,
      options: { sceneThreshold: 0.35, concurrency: 2 },
    });
    expect(result.frames.length).toBeLessThanOrEqual(budget.per_window_max);
    expect(result.frames.length).toBeLessThan(10);
  });

  test("长视频未覆盖空档自动补覆盖窗口", async () => {
    const budget = frameBudgetFor("low");
    const result = await sampleFrames({
      videoPath,
      plan: plan([{ start_s: 0, end_s: 2, reason: "开头命中", source: "plan" }]),
      outDir: path.join(workDir, "frames-coverage"),
      durationS: 12,
      budget,
      options: {
        sceneThreshold: 0.9,
        detectScenes: false,
        // 12s 冒烟片把空档阈值调小，验证覆盖窗口机制本身
        selection: { coverageMinGapS: 4, coverageWindowS: 3 },
      },
    });
    const coverage = result.windows.filter((window) => window.source === "coverage");
    expect(coverage.length).toBeGreaterThan(0);
    expect(result.frames.length).toBeLessThanOrEqual(budget.max_frames);
  });

  test("CLI 接受模型空计划并生成全片覆盖 manifest", async () => {
    const snapshotPath = path.join(workDir, "snapshot.json");
    const planPath = path.join(workDir, "empty-plan.json");
    const outDir = path.join(workDir, "empty-plan-output");
    await fs.writeFile(snapshotPath, JSON.stringify({
      schema: "bili-snapshot/v1", bvid: "BV1FRAMETEST", fetched_at: "2026-11-04T00:00:00Z",
      video: { title: "空计划", duration_s: 12, tags: [] }, danmaku: [], comments: [],
    }));
    await fs.writeFile(planPath, JSON.stringify({ windows: [] }));
    const proc = Bun.spawn([process.execPath, "run", "src/frame/cli.ts",
      "--bvid", "BV1FRAMETEST", "--snapshot", snapshotPath, "--video", videoPath,
      "--plan", planPath, "--out", outDir, "--author-level", "clean", "--no-scenes",
    ], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    expect({ code, error: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, error: "" });
    const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8"));
    expect(manifest.policy_version).toBe("frames/v5");
    expect(manifest.windows).toHaveLength(4);
    expect(manifest.frames).toHaveLength(4);
    expect(manifest.grids).toHaveLength(1);
    expect(manifest.frames.at(-1).t).toBeGreaterThan(9);
  });

  test("CLI 外部 ASR 参与选窗，历史作者结论上调预算并保留证据", async () => {
    const snapshotPath = path.join(workDir, "history-snapshot.json");
    const transcriptPath = path.join(workDir, "asr.json");
    const findingsPath = path.join(workDir, "findings.jsonl");
    const outDir = path.join(workDir, "history-output");
    await fs.writeFile(snapshotPath, JSON.stringify({
      bvid: "BV1FRAMETEST", fetched_at: "2026-11-04T00:00:00Z",
      video: { duration_s: 12, owner_mid: 123 },
      author: { mid: "123", fans: 1000000, official_type: 2 },
    }));
    await fs.writeFile(transcriptPath, JSON.stringify({
      bvid: "BV1FRAMETEST", source: "asr", page: 1,
      segments: [{ start_s: 2, end_s: 4, text: "加微信领资料" }],
    }));
    await fs.writeFile(findingsPath, JSON.stringify({
      id: "historical-author", recorded_at: "2026-01-01T00:00:00Z", source: "scan_video",
      subject: "BV1AbCdEfGh2", dedupe_key: "BV1AbCdEfGh2:author", evidence: "历史签名原文",
      author_risk: { owner_mid: 123, risk_level: "high" },
    }) + "\n");
    const proc = Bun.spawn([process.execPath, "run", "src/frame/cli.ts",
      "--bvid", "BV1FRAMETEST", "--snapshot", snapshotPath, "--video", videoPath,
      "--transcript", transcriptPath, "--findings", findingsPath,
      "--out", outDir, "--heuristic", "--no-scenes", "--no-profile",
    ], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    expect({ code, error: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, error: "" });
    const manifest = JSON.parse(await fs.readFile(path.join(outDir, "manifest.json"), "utf8"));
    expect(manifest.policy.author_level).toBe("high");
    expect(manifest.policy.max_grids).toBe(20);
    expect(manifest.policy.author_score).toBeLessThan(30);
    expect(manifest.inputs.transcript_source).toBe("asr");
    expect(manifest.inputs.transcript_segments).toBe(1);
    expect(manifest.windows[0].focus_times).toContain(3);
    expect(manifest.frames.some((frame: { t: number; reason: string }) => frame.t === 3 && frame.reason === "focus")).toBe(true);
    expect(manifest.inputs.author_history.records[0].id).toBe("historical-author");
    expect(manifest.windows.some((window: { reason: string }) => window.reason.includes("得分 2"))).toBe(true);
  });
});
