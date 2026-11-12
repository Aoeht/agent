// src/frame/profile.ts
/**
 * 视频画像预扫描：一次低分辨率解码，得到"画面何时变了"的时间线，
 * 供窗口取样按视觉状态取帧，而不是只看硬切数量决定是否退化成 1fps。
 *
 * 探针输出统一为 64×36 灰度 rawvideo（不落盘），逐秒计算：
 * - change：整帧变化像素占比（判断硬切/页面切换）
 * - mean_delta：整帧平均亮度差（判断缓慢缩放/滚动）
 * - text_change：底部文字带变化占比（硬字幕、聊天记录）
 * - luminance / edge：黑屏与文字密度
 * - dHash：跨窗口感知去重
 *
 * 分类只决定取样策略，不参与风险定性；探针失败时调用方退回保守取样。
 */
import { spawn } from "node:child_process";

export type VideoKind =
  | "static"
  | "slideshow"
  | "screen_recording"
  | "fast_cut"
  | "live"
  | "repetitive"
  | "mixed";

export interface VideoMetaProbe {
  duration_s: number;
  width: number;
  height: number;
  /** 显示方向上的旋转（0/90/180/270） */
  rotation: number;
  has_audio: boolean;
  fps: number | null;
  bit_depth: number | null;
  hdr: boolean;
}

export interface VisualSample {
  /** 采样时刻（秒） */
  t: number;
  /** 与上一采样帧的整帧变化像素占比 0~1 */
  change: number;
  /** 与上一采样帧的平均亮度差 0~1 */
  mean_delta: number;
  /** 底部 25% 文字带的变化像素占比 0~1 */
  text_change: number;
  /** 平均亮度 0~1 */
  luminance: number;
  /** 边缘密度 0~1，文字/表格类画面偏高 */
  edge: number;
  /** 64 位 dHash，16 位十六进制 */
  hash: string;
}

export interface VideoProfileSummary {
  kind: VideoKind;
  orientation: "landscape" | "portrait" | "square";
  text_heavy: boolean;
  repetitive: boolean;
  sample_count: number;
  static_ratio: number;
  big_change_ratio: number;
  text_active_ratio: number;
  avg_edge: number;
  cut_count: number;
  duplicate_ratio: number;
}

export interface VideoProfile {
  meta: VideoMetaProbe;
  orientation: "landscape" | "portrait" | "square";
  kind: VideoKind;
  text_heavy: boolean;
  repetitive: boolean;
  /** 探针步长（秒） */
  step_s: number;
  samples: VisualSample[];
  summary: VideoProfileSummary;
  notes: string[];
}

export interface VisualProbeOptions {
  /** 探针采样频率，默认 1fps */
  fps?: number;
  width?: number;
  height?: number;
}

