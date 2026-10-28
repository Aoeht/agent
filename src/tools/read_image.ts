// tool 消息只能放文本，像素经 emitImage 单独附加，不进入历史或 trace。
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";
import { MAX_USER_IMAGE_BYTES } from "../core/user_images";
import { sniffImageMime } from "../utils/image_mime";
import { MCP_SANDBOX_DIR } from "../mcp/config";

// 7 MiB 原图编码后约 9.3 MiB；请求级总量还会受 Agent 配额约束。
export const MAX_IMAGE_BYTES = MAX_USER_IMAGE_BYTES;
export { sniffImageMime };

const MAX_IMAGE_MB = MAX_IMAGE_BYTES / (1024 * 1024);
const SUPPORTED_FORMATS = "PNG、JPEG、WebP、GIF";

const ReadImageParamsSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, "path 不能为空")
    .describe("图片路径，相对工作区根目录（如 reports/chart.png），必须位于工作区内"),
});

export function createReadImageTool(options: { sandboxRoot?: string } = {}): ToolDefinition {
  const sandboxRoot = path.resolve(options.sandboxRoot ?? MCP_SANDBOX_DIR);

  return defineTool({
    name: "read_image",
    schema: ReadImageParamsSchema,
    parallelSafe: true,
    needsReconciliation: false,
    description:
      `读取工作区内的本地图片（${SUPPORTED_FORMATS}，单文件 ≤ ${MAX_IMAGE_MB}MB），把图片直接附加到你的下一轮视觉输入，` +
      "由你自己观察和推理。这是查看本地图片的首选方式；MCP 工具已附加的图片无需重复读取。" +
      "不要为了看图加载视觉技能或写脚本调用外部视觉服务。" +
      "只有在图片格式不支持、工具不可用或用户明确要求某个外部视觉服务时，才改用其他方式并说明原因。",
    execute: async (params, runtime) => {
      if (runtime?.emitImage === undefined) {
        throw new Error("当前运行环境没有图片通道（模型视觉能力已关闭或通道不可用），无法查看图片；请使用可用且获授权的 OCR 工具，或如实说明限制。");
      }
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
      const relative = path.relative(sandboxRoot, abs).split(path.sep).join("/");
      const label = `工作区图片 ${relative}（${mime}，${Math.ceil(stat.size / 1024)} KB）`;
      const attached = runtime.emitImage({
        dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
        label,
      });
      if (!attached) {
        throw new Error(
          `图片未能附加到下一轮输入（图片配额已满或调用已结束）：${relative}。` +
            "请减少同批图片数量或缩小图片后重试，不要声称已看见图片。"
        );
      }
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
