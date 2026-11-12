// 微调反诈 VLM 专用判定工具：单张评论配图/视频封面 + 配套文字 → 三字段 JSON。
// 训练模板固化在工具内，scanner 不自由拼 prompt；像素 base64 内联发给 OpenAI 兼容端点，
// 不进历史/trace。传输层失败经 askUser 询问用户停止或付费继续（run 级闩锁只问一次）；
// 输出格式抖动只重试一次，不打断用户。
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type OpenAI from "openai";
import { defineTool, type ToolRuntime } from "../core/types";
import { MAX_USER_IMAGE_BYTES } from "../core/user_images";
import { sniffImageMime } from "../utils/image_mime";
import { createModelClient, providers, type ProviderStore } from "../core/providers";
import { MCP_SANDBOX_DIR } from "../mcp/config";

export const VLM_FRAUD_CHECK_TOOL_NAME = "vlm_fraud_check";

const URL_DOWNLOAD_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_TEXT_CHARS = 8_000;

export function scannerVlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AGENT_SCANNER_VLLM?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export interface VlmOptions {
  model: string;
  fallbackModel: string;
  concurrency: number;
  timeoutMs: number;
}

/** opt-in 开启时的配置解析：AGENT_VLLM_MODEL 必填（providers.json 的 "providerId::model"） */
export function loadVlmOptions(env: NodeJS.ProcessEnv = process.env): VlmOptions {
  const model = env.AGENT_VLLM_MODEL?.trim();
  if (!model || !model.includes("::")) {
    throw new Error("AGENT_SCANNER_VLLM 已开启但 AGENT_VLLM_MODEL 未配置：请先在 providers.json 添加 vLLM 供应商，再把 AGENT_VLLM_MODEL 设为 \"providerId::模型名\"。");
  }
  const positiveInt = (name: string, fallback: number): number => {
    const value = Number(env[name]?.trim());
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    model,
    fallbackModel: env.AGENT_VLLM_FALLBACK_MODEL?.trim() || "qwen3-vl-plus",
    concurrency: positiveInt("AGENT_VLLM_CONCURRENCY", 4),
    timeoutMs: positiveInt("AGENT_VLLM_TIMEOUT_MS", 120_000),
  };
}

