// src/utils/image_tokens.ts
/**
 * 图片附件的 token 估算：文本 tokenizer 看不到像素开销，而图片是要真占上下文窗口的。
 *
 * 口径按 2026-10 各家官方文档（只求量级正确，压缩阈值靠它判断，不靠它计费）：
 * - Qwen3-VL / Qwen3.x：32×32 像素/token，尺寸取整到 32，默认上限 2560 tokens
 *   （vl_high_resolution_images=true 时 16384），末尾另加 2 个视觉边界 token；
 * - Qwen2.5-VL / QVQ：28×28 像素/token，默认上限 1280、下限 256，同样 +2；
 * - GLM-4V 系列：官方 FAQ 口径为单图约 1047 tokens（4.5V/4.6V 未公开，沿用该值）；
 * - DeepSeek deepseek-flash：缩放到总像素约 1300×1300，单图 ≤1024 tokens；
 *   官方无公开公式，按像素/1650 近似；
 * - 其余：OpenAI 高分块口径（长边 ≤2048、短边 ≤768、512 分块 = 85 + 170×块数）。
 * - 读不出尺寸时按 base64 体积退估，再按模型上限夹紧，绝不返回 0。
 */

const DEFAULT_IMAGE_TOKENS = 800;
const MIN_IMAGE_TOKENS = 85;
const MAX_TILED_IMAGE_TOKENS = 1_445; // 2048×768 满格分块
const FALLBACK_BYTES_PER_TOKEN = 150;
const GLM_IMAGE_TOKENS = 1_047;
const DEEPSEEK_MAX_TOKENS = 1_024;
const DEEPSEEK_PIXELS_PER_TOKEN = 1_650; // 1300² / 1024 ≈ 1650
const QWEN3_FACTOR = 32;
const QWEN3_MIN_TOKENS = 4;
const QWEN3_MAX_TOKENS = 2_560;
const QWEN25_FACTOR = 28;
const QWEN25_MIN_TOKENS = 256;
const QWEN25_MAX_TOKENS = 1_280;
/** 96KB 像素数据足以覆盖 PNG/GIF/WebP 头与绝大多数 JPEG 的 EXIF+SOF */
const HEADER_BASE64_CHARS = 131_072;

interface Dimensions {
  width: number;
  height: number;
}

export interface ImageTokenOptions {
  /** 用于选择计费口径；缺省按 OpenAI 高分块近似 */
  model?: string;
}

export function estimateImageTokensFromDataUrl(dataUrl: string, options: ImageTokenOptions = {}): number {
  if (!dataUrl.startsWith("data:")) return DEFAULT_IMAGE_TOKENS;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return DEFAULT_IMAGE_TOKENS;
  if (!dataUrl.slice(5, comma).includes("base64")) return DEFAULT_IMAGE_TOKENS;

  const payload = dataUrl.slice(comma + 1);
  const dimensions = readImageDimensions(Buffer.from(payload.slice(0, HEADER_BASE64_CHARS), "base64"));
  if (dimensions === undefined) return fallbackTokens(payload.length, options.model);
  return tokensForDimensions(dimensions, options.model);
}

function tokensForDimensions(dimensions: Dimensions, model = ""): number {
  const lower = model.toLowerCase();
  if (lower.includes("deepseek")) return deepseekTokens(dimensions);
  if (lower.includes("glm")) return GLM_IMAGE_TOKENS;
  if (lower.includes("qwen") || lower.includes("qvq")) return qwenTokens(dimensions, lower);
  return clamp(tiledTokens(dimensions.width, dimensions.height), MIN_IMAGE_TOKENS, MAX_TILED_IMAGE_TOKENS);
}

function isQwen3Model(model: string): boolean {
  return /qwen3(?:[.\-\s]|$)/i.test(model);
}

