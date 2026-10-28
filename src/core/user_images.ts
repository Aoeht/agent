// 用户上传图片的校验与读取：Web 入口、CLI /image 与 Agent 附件共用同一套口径。
// 像素只在内存里随本轮请求走一遍：不落会话文件、不进事件与 trace。
import fs from "node:fs/promises";
import path from "node:path";
import { sniffImageMime } from "../utils/image_mime";

/** 单次请求的图片张数上限（工具图片与用户图片共享同一份预算） */
export const MAX_IMAGES_PER_REQUEST = 8;
/** 按 data URL 编码后的字节计量，包含 base64 膨胀，不是原文件大小 */
export const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
/** 单张原图上限：7 MiB 编码后约 9.3 MiB */
export const MAX_USER_IMAGE_BYTES = 7 * 1024 * 1024;

const SUPPORTED_LABEL = "PNG、JPEG、WebP、GIF";
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

export interface UserImageUpload {
  /** 展示用文件名；缺省按序号命名 */
  name?: string;
  /** 与 dataUrl 内的 MIME 一致；缺省以 dataUrl 为准 */
  mimeType?: string;
  dataUrl: string;
}

export interface PreparedUserImage {
  name: string;
  mimeType: string;
  dataUrl: string;
  /** 原图字节数（base64 解码后） */
  sizeBytes: number;
  /** data URL 编码后的字节数（请求级配额按这个算） */
  encodedBytes: number;
}

/** 用户输入层面的拒绝（格式/大小/张数）：入口据此回 400，而不是当成服务端故障 */
export class UserImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserImageError";
  }
}

export interface UserImageLimits {
  maxCount?: number;
  maxTotalEncodedBytes?: number;
  maxBytesPerImage?: number;
}

export function formatImageSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** base64 解码后的原图字节数；格式不合法返回 undefined */
export function base64Size(data: string): number | undefined {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const body = data.slice(0, data.length - padding);
  if (!body || /[^A-Za-z0-9+/]/.test(body) || body.length % 4 === 1) return undefined;
  if (padding > 0 && data.length % 4 !== 0) return undefined;
  return Math.floor((body.length * 3) / 4);
}

function sanitizeName(raw: string | undefined, index: number): string {
  const cleaned = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  if (cleaned === "") return `图片 ${index + 1}`;
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
}

/**
 * 校验并归一化待上传图片；任何一项不合格都整体拒绝（不做静默降级）。
 * 输入来自 HTTP 请求体或 CLI，因此按 unknown 处理。
 */
export function prepareUserImages(input: unknown, limits: UserImageLimits = {}): PreparedUserImage[] {
  const maxCount = limits.maxCount ?? MAX_IMAGES_PER_REQUEST;
  const maxTotal = limits.maxTotalEncodedBytes ?? MAX_REQUEST_IMAGE_BYTES;
  const maxPerImage = limits.maxBytesPerImage ?? MAX_USER_IMAGE_BYTES;
  if (!Array.isArray(input)) throw new UserImageError("images 必须是数组");
  if (input.length === 0) return [];
  if (input.length > maxCount) {
    throw new UserImageError(`一次最多上传 ${maxCount} 张图片（本次 ${input.length} 张）`);
  }

  const images: PreparedUserImage[] = [];
  let total = 0;
  for (const [index, raw] of input.entries()) {
    const label = `第 ${index + 1} 张图片`;
    if (typeof raw !== "object" || raw === null) throw new UserImageError(`${label}格式不正确`);
    const item = raw as Record<string, unknown>;
    if (typeof item.dataUrl !== "string") throw new UserImageError(`${label}缺少 dataUrl`);
    const dataUrl = item.dataUrl.trim();
    const parsed = DATA_URL_PATTERN.exec(dataUrl);
    if (parsed === null) {
      throw new UserImageError(`${label}不是受支持的图片 data URL（仅支持 ${SUPPORTED_LABEL} 的 base64）`);
    }
    const mimeType = parsed[1]!;
    const base64 = parsed[2]!;
    const declaredMime = typeof item.mimeType === "string" ? item.mimeType.trim().toLowerCase() : "";
    if (declaredMime !== "" && declaredMime !== mimeType) {
      throw new UserImageError(`${label}的 MIME 类型与 data URL 不一致（${declaredMime} ≠ ${mimeType}）`);
    }
    const sizeBytes = base64Size(base64);
    if (sizeBytes === undefined) throw new UserImageError(`${label}的 base64 数据无效`);
    if (sizeBytes > maxPerImage) {
      throw new UserImageError(`${label}过大（${formatImageSize(sizeBytes)}），单张上限 ${formatImageSize(maxPerImage)}`);
    }
    const encodedBytes = Buffer.byteLength(dataUrl, "utf8");
    total += encodedBytes;
    if (total > maxTotal) {
      throw new UserImageError(`图片总量超过上限（${formatImageSize(maxTotal)}），请减少数量或压缩后再传`);
    }
    images.push({
      name: sanitizeName(typeof item.name === "string" ? item.name : undefined, index),
      mimeType,
      dataUrl,
      sizeBytes,
      encodedBytes,
    });
  }
  return images;
}

/** CLI /image：读取本地文件（允许工作区外），按文件头判定格式后转成 data URL */
export async function readLocalImageFiles(paths: readonly string[]): Promise<UserImageUpload[]> {
  const uploads: UserImageUpload[] = [];
  for (const target of paths) {
    const abs = path.resolve(target);
    const stat = await fs.stat(abs).catch(() => undefined);
    if (stat === undefined) throw new UserImageError(`图片不存在：${target}`);
    if (!stat.isFile()) throw new UserImageError(`不是文件：${target}`);
    if (stat.size > MAX_USER_IMAGE_BYTES) {
      throw new UserImageError(
        `图片过大：${target}（${formatImageSize(stat.size)}），单张上限 ${formatImageSize(MAX_USER_IMAGE_BYTES)}`
      );
    }
    const bytes = await fs.readFile(abs);
    const mimeType = sniffImageMime(bytes);
    if (mimeType === undefined) {
      throw new UserImageError(`文件内容不是支持的图片格式（支持 ${SUPPORTED_LABEL}）：${target}`);
    }
    uploads.push({ name: path.basename(abs), mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` });
  }
  return uploads;
}
