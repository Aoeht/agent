// src/tools/read_image.ts
/**
 * 本地图片读取：把工作区内的图片直接附加到模型下一轮视觉输入。
 *
 * 为什么需要它：`role:"tool"` 消息只能放文本（Chat Completions 硬约束），
 * filesystem MCP 的 read_media_file 只能返回 base64 文本，还会被 maxResultChars 截断 ——
 * 多模态模型明明能看图，却拿不到像素，只能退化成加载视觉技能或写脚本调外部服务。
 * 本工具走 ToolRuntime.emitImage：图片作为 user 消息的 image_url 附到下一次 LLM 请求，
 * 不经过 JSON 文本、不进对话历史与 trace。
 *
 * 边界与 run_script / filesystem MCP 一致：路径必须落在工作区内；
 * 按文件头识别真实格式（扩展名不可信）；超过大小上限直接拒绝，不做静默压缩。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";
import { MCP_SANDBOX_DIR } from "../mcp/config";

/** 单文件上限：base64 会再放大 1/3，10MB 原图已足够覆盖截图与常见照片 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MAX_IMAGE_MB = MAX_IMAGE_BYTES / (1024 * 1024);
const SUPPORTED_FORMATS = "PNG、JPEG、WebP、GIF";

const ReadImageParamsSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, "path 不能为空")
    .describe("图片路径，相对工作区根目录（如 reports/chart.png），必须位于工作区内"),
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 按文件头判定 MIME：扩展名可以随便起，像素数据不会说谎 */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function createReadImageTool(options: { sandboxRoot?: string } = {}): ToolDefinition {
  const sandboxRoot = path.resolve(options.sandboxRoot ?? MCP_SANDBOX_DIR);

  return defineTool({
    name: "read_image",
    schema: ReadImageParamsSchema,
    parallelSafe: true,
    needsReconciliation: false,
    description:
      `读取工作区内的本地图片（${SUPPORTED_FORMATS}，单文件 ≤ ${MAX_IMAGE_MB}MB），把图片直接附加到你的下一轮视觉输入，` +
      "由你自己观察和推理。这是查看本地图片的首选方式：不要用 filesystem 的 read_media_file" +
      "（只返回被截断的 base64 文本，你无法读懂），也不要为了看图加载视觉技能或写脚本调用外部视觉服务。" +
      "只有在图片格式不支持、工具不可用或用户明确要求某个外部视觉服务时，才改用其他方式并说明原因。",
    execute: async (params, runtime) => {
      const abs = path.resolve(sandboxRoot, params.path);
      if (!abs.startsWith(sandboxRoot + path.sep)) {
        throw new Error(`图片越出工作区：${params.path}`);
      }
      const stat = await fs.stat(abs).catch(() => undefined);
      if (stat === undefined) throw new Error(`图片不存在：${params.path}`);
      if (!stat.isFile()) throw new Error(`不是文件：${params.path}`);
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new Error(
          `图片过大：${params.path}（${stat.size} 字节，上限 ${MAX_IMAGE_BYTES}）。请先缩放或压缩后再读。`
        );
      }
      const bytes = await fs.readFile(abs);
      const mime = sniffImageMime(bytes);
      if (mime === undefined) {
        throw new Error(`文件内容不是支持的图片格式（支持 ${SUPPORTED_FORMATS}）：${params.path}`);
      }
      if (runtime?.emitImage === undefined) {
        throw new Error("当前运行环境没有图片通道，无法把图片附加给模型");
      }
      const relative = path.relative(sandboxRoot, abs).split(path.sep).join("/");
      const label = `工作区图片 ${relative}（${mime}，${Math.ceil(stat.size / 1024)} KB）`;
      runtime.emitImage({ dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, label });
      return {
        path: relative,
        mime_type: mime,
        size_bytes: stat.size,
        attached: true,
        note: "图片已附加到你的下一轮输入，本轮工具结果不含像素数据。请直接观察图片内容作答。",
      };
    },
  });
}
