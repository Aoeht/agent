// src/rag/embeddings.ts
/**
 * 语义检索的 embedding 客户端：走 OpenAI 兼容 /embeddings 接口，默认复用模型服务的地址与 Key。
 *
 * 环境变量（均可选；EMBEDDING_MODEL 是语义检索的总开关，不配则 rag_search 保持纯 BM25）：
 *   EMBEDDING_MODEL      向量模型名（如 DashScope qwen3.7-text-embedding-flash、智谱 embedding-3），配了才启用语义通道
 *   EMBEDDING_BASE_URL   向量服务地址（以 /v1 结尾），缺省用 OPENAI_BASE_URL
 *   EMBEDDING_API_KEY    向量服务 Key，缺省用 OPENAI_API_KEY
 *   EMBEDDING_DIMENSIONS 输出维度（qwen/embedding-3 均支持 256~1024+），缺省用模型默认；调小可显著省缓存体积
 *   EMBEDDING_BATCH      单请求最大条数，缺省 20（DashScope 上限 20/25，OpenAI 官方可到 2048，可调大省请求数）
 */
import OpenAI from "openai";

export interface EmbeddingClient {
  /** 模型名参与向量缓存的 key：换模型旧向量自动失效，不需要手动清理 */
  readonly model: string;
  /** 输出顺序与输入一一对应；单请求条数上限由实现内部分批，调用方无需关心 */
  embed(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}

export class OpenAICompatibleEmbeddings implements EmbeddingClient {
  /** 单请求最大条数：默认 20 兼容 DashScope（text-embedding 上限 20、flash 25），其它服务商可用 EMBEDDING_BATCH 调大 */
  static readonly DEFAULT_BATCH = 20;

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly dimensions?: number,
    private readonly batchSize: number = OpenAICompatibleEmbeddings.DEFAULT_BATCH
  ) {}

  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      const response = await this.client.embeddings.create(
        {
          model: this.model,
          input: batch,
          ...(this.dimensions !== undefined ? { dimensions: this.dimensions } : {}),
        },
        signal ? { signal } : undefined
      );
      // 兼容服务的 data 顺序不可靠时只能整体重排，这里按约定：正常实现保证与输入同序
      for (const item of response.data) vectors.push(item.embedding);
    }
    return vectors;
  }
}

/** 从环境变量构造客户端；EMBEDDING_MODEL 未配返回 undefined，配了但缺地址/Key 直接抛错（配置错误应当面暴露） */
export function createEmbeddingClientFromEnv(): EmbeddingClient | undefined {
  const model = process.env.EMBEDDING_MODEL?.trim();
  if (!model) return undefined;
  const baseURL = process.env.EMBEDDING_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim();
  const apiKey = process.env.EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!baseURL || !apiKey) {
    throw new Error(
      "已配置 EMBEDDING_MODEL 但缺少向量服务地址/Key：请补 EMBEDDING_BASE_URL 与 EMBEDDING_API_KEY，或依赖 OPENAI_BASE_URL/OPENAI_API_KEY"
    );
  }
  const raw = process.env.EMBEDDING_DIMENSIONS?.trim();
  const dimensions = raw ? Number.parseInt(raw, 10) : undefined;
  const rawBatch = process.env.EMBEDDING_BATCH?.trim();
  const batchSize = rawBatch ? Number.parseInt(rawBatch, 10) : undefined;
  const client = new OpenAI({ baseURL, apiKey, maxRetries: 1, timeout: 60_000 });
  return new OpenAICompatibleEmbeddings(
    client,
    model,
    dimensions !== undefined && Number.isFinite(dimensions) ? dimensions : undefined,
    batchSize !== undefined && Number.isFinite(batchSize) && batchSize > 0 ? batchSize : undefined
  );
}
