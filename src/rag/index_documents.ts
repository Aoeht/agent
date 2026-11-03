import type { KnowledgeDoc } from "./knowledge_store";
import { createEmbeddingClientFromEnv, type EmbeddingClient } from "./embeddings";
import { createKnowledgeStore, createVectorCache, type VectorCacheLike } from "./store_factory";
import { closePgPools } from "./pg_store";

export interface IndexDocumentsOptions {
  embeddings?: EmbeddingClient | null;
  vectorCache?: VectorCacheLike;
  cacheDir?: string;
  signal?: AbortSignal;
}

/** 入库和存量补建共用：已有向量直接复用，失败保留正文，重跑即可补齐。 */
export async function indexDocuments(docs: KnowledgeDoc[], options: IndexDocumentsOptions = {}): Promise<number> {
  const embeddings = options.embeddings === undefined ? createEmbeddingClientFromEnv() : options.embeddings;
  if (!embeddings || docs.length === 0) return 0;
  const cache = options.vectorCache ?? createVectorCache(embeddings, options.cacheDir);
  const texts = [...new Set(docs.flatMap(doc => doc.chunks.map(chunk => chunk.text)))];
  const indexed = await cache.ensure(texts, batch => embeddings.embed(batch, options.signal));
  if (indexed.size !== texts.length) throw new Error(`文档向量不完整：${indexed.size}/${texts.length}，请重试入库或运行 bun run rag:embed`);
  return indexed.size;
}

if (import.meta.main) {
  try {
    const embeddings = createEmbeddingClientFromEnv();
    if (!embeddings) throw new Error("请先配置 EMBEDDING_MODEL，再运行 bun run rag:embed");
    const store = createKnowledgeStore();
    const docs = (await store.list()).filter(doc => store.isFresh(doc));
    const count = await indexDocuments(docs, { embeddings });
    console.log(`向量补建完成：${docs.length} 篇文档，${count} 个唯一文本块（已有向量复用）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await closePgPools();
  }
}
