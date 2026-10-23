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

/**
 * web 来源的存活天数：缺省沿用后端的 7 天（临时缓存语义）。
 * 把官方案例当语料长期留存时，用 AGENT_RAG_TTL_DAYS 显式拉长——
 * 否则下一次写入就会按 TTL 把整批案例扫掉，等于没入库。
 */
function ttlDaysFromEnv(): number | undefined {
  const raw = process.env.AGENT_RAG_TTL_DAYS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const days = Number.parseFloat(raw);
  return Number.isFinite(days) && days > 0 ? days : undefined;
}

export function createKnowledgeStore(options: KnowledgeStoreRuntimeOptions = {}): KnowledgeStoreApi {
  const days = ttlDaysFromEnv();
  const ttlMs = options.ttlMs ?? (days === undefined ? undefined : days * 86_400_000);
  const connectionString = pgUrlFromEnv();
  if (connectionString) {
    return new PgKnowledgeStore({
      connectionString,
      schema: pgSchemaFromEnv(),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(options.maxDocs !== undefined ? { maxDocs: options.maxDocs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
  return new KnowledgeStore({
    filePath: path.join(options.cacheDir ?? DEFAULT_CACHE_DIR, "knowledge.json"),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
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
