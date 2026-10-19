// src/rag/store_factory.ts
/**
 * 知识库与向量缓存的后端选择：RAG_PG_URL 配置了就走 PostgreSQL（pg_store.ts），
 * 否则用 JSON 文件（knowledge_store.ts / vector_store.ts）。两个后端同接口，上层无感知。
 */
import path from "node:path";
import { EmbeddingClient } from "./embeddings";
import { KnowledgeStore, KnowledgeStoreApi } from "./knowledge_store";
import { PgKnowledgeStore, PgVectorCache } from "./pg_store";
import { VectorCache } from "./vector_store";

export const DEFAULT_CACHE_DIR = path.join(process.cwd(), ".rag-cache");

export function pgUrlFromEnv(): string | undefined {
  const url = process.env.RAG_PG_URL?.trim();
  return url ? url : undefined;
}

export function pgSchemaFromEnv(): string {
  return process.env.RAG_PG_SCHEMA?.trim() || "rag";
}

export interface KnowledgeStoreRuntimeOptions {
  cacheDir?: string;
  ttlMs?: number;
  maxDocs?: number;
  now?: () => number;
}

export function createKnowledgeStore(options: KnowledgeStoreRuntimeOptions = {}): KnowledgeStoreApi {
  const connectionString = pgUrlFromEnv();
  if (connectionString) {
    return new PgKnowledgeStore({
      connectionString,
      schema: pgSchemaFromEnv(),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.maxDocs !== undefined ? { maxDocs: options.maxDocs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
  return new KnowledgeStore({
    filePath: path.join(options.cacheDir ?? DEFAULT_CACHE_DIR, "knowledge.json"),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.maxDocs !== undefined ? { maxDocs: options.maxDocs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/** 两个后端都有同一 ensure() 契约，rag_search 只依赖这个形状 */
export type VectorCacheLike = VectorCache | PgVectorCache;

export function createVectorCache(embeddings: EmbeddingClient, cacheDir?: string): VectorCacheLike {
  const connectionString = pgUrlFromEnv();
  if (connectionString) {
    return new PgVectorCache({ connectionString, schema: pgSchemaFromEnv(), model: embeddings.model });
  }
  return new VectorCache({ filePath: path.join(cacheDir ?? DEFAULT_CACHE_DIR, "vectors.json"), model: embeddings.model });
}
