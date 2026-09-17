// src/tools/video-keyframe.ts
import { z } from "zod";
import { toolRegistry } from "./registry";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

// ✅ 1. 定义参数 Schema（Zod 校验 + LLM 理解两用）
const KeyframeParamsSchema = z.object({
  video_path: z.string().describe("视频的本地绝对路径"),
  max_frames: z.number().min(1).max(10).default(5).describe("最多提取的关键帧数量"),
  output_dir: z.string().optional().describe("输出目录，默认为 /tmp/keyframes"),
});

// ✅ 2. 注册工具
toolRegistry.register({
  name: "extract_video_keyframes",
  description:
    "从视频中提取关键帧用于画面内容分析。当需要判断视频画面是否包含诈骗二维码、虚假证书、冒充客服界面时调用此工具。",
  
  // ✅ 3. JSON Schema（供 LLM 理解参数结构）
  parameters: {
    type: "object",
    properties: {
      video_path: { type: "string", description: "视频的本地绝对路径" },
      max_frames: { type: "number", description: "最多提取帧数 (1-10)", default: 5 },
      output_dir: { type: "string", description: "输出目录路径" },
    },
    required: ["video_path"],
  },

  // ✅ 4. 执行函数（接收 unknown，内部用 Zod 校验）
  execute: async (args: unknown) => {
    const params = KeyframeParamsSchema.parse(args);
    const outDir = params.output_dir ?? `/tmp/keyframes_${Date.now()}`;

    // 确保输出目录存在
    await fs.mkdir(outDir, { recursive: true });

    // 调用 FFmpeg 提取关键帧
    const { stdout } = await execFileAsync("ffmpeg", [
      "-i", params.video_path,
      "-vf", `select=eq(pict_type\\,I),scale=640:-1`,
      "-frames:v", String(params.max_frames),
      "-vsync", "vfr",
      `${outDir}/frame_%03d.jpg`,
      "-y",
    ]);

    // 读取生成的帧文件列表
    const files = await fs.readdir(outDir);
    const framePaths = files
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => path.join(outDir, f));

    return {
      frame_count: framePaths.length,
      output_dir: outDir,
      frames: framePaths,
    };
  },
});