/** 复刻官方 smart_resize：按 factor 取整，再夹到 [min_pixels, max_pixels]，最后 +2 个视觉边界 token */
function qwenTokens({ width, height }: Dimensions, model: string): number {
  const isQwen3 = isQwen3Model(model);
  const factor = isQwen3 ? QWEN3_FACTOR : QWEN25_FACTOR;
  const minTokens = isQwen3 ? QWEN3_MIN_TOKENS : QWEN25_MIN_TOKENS;
  const maxTokens = isQwen3 ? QWEN3_MAX_TOKENS : QWEN25_MAX_TOKENS;
  const minPixels = minTokens * factor * factor;
  const maxPixels = maxTokens * factor * factor;

  let hBar = Math.round(height / factor) * factor;
  let wBar = Math.round(width / factor) * factor;
  const pixels = hBar * wBar;

  if (pixels > maxPixels) {
    const beta = Math.sqrt((width * height) / maxPixels);
    hBar = Math.floor(height / beta / factor) * factor;
    wBar = Math.floor(width / beta / factor) * factor;
  } else if (pixels < minPixels) {
    const beta = Math.sqrt(minPixels / (width * height));
    hBar = Math.ceil((height * beta) / factor) * factor;
    wBar = Math.ceil((width * beta) / factor) * factor;
  }

  return Math.max(minTokens + 2, Math.floor((hBar * wBar) / (factor * factor)) + 2);
}

/** DeepSeek 没有公开公式：按"1300×1300 ≈ 1024 tokens"反推，再夹到单图上限 */
function deepseekTokens({ width, height }: Dimensions): number {
  return clamp(Math.ceil((width * height) / DEEPSEEK_PIXELS_PER_TOKEN), 4, DEEPSEEK_MAX_TOKENS);
}

function tiledTokens(width: number, height: number): number {
  let w = width;
  let h = height;
  const longSide = Math.max(w, h);
  if (longSide > 2048) {
    const scale = 2048 / longSide;
    w *= scale;
    h *= scale;
  }
  const shortSide = Math.min(w, h);
  if (shortSide > 768) {
    const scale = 768 / shortSide;
    w *= scale;
    h *= scale;
  }
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return 85 + 170 * tiles;
}

/** 尺寸不可读时的退估：压缩后的字节体积与像素量正相关，宁可略保守也不当 0 处理 */
function fallbackTokens(payloadChars: number, model = ""): number {
  const bytes = Math.ceil(payloadChars * 0.75);
  return clamp(
    Math.ceil(bytes / FALLBACK_BYTES_PER_TOKEN),
    MIN_IMAGE_TOKENS,
    maxTokensForModel(model)
  );
}

/** 退估不能超过对应模型的单图上限（Qwen 的 +2 也计入） */
function maxTokensForModel(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes("deepseek")) return DEEPSEEK_MAX_TOKENS;
  if (lower.includes("glm")) return GLM_IMAGE_TOKENS;
  if (lower.includes("qwen") || lower.includes("qvq")) {
    return (isQwen3Model(lower) ? QWEN3_MAX_TOKENS : QWEN25_MAX_TOKENS) + 2;
  }
  return MAX_TILED_IMAGE_TOKENS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readImageDimensions(bytes: Buffer): Dimensions | undefined {
  return pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes);
}

function valid(width: number, height: number): Dimensions | undefined {
  return width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : undefined;
}

function pngDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 24) return undefined;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return undefined;
  return valid(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function gifDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 10) return undefined;
  const head = bytes.subarray(0, 6).toString("ascii");
  if (head !== "GIF87a" && head !== "GIF89a") return undefined;
  return valid(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
}

function jpegDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // 无长度的独立标记：SOI/TEM/RSTn
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // SOS 之后是熵编码数据，SOF 不可能再出现；EOI 收尾
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return valid(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < 30) return undefined;
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF") return undefined;
  if (bytes.subarray(8, 12).toString("ascii") !== "WEBP") return undefined;
  const chunk = bytes.subarray(12, 16).toString("ascii");

  if (chunk === "VP8X") {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return valid(width, height);
  }

  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return undefined;
    const b1 = bytes[21]!;
    const b2 = bytes[22]!;
    const b3 = bytes[23]!;
    const b4 = bytes[24]!;
    const width = 1 + (b1 | ((b2 & 0x3f) << 8));
    const height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    return valid(width, height);
  }

  if (chunk === "VP8 ") {
    // 帧头起始码 9d 01 2a 之后的 4 字节：14 位宽 + 14 位高
    for (let offset = 20; offset + 10 <= bytes.length && offset < 4096; offset++) {
      if (bytes[offset] === 0x9d && bytes[offset + 1] === 0x01 && bytes[offset + 2] === 0x2a) {
        const width = bytes.readUInt16LE(offset + 3) & 0x3fff;
        const height = bytes.readUInt16LE(offset + 5) & 0x3fff;
        return valid(width, height);
      }
    }
  }

  return undefined;
}
