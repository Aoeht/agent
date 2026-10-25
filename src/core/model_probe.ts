// src/core/model_probe.ts
import OpenAI from "openai";

/**
 * 模型可用性探测：服务商 /models 清单里"有"不等于"能用"——免费配额按模型计
 * （glm-5.2 配额耗尽时清单照列，对话到一半才 403）。这里对候选模型真发一条
 * 微型补全（max_tokens=8，几十 token 级）做分类：可用 / 配额耗尽 / 模型不可用 / 其它异常。
 * 每次对话开始探测一次（CLI 启动横幅；Web 走 GET /models/status，服务端缓存 60s）。
 *
 * 剩余配额是 best-effort：各家没有统一接口——OpenAI 风格限流响应头有就解析
 * （DashScope 兼容端点实测不带任何限流头，阿里云只让去控制台看）；智谱直连
 * （open.bigmodel.cn）补一次 trial_balance 账户余额查询。都拿不到就不显示。
 */

export type ModelProbeKind = "ok" | "quota" | "unavailable" | "error";

export interface ModelProbeResult {
  model: string;
  ok: boolean;
  kind: ModelProbeKind;
  /** 失败时的错误摘要（前 160 字符），供横幅与前端 tooltip */
  detail?: string;
  latencyMs?: number;
  /** 剩余配额的可读描述（能拿到时）：来自响应头限流字段；拿不到就缺省 */
  quota?: string;
}

export interface ModelProbeOptions {
  models: string[];
  /** LLM 客户端；缺省按环境变量自建（与 Agent 同一端点） */
  client?: OpenAI;
  /** 单模型探测超时；缺省 8s */
  timeoutMs?: number;
  /** 并发探测上限：全量清单上百个模型时防把自家限流打爆；缺省 12 */
  concurrency?: number;
}

/** 并发池探测所有候选模型：单模型失败不影响其它模型的结果 */
export async function probeModels(options: ModelProbeOptions): Promise<ModelProbeResult[]> {
  const models = [...new Set(options.models.map((model) => model.trim()).filter(Boolean))];
  const client = options.client ?? new OpenAI({ maxRetries: 0 });
  const timeoutMs = options.timeoutMs ?? 8_000;
  const concurrency = Math.max(1, options.concurrency ?? 12);
  const results: ModelProbeResult[] = new Array(models.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, models.length) }, async () => {
      while (cursor < models.length) {
        const index = cursor++;
        results[index] = await probeOne(client, models[index]!, timeoutMs);
      }
    })
  );
  return results;
}

/**
 * 明确不是对话补全的模型：服务商清单里混着图像生成/语音/OCR/实时音频等端点，
 * 对它们发 chat 补全只会得到 400/404——探测纯属浪费，还徒增下拉列表噪声。
 * 宁可漏放（拿不准的走探测自己淘汰）不可错杀，正则只列确凿的非对话特征。
 */
const NON_CHAT_MODEL_PATTERN =
  /embed|rerank|tts|asr|whisper|moderation|image|speech|audio|ocr|realtime|s2s|livetranslate|(^|\/)wan\d|z-image/i;

export function isLikelyChatModel(id: string): boolean {
  return !NON_CHAT_MODEL_PATTERN.test(id);
}

async function probeOne(client: OpenAI, model: string, timeoutMs: number): Promise<ModelProbeResult> {
  const started = Date.now();
  try {
    const { response } = await client.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        temperature: 0,
      },
      { signal: AbortSignal.timeout(timeoutMs) }
    ).withResponse();
    const quota = quotaFromHeaders(response.headers);
    return {
      model,
      ok: true,
      kind: "ok",
      latencyMs: Date.now() - started,
      ...(quota !== undefined ? { quota } : {}),
    };
  } catch (error) {
    return {
      model,
      ok: false,
      latencyMs: Date.now() - started,
      ...classifyProbeError(error),
    };
  }
}

