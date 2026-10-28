// src/rag/rerank.ts
/**
 * 检索结果重排：把融合后的候选块交给 cross-encoder 重排模型按“与查询的相关性”重新打分。
 * BM25 与向量都是“查询和文档各自编码后比相似度”，重排模型是查询+文档一起过一遍，能压掉词面命中但语义跑偏的块。
 *
 * 环境变量（均可选；RERANK_MODEL 是重排的总开关，不配则 rag_search 保持原排序）：
 *   RERANK_MODEL     重排模型名（DashScope：qwen3.7-text-rerank / qwen3-rerank）
 *   RERANK_BASE_URL  重排接口地址；缺省按 OPENAI_BASE_URL 推断：DashScope 域名走原生 rerank 路径，
 *                    其它服务商按 OpenAI 兼容的 {base}/rerank 调用
 *   RERANK_API_KEY   重排服务 Key，缺省用 OPENAI_API_KEY
 *
 * 请求体形状按地址判定：DashScope 原生用 input/parameters 包一层，其余用扁平的 query/documents。
 */
import { createTimeoutSignal } from "./rewrite";

export interface Reranker {
  readonly model: string;
  /** 返回与 documents 等长的相关性分（越大越相关）；缺失的下标给 0 分，由调用方保持稳定排序 */
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]>;
}

/** 重排接口一次能吃的文档数上限；候选池本来就小，超出部分保持原排序 */
export const RERANK_MAX_DOCUMENTS = 30;
/** 单块送重排的最大字数：块本身约 500 字，截断只是防止异常长块把费用撑爆 */
const MAX_DOC_CHARS = 2_000;
const DASHSCOPE_RERANK_PATH = "/api/v1/services/rerank/text-rerank/text-rerank";

type RerankStyle = "dashscope" | "generic";

interface RerankRow {
  index?: number;
  relevance_score?: number;
  score?: number;
}

export class HttpReranker implements Reranker {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    readonly model: string,
    private readonly style: RerankStyle,
    private readonly timeoutMs: number = 20_000
  ) {}

  async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
    if (documents.length === 0) return [];
    const docs = documents.slice(0, RERANK_MAX_DOCUMENTS).map((text) => text.slice(0, MAX_DOC_CHARS));
    const body =
      this.style === "dashscope"
        ? {
            model: this.model,
            input: { query, documents: docs },
            parameters: { return_documents: false, top_n: docs.length },
          }
        : { model: this.model, query, documents: docs, top_n: docs.length, return_documents: false };

    const timeout = createTimeoutSignal(signal, this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: timeout.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`重排接口返回 ${response.status}：${detail}`);
      }
      const payload = (await response.json()) as { output?: { results?: RerankRow[] }; results?: RerankRow[]; data?: RerankRow[] };
      const rows = payload.output?.results ?? payload.results ?? payload.data;
      if (!Array.isArray(rows)) throw new Error("重排响应缺少 results 数组");
      const scores = new Array<number>(documents.length).fill(0);
      for (const row of rows) {
        const index = Number(row.index);
        if (!Number.isInteger(index) || index < 0 || index >= documents.length) continue;
        const score = Number(row.relevance_score ?? row.score);
        scores[index] = Number.isFinite(score) ? score : 0;
      }
      return scores;
    } finally {
      timeout.dispose();
    }
  }
}

/** DashScope 域名（含 dashscope-intl）走原生 rerank 路径，其它按 OpenAI 兼容的 /rerank 处理 */
export function resolveRerankEndpoint(baseURL: string): { url: string; style: RerankStyle } {
  try {
    const parsed = new URL(baseURL);
    if (/dashscope(-intl)?\.aliyuncs\.com$/i.test(parsed.hostname)) {
      return { url: `${parsed.origin}${DASHSCOPE_RERANK_PATH}`, style: "dashscope" };
    }
  } catch {
    // 地址不合法时下面按通用形状拼，让请求自己报错并带上原文
  }
  return { url: `${baseURL.replace(/\/+$/, "")}/rerank`, style: "generic" };
}

/**
 * 从环境变量构造重排器；RERANK_MODEL 未配返回 undefined（不重排）。
 * 配了模型却缺地址/Key 直接抛错，与 embedding 客户端保持同一口径。
 */
export function createRerankerFromEnv(): Reranker | undefined {
  const model = process.env.RERANK_MODEL?.trim();
  if (!model) return undefined;
  const apiKey = process.env.RERANK_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("已配置 RERANK_MODEL 但缺少 Key：请补 RERANK_API_KEY，或依赖 OPENAI_API_KEY");
  }
  const explicit = process.env.RERANK_BASE_URL?.trim();
  if (explicit) {
    // 显式地址：已经是完整端点（DashScope 原生路径或 .../rerank）就直接用，否则按通用形状补 /rerank
    const isDashScopePath = explicit.includes(DASHSCOPE_RERANK_PATH);
    const isFullEndpoint = isDashScopePath || /\/rerank\/?$/i.test(explicit);
    const url = isFullEndpoint ? explicit : `${explicit.replace(/\/+$/, "")}/rerank`;
    return new HttpReranker(url, apiKey, model, isDashScopePath ? "dashscope" : "generic");
  }
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  if (!baseURL) {
    throw new Error("已配置 RERANK_MODEL 但缺少地址：请补 RERANK_BASE_URL，或依赖 OPENAI_BASE_URL");
  }
  const { url, style } = resolveRerankEndpoint(baseURL);
  return new HttpReranker(url, apiKey, model, style);
}