const PROBE_WIDTH = 64;
const PROBE_HEIGHT = 36;
const FRAME_BYTES = PROBE_WIDTH * PROBE_HEIGHT;
/** 变化像素判定阈值（灰度差） */
const PIXEL_DELTA = 16;
/** 边缘梯度阈值 */
const EDGE_DELTA = 40;
/** 底部文字带起始行（75%） */
const TEXT_BAND_ROW = Math.floor(PROBE_HEIGHT * 0.75);

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export class VideoProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoProfileError";
  }
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new VideoProfileError(`无法执行 ${command}：${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(new VideoProfileError(`${command} 退出码 ${code}${tail ? `：${tail}` : ""}`));
      }
    });
  });
}

function parseFps(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  const num = Number.parseFloat(parts[0] ?? "");
  const den = parts[1] === undefined ? undefined : Number.parseFloat(parts[1]);
  if (!Number.isFinite(num)) return null;
  if (den === undefined || !Number.isFinite(den) || den === 0) return num || null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function parseRotation(stream: Record<string, unknown>): number {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  for (const item of sideData) {
    if (typeof item !== "object" || item === null) continue;
    const rotation = (item as Record<string, unknown>).rotation;
    if (typeof rotation === "number" && Number.isFinite(rotation)) {
      return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
    }
  }
  const tags = stream.tags;
  if (typeof tags === "object" && tags !== null) {
    const rotate = Number.parseInt(String((tags as Record<string, unknown>).rotate ?? ""), 10);
    if (Number.isFinite(rotate)) return ((rotate % 360) + 360) % 360;
  }
  return 0;
}

/** 挑 ffmpeg 实际会解码的那条视频流：跳过 attached_pic 封面（B 站 mp4 普遍带一条 mjpeg 封面流） */
export function pickVideoStream(streams: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const videos = streams.filter((stream) => stream.codec_type === "video");
  return videos.find((stream) => !(stream.disposition as Record<string, unknown> | undefined)?.attached_pic) ?? videos[0];
}

/**
 * 可解码时长：优先视频流时长，容器时长只作回退（部分容器不报流时长）。
 * 容器时长会被封面/数据流撑长（B 站语料实测中位 +0.017s、最大 +2.915s），
 * 按它排末帧会越过末帧 PTS，ffmpeg 取不到帧，mjpeg 报 "Could not open encoder before EOF"。
 */
export function decodableDuration(
  video: Record<string, unknown> | undefined,
  format: Record<string, unknown>,
): number {
  const fromStream = Number.parseFloat(String(video?.duration ?? ""));
  if (Number.isFinite(fromStream) && fromStream > 0) return fromStream;
  return Number.parseFloat(String(format.duration ?? ""));
}

/** ffprobe 元信息：时长、显示分辨率、旋转、音轨、fps、位深、HDR */
export async function probeVideoMeta(videoPath: string): Promise<VideoMetaProbe> {
  let parsed: Record<string, unknown>;
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_streams",
      "-show_format",
      "-of", "json",
      videoPath,
    ]);
    parsed = JSON.parse(stdout.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof VideoProfileError) throw error;
    throw new VideoProfileError(`ffprobe 输出无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams as Array<Record<string, unknown>> : [];
  const video = pickVideoStream(streams);
  if (!video) throw new VideoProfileError(`没有视频流：${videoPath}`);
  const format = (parsed.format ?? {}) as Record<string, unknown>;
  const duration = decodableDuration(video, format);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoProfileError(`无法读取视频时长：${videoPath}`);
  }
  const rawWidth = Number(video.width ?? 0);
  const rawHeight = Number(video.height ?? 0);
  const rotation = parseRotation(video);
  const swap = rotation % 180 === 90;
  const width = swap ? rawHeight : rawWidth;
  const height = swap ? rawWidth : rawHeight;
  const colorTransfer = String(video.color_transfer ?? "");
  return {
    duration_s: duration,
    width,
    height,
    rotation,
    has_audio: streams.some((stream) => stream.codec_type === "audio"),
    fps: parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate),
    bit_depth: Number.isFinite(Number(video.bit_depth)) ? Number(video.bit_depth) : null,
    hdr: colorTransfer === "smpte2084" || colorTransfer === "arib-std-b67",
  };
}

function orientationOf(meta: VideoMetaProbe): "landscape" | "portrait" | "square" {
  if (meta.width > meta.height) return "landscape";
  if (meta.width < meta.height) return "portrait";
  return "square";
}