/** 挂载前体检：GET {baseURL}/models，探不通立刻报错，不拖到扫描中途 */
export async function probeVlmEndpoint(
  model: string,
  options: { store?: ProviderStore; fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const store = options.store ?? providers;
  let resolved: ReturnType<ProviderStore["resolve"]>;
  try {
    resolved = store.resolve(model);
  } catch {
    resolved = undefined;
  }
  if (!resolved) throw new Error(`vLLM 体检失败：模型引用 ${model} 在 providers.json 中不存在。`);
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${resolved.baseURL}/models`, {
      headers: { authorization: `Bearer ${resolved.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(`vLLM 体检失败：无法连接 ${resolved.baseURL}/models（${error instanceof Error ? error.message : String(error)}）。请检查 SSH 隧道与 vLLM 服务是否已启动。`);
  }
  if (!response.ok) {
    throw new Error(`vLLM 体检失败：${resolved.baseURL}/models 返回 HTTP ${response.status}。请检查 --api-key 与模型是否已加载。`);
  }
}

function chineseDate(now: Date): string {
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

const systemPrompt = (date: string): string =>
  `今天是${date}。你是一位专业的短视频与社交平台安全审核专家，擅长识别各类隐蔽的视觉诈骗与违规引流行为。` +
  "你的任务是客观分析输入的图片（视频封面或用户评论）及其配套文字，识别图片与文字结合起来是否对其他用户存在诈骗风险，并按要求输出结构化的分析报告。";

const ANALYSIS_TASKS =
  "请仔细观察并分析传入的图片和上面的文字，严格完成以下三项分析任务：\n" +
  "1. **画面描述**：客观描述图片中的主要视觉元素（如人物特征、场景、文字内容、界面截图形态等）\n" +
  "2. **诈骗风险判定**：判断该图片和文字语境结合起来是否对其他用户有诈骗风险。\n" +
  "3. **证据提取**：如果含有风险，请详细指出构成诈骗的具体证据；如果无风险，说明理由。\n" +
  "【输出要求】必须严格返回标准的 JSON 格式，不得包含任何多余的前言、后记或解释文本。JSON 结构字段要求如下：\n" +
  '{"image_description": "用1-2句话客观概括图片展示的主要视觉内容", "fraud_details": "详细说明图片中涉嫌诈骗的具体证据（若无风险则说明理由）", "contains_fraud": true/false}';

const FraudResultSchema = z.object({
  image_description: z.string().min(1),
  fraud_details: z.string().min(1),
  contains_fraud: z.boolean(),
});
type FraudResult = z.output<typeof FraudResultSchema>;

/** 剥围栏、容忍前后解释文字，取第一个 { 到最后一个 }；三字段校验不过返回 undefined */
export function parseFraudResult(raw: string): FraudResult | undefined {
  let body = raw.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1]!.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return FraudResultSchema.parse(JSON.parse(body.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

const ParamsSchema = z.object({
  image: z.string().trim().min(1)
    .describe("图片位置：工作区相对路径（评论头 local_images 给出的路径）、工作区内绝对路径或 http(s) URL"),
  text: z.string().trim().min(1).max(MAX_TEXT_CHARS)
    .describe("配套文字：kind=comment 时填该条评论的正文，kind=cover 时填视频标题"),
  kind: z.enum(["comment", "cover"]).default("comment")
    .describe("模板变体：comment=用户评论图片+评论内容（本次扫描用这个）；cover=视频封面图片+标题"),
});

export interface VlmFraudCheckOptions {
  sandboxRoot?: string;
  /** 测试注入的客户端；缺省按 providers.json 路由自建 */
  client?: OpenAI;
  model?: string;
  fallbackModel?: string;
  concurrency?: number;
  timeoutMs?: number;
  store?: ProviderStore;
  /** 测试注入的时钟（日期模板） */
  now?: () => Date;
}

export function createVlmFraudCheckTool(options: VlmFraudCheckOptions = {}) {
  const sandboxRoot = path.resolve(options.sandboxRoot ?? MCP_SANDBOX_DIR);
  // 显式注入 model（测试/接线已解析）时不读 env；否则构造期即校验配置
  const envOptions = options.model === undefined ? loadVlmOptions() : undefined;
  const model = options.model ?? envOptions!.model;
  const fallbackModel = options.fallbackModel ?? envOptions?.fallbackModel ?? "qwen3-vl-plus";
  const concurrency = options.concurrency ?? envOptions?.concurrency ?? 4;
  const timeoutMs = options.timeoutMs ?? envOptions?.timeoutMs ?? 120_000;
  const client = options.client ?? createModelClient({ maxRetries: 0, timeout: timeoutMs }, options.store ?? providers);
  const now = options.now ?? (() => new Date());

  // run 级状态：工具实例随每次 scanner 委派新建，实例作用域即一次扫描
  let useFallback = false;
  let stopped = false;
  let policyPromise: Promise<"stop" | "paid"> | undefined;

  // 并发闸门：槽位在 release 时原子转移，避免唤醒间隙超发
  let active = 0;
  const waiters: Array<() => void> = [];
  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>(resolve => waiters.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = waiters.shift();
      if (next) { active += 1; next(); }
    }
  }

  async function readLocalImage(image: string): Promise<string> {
    const abs = path.resolve(sandboxRoot, image);
    if (!abs.startsWith(sandboxRoot + path.sep)) throw new Error(`图片越出工作区：${image}`);
    const stat = await fs.stat(abs).catch(() => undefined);
    if (stat === undefined) throw new Error(`图片不存在：${image}`);
    if (!stat.isFile()) throw new Error(`不是文件：${image}`);
    if (stat.size > MAX_USER_IMAGE_BYTES) throw new Error(`图片过大：${image}（${stat.size} 字节，上限 ${MAX_USER_IMAGE_BYTES}）`);
    const bytes = await fs.readFile(abs);
    const mime = sniffImageMime(bytes);
    if (mime === undefined) throw new Error(`文件内容不是支持的图片格式（PNG、JPEG、WebP、GIF）：${image}`);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  async function fetchRemoteImage(url: string, signal?: AbortSignal): Promise<string> {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(URL_DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(URL_DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(url, { signal: combined, redirect: "follow" });
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}（${url}）`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_USER_IMAGE_BYTES) {
      throw new Error(`图片过大：${url}（声明 ${declared} 字节，上限 ${MAX_USER_IMAGE_BYTES}）`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_USER_IMAGE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`图片过大：${url}（超过上限 ${MAX_USER_IMAGE_BYTES} 字节）`);
        }
        chunks.push(value);
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length > MAX_USER_IMAGE_BYTES) throw new Error(`图片过大：${url}（上限 ${MAX_USER_IMAGE_BYTES} 字节）`);
      chunks.push(buffer);
      total = buffer.length;
    }
    const bytes = Buffer.concat(chunks, total);
    const mime = sniffImageMime(bytes);
    if (mime === undefined) throw new Error(`下载内容不是支持的图片格式（PNG、JPEG、WebP、GIF）：${url}`);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  const askOnce = async (error: unknown, runtime?: ToolRuntime): Promise<"stop" | "paid"> => {
    const reason = error instanceof Error ? error.message : String(error);
    if (!runtime?.askUser) return "stop";
    let answer: string | null = null;
    try {
      answer = await runtime.askUser(
        `vLLM 推理服务不可用（${reason}）。本次扫描接下来怎么办？回答「停止」中止扫描；回答「付费继续」改用 ${fallbackModel} 完成剩余判定（产生 API 费用）。`,
        runtime.signal ?? new AbortController().signal,
      );
    } catch {
      return "stop";
    }
    const text = (answer ?? "").trim().toLowerCase();
    return /付费|继续|paid|continue/.test(text) ? "paid" : "stop";
  };

  return defineTool({
    name: VLM_FRAUD_CHECK_TOOL_NAME,
    // 自管超时（单请求死线 + 重试 + 等待用户回答），豁免 Agent 级死线
    timeoutMs: 0,
    parallelSafe: true,
    needsReconciliation: false,
    schema: ParamsSchema,
    description:
      "对单张评论配图（或视频封面）+ 配套文字做微调专用模型的诈骗风险视觉判定，" +
      "返回 image_description / fraud_details / contains_fraud 三字段结构化结果。" +
      "评论头带 local_images 的评论：image 传图片路径、text 传该条评论正文（kind=comment）；重要证据图建议逐张判定。" +
      "与 read_image 的自我观察互补：本工具是专用反诈判定口径，read_image 是你自己的通用观察。" +
      "服务不可用时会询问用户停止或改用付费模型；用户选择停止时立即结束扫描并在 unresolved 注明。",
    execute: async (params, runtime) => {
      const signal = runtime?.signal;
      signal?.throwIfAborted();
      if (stopped) throw new Error("vLLM 不可用且用户已选择停止扫描。请结束本次扫描，不要继续调用本工具。");

      const dataUrl = /^https?:\/\//i.test(params.image)
        ? await fetchRemoteImage(params.image, signal)
        : await readLocalImage(params.image);

      const prefix = params.kind === "cover" ? "视频封面图片：" : "用户评论图片：";
      const label = params.kind === "cover" ? "标题" : "评论内容";
      const messages = [
        { role: "system" as const, content: systemPrompt(chineseDate(now())) },
        {
          role: "user" as const,
          content: [
            { type: "text", text: prefix },
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: `\n${label}：${params.text}。${ANALYSIS_TASKS}` },
          ] as never,
        },
      ];

      const callModel = (target: string) => client.chat.completions.create({
        model: target,
        messages,
        temperature: 0,
        max_tokens: 2000,
      }, { timeout: timeoutMs, maxRetries: 0, ...(signal ? { signal } : {}) });

      const extract = (response: OpenAI.Chat.Completions.ChatCompletion): FraudResult | undefined => {
        const choice = response.choices[0];
        if (choice?.finish_reason !== "stop" || choice.message?.refusal) return undefined;
        return parseFraudResult(choice.message.content ?? "");
      };

      let target = useFallback ? fallbackModel : model;
      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await withSlot(() => callModel(target));
      } catch (error) {
        signal?.throwIfAborted();
        // 传输层失败（连不上/超时/4xx/5xx）：run 级闩锁只问一次，选择对本次运行生效
        const policy = await (policyPromise ??= askOnce(error, runtime));
        if (policy === "stop") {
          stopped = true;
          const channel = runtime?.askUser ? "用户选择停止扫描" : "当前环境不支持询问用户，默认停止";
          throw new Error(`vLLM 推理服务不可用（${error instanceof Error ? error.message : String(error)}），${channel}。请结束本次扫描，并在报告 unresolved 中注明视觉判定未完成。`);
        }
        useFallback = true;
        target = fallbackModel;
        response = await withSlot(() => callModel(target));
      }

      let parsed = extract(response);
      if (parsed === undefined) {
        // 格式抖动原样重试一次；仍不合格返回错误给 scanner 自行处理，不打断用户
        signal?.throwIfAborted();
        response = await withSlot(() => callModel(target));
        parsed = extract(response);
      }
      if (parsed === undefined) {
        return {
          ok: false,
          error: "模型两次输出均不合格（非 stop 完成、拒答或 JSON 缺三字段），本张图判定失败；可跳过或换图，不要据此定性。",
          model: target,
          used_fallback: useFallback,
        };
      }
      return { ok: true, kind: params.kind, model: target, used_fallback: useFallback, ...parsed };
    },
  });
}