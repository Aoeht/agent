// web/src/lib/attachments.ts
// 浏览器侧的图片附件：格式判定、大小校验与 data URL 编码。
// 服务端会用同一套上限复核（src/core/user_images.ts），这里只做即时反馈，不替代后端校验。
import type { UserImageUploadBody } from "@protocol";

/** 单次请求上限：工具图片与用户图片共享这份预算（与服务端一致） */
export const MAX_IMAGES_PER_REQUEST = 8;
/** 单张原图上限 7 MiB（编码后约 9.3 MiB） */
export const MAX_USER_IMAGE_BYTES = 7 * 1024 * 1024;
/** 请求内图片 data URL 编码后的总字节上限 */
export const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;

const SUPPORTED_LABEL = "PNG、JPEG、WebP、GIF";

export interface LocalImageAttachment {
  /** 本地列表键（仅前端生命周期内使用） */
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  /** 原图字节数 */
  sizeBytes: number;
  /** data URL 编码后的字节数（请求级配额按这个算） */
  encodedBytes: number;
}

export function formatImageSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${bytes}B`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 按文件头判定 MIME：扩展名与 File.type 都可以不可信 */
function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.subarray(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.subarray(0, 4));
    const webp = String.fromCharCode(...bytes.subarray(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // 分块拼字符串：7MB 一次性 apply 会爆栈
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/]/g, "_").trim();
  if (cleaned === "") return fallback;
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * 把用户在浏览器里选中的文件转成待上传附件。
 * 不合格的文件逐个报错并跳过，合格的整体加入；返回新增项与错误文案（按用户选择顺序）。
 */
export async function addImageFiles(
  existing: readonly LocalImageAttachment[],
  files: readonly File[]
): Promise<{ added: LocalImageAttachment[]; errors: string[] }> {
  const added: LocalImageAttachment[] = [];
  const errors: string[] = [];
  let totalEncoded = existing.reduce((sum, image) => sum + image.encodedBytes, 0);

  for (const [index, file] of files.entries()) {
    const label = file.name?.trim() || `第 ${index + 1} 个文件`;
    if (existing.length + added.length >= MAX_IMAGES_PER_REQUEST) {
      errors.push(`一次最多上传 ${MAX_IMAGES_PER_REQUEST} 张图片，已忽略「${label}」`);
      continue;
    }
    if (file.size === 0) {
      errors.push(`「${label}」是空文件`);
      continue;
    }
    if (file.size > MAX_USER_IMAGE_BYTES) {
      errors.push(`「${label}」过大（${formatImageSize(file.size)}），单张上限 ${formatImageSize(MAX_USER_IMAGE_BYTES)}`);
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = sniffImageMime(bytes);
    if (mimeType === undefined) {
      errors.push(`「${label}」不是受支持的图片格式（支持 ${SUPPORTED_LABEL}）`);
      continue;
    }
    const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
    const encodedBytes = dataUrl.length;
    if (totalEncoded + encodedBytes > MAX_REQUEST_IMAGE_BYTES) {
      errors.push(`图片总量超过上限（${formatImageSize(MAX_REQUEST_IMAGE_BYTES)}），已忽略「${label}」`);
      continue;
    }
    totalEncoded += encodedBytes;
    added.push({
      id: uid(),
      name: sanitizeName(file.name ?? "", `图片 ${existing.length + added.length + 1}`),
      mimeType,
      dataUrl,
      sizeBytes: bytes.length,
      encodedBytes,
    });
  }
  return { added, errors };
}

/** 粘贴板/拖入的文件里只留图片（内容仍会在 addImageFiles 里按文件头复核） */
export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return [...transfer.files].filter((file) => file.type === "" || file.type.startsWith("image/"));
}

export function toUploadBodies(images: readonly LocalImageAttachment[]): UserImageUploadBody[] {
  return images.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl }));
}