/** 64 位 dHash：9×8 采样后比较水平相邻像素 */
export function dhash(frame: Uint8Array, width = PROBE_WIDTH, height = PROBE_HEIGHT): string {
  const gridWidth = 9;
  const gridHeight = 8;
  const values: number[] = [];
  for (let row = 0; row < gridHeight; row += 1) {
    const y = Math.min(height - 1, Math.floor((row + 0.5) * height / gridHeight));
    for (let col = 0; col < gridWidth; col += 1) {
      const x = Math.min(width - 1, Math.floor((col + 0.5) * width / gridWidth));
      values.push(frame[y * width + x] ?? 0);
    }
  }
  let bits = 0n;
  let bitIndex = 0;
  for (let row = 0; row < gridHeight; row += 1) {
    for (let col = 0; col < gridWidth - 1; col += 1) {
      const left = values[row * gridWidth + col]!;
      const right = values[row * gridWidth + col + 1]!;
      if (left > right) bits |= 1n << BigInt(bitIndex);
      bitIndex += 1;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

function analyzeFrame(
  frame: Uint8Array,
  previous: Uint8Array | undefined,
  t: number,
): VisualSample {
  let lumaSum = 0;
  let edgeCount = 0;
  for (let y = 0; y < PROBE_HEIGHT; y += 1) {
    for (let x = 0; x < PROBE_WIDTH; x += 1) {
      const index = y * PROBE_WIDTH + x;
      const value = frame[index] ?? 0;
      lumaSum += value;
      const right = x + 1 < PROBE_WIDTH ? frame[index + 1] ?? value : value;
      const down = y + 1 < PROBE_HEIGHT ? frame[index + PROBE_WIDTH] ?? value : value;
      if (Math.abs(value - right) + Math.abs(value - down) > EDGE_DELTA) edgeCount += 1;
    }
  }
  let change = 0;
  let meanDelta = 0;
  let textChange = 0;
  if (previous !== undefined) {
    let changedPixels = 0;
    let deltaSum = 0;
    let textTotal = 0;
    let textChanged = 0;
    for (let y = 0; y < PROBE_HEIGHT; y += 1) {
      for (let x = 0; x < PROBE_WIDTH; x += 1) {
        const index = y * PROBE_WIDTH + x;
        const delta = Math.abs((frame[index] ?? 0) - (previous[index] ?? 0));
        deltaSum += delta;
        if (delta > PIXEL_DELTA) changedPixels += 1;
        if (y >= TEXT_BAND_ROW) {
          textTotal += 1;
          if (delta > PIXEL_DELTA) textChanged += 1;
        }
      }
    }
    change = changedPixels / FRAME_BYTES;
    meanDelta = deltaSum / (FRAME_BYTES * 255);
    textChange = textTotal > 0 ? textChanged / textTotal : 0;
  }
  return {
    t,
    change,
    mean_delta: meanDelta,
    text_change: textChange,
    luminance: lumaSum / (FRAME_BYTES * 255),
    edge: edgeCount / FRAME_BYTES,
    hash: dhash(frame),
  };
}

/** 一次 1fps 低分辨率解码，返回逐秒视觉状态时间线 */
export async function probeVisualTimeline(
  videoPath: string,
  options: VisualProbeOptions = {},
): Promise<{ samples: VisualSample[]; step_s: number }> {
  const fps = options.fps ?? 1;
  const width = options.width ?? PROBE_WIDTH;
  const height = options.height ?? PROBE_HEIGHT;
  if (!(fps > 0)) throw new VideoProfileError(`探针 fps 必须为正数：${fps}`);
  const frameBytes = width * height;
  const { stdout } = await run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    "-i", videoPath,
    "-an", "-sn",
    "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=gray`,
    "-f", "rawvideo",
    "-",
  ]);
  const count = Math.floor(stdout.length / frameBytes);
  const samples: VisualSample[] = [];
  let previous: Uint8Array | undefined;
  for (let i = 0; i < count; i += 1) {
    const frame = new Uint8Array(stdout.buffer, stdout.byteOffset + i * frameBytes, frameBytes);
    const sample = analyzeFrame(frame, previous, i / fps);
    samples.push(sample);
    previous = frame;
  }
  return { samples, step_s: 1 / fps };
}

interface ClassifyInput {
  samples: VisualSample[];
  meta: VideoMetaProbe;
  stepS: number;
}

/** 分类阈值集中在 classifyProfile，调策略时先看这里的注释与单测 */
export function classifyProfile({ samples, meta, stepS }: ClassifyInput): {
  kind: VideoKind;
  text_heavy: boolean;
  repetitive: boolean;
  summary: VideoProfileSummary;
} {
  const n = Math.max(1, samples.length);
  const staticRatio = samples.filter((s) => s.change < 0.01).length / n;
  const bigChangeRatio = samples.filter((s) => s.change >= 0.25).length / n;
  const textActiveRatio = samples.filter((s) => s.text_change >= 0.02).length / n;
  const avgEdge = samples.reduce((sum, s) => sum + s.edge, 0) / n;
  const avgChange = samples.reduce((sum, s) => sum + s.change, 0) / n;
  const cutCount = samples.filter((s) => s.change >= 0.25).length;
  const cutRatePerMinute = meta.duration_s > 0 ? cutCount / (meta.duration_s / 60) : 0;

  // 与更早的采样比较 dHash，重复画面（循环/模板）占比
  let duplicate = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const sample = samples[i]!;
    for (let j = Math.max(0, i - 30); j < i; j += 1) {
      if (hammingDistance(sample.hash, samples[j]!.hash) <= 6) {
        duplicate += 1;
        break;
      }
    }
  }
  const duplicateRatio = samples.length > 1 ? duplicate / (samples.length - 1) : 0;

  // 两页幻灯片在 10 个采样点里正好 2 次切换（bigChangeRatio = 0.2），
  // 这仍是"静态为主 + 少量切页"，不能因为边界值就判成快切。
  const makesCuts = cutCount >= 1 && bigChangeRatio < 0.3;
  let kind: VideoKind;
  if (meta.duration_s >= 1800 && staticRatio >= 0.5 && cutRatePerMinute < 2) {
    kind = "live";
  } else if (bigChangeRatio >= 0.3 || cutRatePerMinute >= 15) {
    kind = "fast_cut";
  } else if (staticRatio >= 0.4 && makesCuts) {
    // 幻灯片可能只有纯色/同构图，dHash 会把它们当成重复，必须先于 repetitive 判定
    kind = "slideshow";
  } else if (duplicateRatio >= 0.6 && avgChange > 0.01) {
    kind = "repetitive";
  } else if (staticRatio >= 0.85) {
    kind = "static";
  } else if (avgChange >= 0.02) {
    kind = "screen_recording";
  } else {
    kind = "mixed";
  }

  const textHeavy = avgEdge >= 0.18 || textActiveRatio >= 0.3;
  const repetitive = kind === "repetitive" || duplicateRatio >= 0.6;
  return {
    kind,
    text_heavy: textHeavy,
    repetitive,
    summary: {
      kind,
      orientation: orientationOf(meta),
      text_heavy: textHeavy,
      repetitive,
      sample_count: samples.length,
      static_ratio: staticRatio,
      big_change_ratio: bigChangeRatio,
      text_active_ratio: textActiveRatio,
      avg_edge: avgEdge,
      cut_count: cutCount,
      duplicate_ratio: duplicateRatio,
    },
  };
}

/** 完整预扫描：元信息 + 视觉时间线 + 分类；探针失败时抛错，由调用方降级 */
export async function probeVideoProfile(
  videoPath: string,
  options: VisualProbeOptions = {},
): Promise<VideoProfile> {
  const meta = await probeVideoMeta(videoPath);
  const { samples, step_s } = await probeVisualTimeline(videoPath, options);
  const classified = classifyProfile({ samples, meta, stepS: step_s });
  const notes: string[] = [];
  if (samples.length === 0) notes.push("视觉探针没有解出任何帧，取样将退回保守策略");
  if (meta.rotation !== 0) notes.push(`视频旋转 ${meta.rotation}°，已按显示方向处理`);
  if (meta.hdr) notes.push("HDR 视频，抽帧色彩可能偏灰");
  return {
    meta,
    orientation: classified.summary.orientation,
    kind: classified.kind,
    text_heavy: classified.text_heavy,
    repetitive: classified.repetitive,
    step_s,
    samples,
    summary: classified.summary,
    notes,
  };
}
