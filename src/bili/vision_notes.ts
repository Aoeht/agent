// src/bili/vision_notes.ts
/**
 * 视觉观察转写：把九宫格/评论图批量交给视觉模型，返回逐图文字观察。
 * 纯文本主模型（deepseek 等）只读这些文字，像素既不进主模型请求，也不会被带进后续轮。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MAX_USER_IMAGE_BYTES, MAX_REQUEST_IMAGE_BYTES } from "../core/user_images";
import type OpenAI from "openai";
import { createModelClient } from "../core/providers";
import { parseVisualObservations, VISUAL_INSTRUCTIONS } from "../core/visual_observations";
import { sniffImageMime } from "../utils/image_mime";

/** 视觉模型缺省值：与 RUNBOOK 口径一致，按图像输入能力与白名单选定 */
export const DEFAULT_VISION_MODEL = "qwen3.8-flash";
/** 与主模型图片通道同一批上限：一次请求最多 8 张 */
export const MAX_VISION_IMAGES = 8;

export interface VisionImage {
  /** 读像素用的绝对路径 */
  path: string;
  /** 来源标签（抽帧窗口/格位/评论出处）：只供模型照抄，不得自行推断 */
  label: string;
}

export interface TranscribeVisionOptions {
  model?: string;
  client?: OpenAI;
  signal?: AbortSignal;
  timeoutMs?: number;
  cacheDir?: string;
  onBatch?: (record: { role: "assistant"; content: string; model: string; cached: boolean }) => void | Promise<void>;
  onUsage?: (tokens: number) => void;
}

/** 批量转写；返回与输入同序的观察正文（画面要点/可辨认文字/风险要素/不确定项） */
export async function transcribeImages(
  images: readonly VisionImage[],
  options: TranscribeVisionOptions = {},
): Promise<string[]> {
  if (images.length === 0) return [];
  const model = options.model ?? DEFAULT_VISION_MODEL;
  const client = options.client ?? createModelClient({ maxRetries: 0, timeout: options.timeoutMs ?? 180_000 });
  const details: string[] = [];
  let batch: VisionImage[] = [];
  let encodedBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    details.push(...await transcribeBatch(batch, model, client, options));
    batch = [];
    encodedBytes = 0;
  };
  for (const image of images) {
    options.signal?.throwIfAborted();
    const stat = await fs.stat(image.path);
    if (!stat.isFile() || stat.size > MAX_USER_IMAGE_BYTES) throw new Error(`图片不是普通文件或超过单图上限：${image.path}`);
    const size = Math.ceil(stat.size / 3) * 4 + 64;
    if (batch.length >= MAX_VISION_IMAGES || encodedBytes + size > MAX_REQUEST_IMAGE_BYTES) await flush();
    batch.push(image);
    encodedBytes += size;
  }
  await flush();
  return details;
}

async function transcribeBatch(
  batch: readonly VisionImage[],
  model: string,
  client: OpenAI,
  options: TranscribeVisionOptions,
): Promise<string[]> {
  const content: Array<Record<string, unknown>> = [{
    type: "text",
    text: `本批共 ${batch.length} 张图片。来源映射（时间与格位只能照抄，不要推断）：\n` +
      batch.map((image, index) => `image_${index + 1} → ${image.label}`).join("\n"),
  }];
  const digest = createHash("sha256").update(JSON.stringify({ model, prompt: VISUAL_INSTRUCTIONS, labels: batch.map(i => i.label) }));
  let encodedBytes = 0;
  for (const [index, image] of batch.entries()) {
    options.signal?.throwIfAborted();
    const bytes = await fs.readFile(image.path);
    if (bytes.length > MAX_USER_IMAGE_BYTES) throw new Error(`图片超过单图上限：${image.path}`);
    digest.update(String(bytes.length) + ":").update(bytes);
    encodedBytes += Math.ceil(bytes.length / 3) * 4 + 64;
    if (encodedBytes > MAX_REQUEST_IMAGE_BYTES) throw new Error("图片批次超过请求字节上限");
    const mime = sniffImageMime(bytes);
    if (mime === undefined) throw new Error(`不是支持的图片格式：${image.path}`);
    content.push({ type: "text", text: `图片 image_${index + 1}（来源：${image.label}）：` });
    content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });
  }

  const cachePath = options.cacheDir ? path.join(options.cacheDir, `${digest.digest("hex")}.json`) : undefined;
  const publish = async (details: string[], cached: boolean) => {
    await options.onBatch?.({ role: "assistant", model, cached, content: renderVisionNotes(batch, details) });
    return details;
  };
  if (cachePath) {
    const cached = await fs.readFile(cachePath, "utf8").catch(() => undefined);
    let parsed: string[] | undefined;
    if (cached) {
      try { parsed = parseVisualObservations(cached, batch.length); } catch { /* Regenerate invalid records. */ }
    }
    if (parsed) return publish(parsed, true);
  }
  let correction = "";
  let failure: unknown;
  // 一次纠错重试：VL 偶尔把 JSON 包进解释文字或缺四项字段名，白跑整条的代价高于一次重试
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    options.signal?.throwIfAborted();
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: VISUAL_INSTRUCTIONS + correction },
        { role: "user", content: content as never },
      ],
      temperature: 0,
      max_tokens: 4000,
    }, { timeout: options.timeoutMs ?? 180_000, maxRetries: 0, ...(options.signal ? { signal: options.signal } : {}) });
    options.onUsage?.(response.usage?.total_tokens ?? 0);
    const choice = response.choices[0];
    if (choice?.finish_reason !== "stop" || choice.message?.refusal) {
      failure = new Error(`视觉模型未正常完成（finish=${choice?.finish_reason ?? "none"}）`);
      continue;
    }
    let parsed: string[];
    try {
      parsed = parseVisualObservations(choice.message.content ?? "", batch.length);
    } catch (error) {
      failure = error;
      correction = "\n上一次输出不合格。必须严格返回 JSON；observations 数量与图片数一致；每项 details 必须包含「画面要点」「可辨认文字」「风险要素」「不确定项」四个字段名。";
      continue;
    }
    if (cachePath) {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ observations: parsed.map((details, i) => ({ id: `image_${i + 1}`, details })) }), "utf8");
      await fs.rename(tmp, cachePath);
    }
    return publish(parsed, false);
  }
  throw failure instanceof Error ? failure : new Error(String(failure));
}

/** 把逐图观察渲染成任务描述里的文字块：来源标签保持原样，便于报告引用时间窗/格位 */
export function renderVisionNotes(images: readonly VisionImage[], details: readonly string[]): string {
  if (images.length !== details.length) throw new Error("视觉观察数量与来源不匹配");
  return images.map((image, index) => `- ${image.label}：${details[index]!.trim()}`).join("\n");
}