/** OpenAI 风格限流响应头 → 可读配额描述；都没有返回 undefined（不编数字） */
export function quotaFromHeaders(headers: Headers): string | undefined {
  const requests = headers.get("x-ratelimit-remaining-requests");
  const tokens = headers.get("x-ratelimit-remaining-tokens");
  const parts: string[] = [];
  if (requests !== null && requests !== "") parts.push(`剩 ${requests} 次请求`);
  if (tokens !== null && tokens !== "") parts.push(`剩 ${tokens} tokens`);
  return parts.length > 0 ? parts.join("，") : undefined;
}

/** 错误分类：403/配额字样 → quota；404/模型不存在/产品未开通 → unavailable；其余 → error。
 * 注意 DashScope 用 400 表达"产品未激活"（不是限流）——这是确凿不可用，不能留在列表里 */
export function classifyProbeError(error: unknown): { kind: ModelProbeKind; detail: string } {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.slice(0, 160);
  if (status === 403 || /quota|配额|Access to model denied/i.test(message)) return { kind: "quota", detail };
  if (
    status === 404 ||
    /does not exist|not found|不存在|无权|not activated|未开通|not open|not subscribe/i.test(message)
  ) {
    return { kind: "unavailable", detail };
  }
  return { kind: "error", detail };
}

/**
 * 探测候选项：主模型 + 摘要模型 + AGENT_UI_MODELS（逗号分隔，Web 模型清单同源）。
 * 服务商 /models 拉回的全量清单不进探测——每个对话开始都打几十发探测请求太浪费。
 */
export function candidateModels(config: { model: string; summaryModel: string }): string[] {
  const extra = (process.env.AGENT_UI_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return [...new Set([config.model, config.summaryModel, ...extra].filter(Boolean))];
}

/**
 * 智谱账户余额（trial_balance）：只有 base URL 直连 open.bigmodel.cn 时才试——
 * 其它服务商（DashScope/聚合器）没有这个端点，试了也是白等。失败静默返回 undefined。
 * 验证依据：2026-10 实测 DashScope 无免费额度查询 API（官方只给控制台）。
 */
export async function fetchZhipuAccountQuota(baseURL: string, apiKey: string, timeoutMs = 5_000): Promise<string | undefined> {
  let origin: URL;
  try {
    origin = new URL(baseURL);
  } catch {
    return undefined;
  }
  if (!/(^|\.)bigmodel\.cn$/i.test(origin.hostname)) return undefined;
  try {
    const resp = await fetch(`${origin.origin}/api/paas/v4/trial_balance`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return undefined;
    const body = (await resp.json()) as { data?: Array<{ totalBalance?: string | number; currencyCode?: string }> };
    const first = body.data?.[0];
    if (first === undefined || first.totalBalance === undefined) return undefined;
    return `账户余额 ${first.totalBalance}${first.currencyCode ? ` ${first.currencyCode}` : ""}`;
  } catch {
    return undefined;
  }
}

/** CLI 横幅用的一行摘要：只列非空分组，可用模型带上剩余配额（拿到时）；全部探测失败时不吞掉这个事实 */
export function formatModelProbeLine(results: ModelProbeResult[]): string {
  if (results.length === 0) return "";
  const label = (r: ModelProbeResult): string => (r.ok && r.quota ? `${r.model}（${r.quota}）` : r.model);
  const group = (kind: ModelProbeKind): string[] => results.filter((r) => r.kind === kind).map(label);
  const ok = group("ok");
  const quota = group("quota");
  const down = [...group("unavailable"), ...group("error")];
  const parts = [
    ok.length > 0 ? `✅ 可用: ${ok.join("、")}` : undefined,
    quota.length > 0 ? `⛔ 配额耗尽: ${quota.join("、")}` : undefined,
    down.length > 0 ? `⚠️ 不可用/异常: ${down.join("、")}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ｜ ") : "（探测未产生结果）";
}
