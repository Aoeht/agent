// src/rag/rewrite.ts
/**
 * 检索查询改写：把用户/模型给的原始问题压成一条更适合 BM25 与向量检索的查询。
 *
 * 只在本地命中不足、准备二次检索或联网时才调用（rag_search 内部控制），
 * 所以热路径（本地够用）不付这次 LLM 调用。
 *
 * 环境变量（均可选）：
 *   AGENT_RAG_REWRITE=0        关闭改写（缺省开启，但需要知道模型名才会真正构造）
 *   AGENT_RAG_REWRITE_MODEL    改写用的模型，缺省用调用方传入的 summaryModel/主模型
 *   REWRITE_BASE_URL / REWRITE_API_KEY  专用地址与 Key，缺省复用 OPENAI_BASE_URL / OPENAI_API_KEY
 */
import OpenAI from "openai";

export interface QueryRewriter {
  readonly model: string;
  /** 返回改写后的查询；调用方负责与原文比较并从失败中降级 */
  rewrite(query: string, signal?: AbortSignal): Promise<string>;
}

const SYSTEM_PROMPT = [
  "你是检索查询改写器。把用户问题改写成一条适合中文关键词检索与向量检索的查询：",
  "1. 保留实体原文写法（平台名、渠道、手法俗称、金额、地域）；",
  "2. 补上同义术语，例如：刷单=刷信誉=做任务返利；冒充客服=假客服；杀猪盘=婚恋交友投资诈骗；",
  "3. 去掉寒暄、指代、问句语气和与检索无关的个人背景；",
  "4. 只输出改写后的查询本身，不要解释、不要引号、不要编号，不超过 80 字。",
].join("\n");

/** 最多保留的字数：超过这个长度的“改写”基本是把原文抄了一遍，没有检索价值 */
const MAX_REWRITE_CHARS = 120;

export class LlmQueryRewriter implements QueryRewriter {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly timeoutMs: number = 15_000
  ) {}

  async rewrite(query: string, signal?: AbortSignal): Promise<string> {
    const timeout = createTimeoutSignal(signal, this.timeoutMs);
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: query },
          ],
          temperature: 0,
          max_tokens: 160,
        },
        { signal: timeout.signal }
      );
      return sanitizeRewrite(response.choices[0]?.message?.content ?? "", query);
    } finally {
      timeout.dispose();
    }
  }
}

/**
 * 模型偶尔会带引号、前缀或解释；清理成一行后仍然为空/过长就退回原查询，
 * 让“改写失败”退化成“不改写”，而不是把垃圾查询送进检索。
 */
export function sanitizeRewrite(raw: string, original: string): string {
  let text = raw.trim();
  // 去掉常见的“改写：/查询：/改写后的查询：”前缀
  text = text.replace(/^(改写后?的?查询|改写|查询)\s*[:：]\s*/, "");
  // 只取第一行，去掉包裹引号与反引号
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  text = firstLine.replace(/^["'“”‘’`「」]+|["'“”‘’`「」]+$/g, "").trim();
  if (text.length === 0 || text.length > MAX_REWRITE_CHARS) return original;
  return text;
}

/** 把调用方的 abort 信号与超时合成一个；dispose 时清定时器并解绑监听 */
export function createTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`llm 调用超时（${timeoutMs}ms）`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export interface RewriterFromEnvOptions {
  /** 调用方已知的模型名（如 summaryModel / 主模型）；AGENT_RAG_REWRITE_MODEL 优先 */
  model?: string | undefined;
}

/**
 * 从环境变量构造改写器；AGENT_RAG_REWRITE=0/false 或没有模型名时返回 undefined（不改写）。
 * 配了模型却缺地址/Key 直接抛错，与 embedding 客户端保持同一口径。
 */
export function createQueryRewriterFromEnv(options: RewriterFromEnvOptions = {}): QueryRewriter | undefined {
  const flag = process.env.AGENT_RAG_REWRITE?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return undefined;
  const model = process.env.AGENT_RAG_REWRITE_MODEL?.trim() || options.model?.trim();
  if (!model) return undefined;
  const baseURL = process.env.REWRITE_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim();
  const apiKey = process.env.REWRITE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!baseURL || !apiKey) {
    throw new Error(
      "已启用查询改写但缺少模型服务地址/Key：请补 REWRITE_BASE_URL 与 REWRITE_API_KEY，或依赖 OPENAI_BASE_URL/OPENAI_API_KEY"
    );
  }
  return new LlmQueryRewriter(new OpenAI({ baseURL, apiKey, maxRetries: 1, timeout: 30_000 }), model);
}
