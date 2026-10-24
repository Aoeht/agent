// src/core/model_probe.ts
import OpenAI from "openai";

/**
 * 模型可用性探测：服务商 /models 清单里"有"不等于"能用"——免费配额按模型计
 * （glm-5.2 配额耗尽时清单照列，对话到一半才 403）。这里对候选模型真发一条
 * 微型补全（max_tokens=8，几十 token 级）做分类：可用 / 配额耗尽 / 模型不可用 / 其它异常。
 * 每次对话开始探测一次（CLI 启动横幅；Web 走 GET /models/status，服务端缓存 60s）。
 */

export type ModelProbeKind = "ok" | "quota" | "unavailable" | "error";

export interface ModelProbeResult {
  model: string;
  ok: boolean;
  kind: ModelProbeKind;
  /** 失败时的错误摘要（前 160 字符），供横幅与前端 tooltip */
  detail?: string;
  latencyMs?: number;
}

export interface ModelProbeOptions {
  models: string[];
  /** LLM 客户端；缺省按环境变量自建（与 Agent 同一端点） */
  client?: OpenAI;
  /** 单模型探测超时；缺省 8s */
  timeoutMs?: number;
}

/** 并发探测所有候选模型：单模型失败不影响其它模型的结果 */
export async function probeModels(options: ModelProbeOptions): Promise<ModelProbeResult[]> {
  const models = [...new Set(options.models.map((model) => model.trim()).filter(Boolean))];
  const client = options.client ?? new OpenAI({ maxRetries: 0 });
  const timeoutMs = options.timeoutMs ?? 8_000;
  return Promise.all(models.map((model) => probeOne(client, model, timeoutMs)));
}

async function probeOne(client: OpenAI, model: string, timeoutMs: number): Promise<ModelProbeResult> {
  const started = Date.now();
  try {
    await client.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        temperature: 0,
      },
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    return { model, ok: true, kind: "ok", latencyMs: Date.now() - started };
  } catch (error) {
    return {
      model,
      ok: false,
      latencyMs: Date.now() - started,
      ...classifyProbeError(error),
    };
  }
}

/** 错误分类：403/配额字样 → quota（要去充值或换模型）；404/模型不存在 → unavailable；其余 → error */
export function classifyProbeError(error: unknown): { kind: ModelProbeKind; detail: string } {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.slice(0, 160);
  if (status === 403 || /quota|配额/i.test(message)) return { kind: "quota", detail };
  if (status === 404 || /does not exist|not found|不存在|无权/i.test(message)) return { kind: "unavailable", detail };
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

/** CLI 横幅用的一行摘要：只列非空分组，全部探测失败时不吞掉这个事实 */
export function formatModelProbeLine(results: ModelProbeResult[]): string {
  if (results.length === 0) return "";
  const group = (kind: ModelProbeKind): string[] => results.filter((r) => r.kind === kind).map((r) => r.model);
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
