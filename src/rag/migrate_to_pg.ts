// src/rag/migrate_to_pg.ts
/**
 * 把 JSON 知识缓存（.rag-cache/knowledge.json + vectors.json）迁入 PostgreSQL。
 * 幂等可重跑：文档/块连同 id、content_hash 原样搬运（不走 merge 重切），向量按 key 原样入库。
 *
 * 前置：.env 配置 RAG_PG_URL（postgres://用户:口令@localhost:5432/库名），可选 RAG_PG_SCHEMA（默认 rag）。
 * 运行：bun run rag:migrate-pg [--json <缓存目录>] [--skip-vectors]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { KnowledgeStore } from "./knowledge_store";
import { PgKnowledgeStore, PgVectorCache, closePgPools } from "./pg_store";
import { DEFAULT_CACHE_DIR, pgSchemaFromEnv } from "./store_factory";

const USAGE = `用法：bun src/rag/migrate_to_pg.ts [--json <缓存目录>] [--skip-vectors]
  --json <目录>    JSON 缓存目录（默认 .rag-cache）
  --skip-vectors   不迁移 vectors.json（迁移后首次检索会自动补 embedding）`;

interface VectorFileV1 {
  version: number;
  model: string;
  dims?: number;
  entries: Record<string, number[]>;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const url = process.env.RAG_PG_URL?.trim();
  if (!url) {
    console.error("未配置 RAG_PG_URL：请在 .env 里加 RAG_PG_URL=postgres://用户:口令@localhost:5432/库名");
    process.exit(1);
  }
  const jsonFlag = argv.indexOf("--json");
  const cacheDir = jsonFlag >= 0 && argv[jsonFlag + 1] ? argv[jsonFlag + 1]! : DEFAULT_CACHE_DIR;
  const skipVectors = argv.includes("--skip-vectors");
  const schema = pgSchemaFromEnv();

  const jsonStore = new KnowledgeStore({ filePath: path.join(cacheDir, "knowledge.json") });
  const docs = await jsonStore.list();
  const chunkCount = docs.reduce((sum, doc) => sum + doc.chunks.length, 0);
  if (docs.length === 0) console.warn(`⚠️  ${path.join(cacheDir, "knowledge.json")} 里没有文档，只建表不搬数据`);

  const pgStore = new PgKnowledgeStore({ connectionString: url, schema });
  try {
    const imported = await pgStore.importDocs(docs);
    console.log(`📥 已迁移 ${imported}/${docs.length} 篇文档、${chunkCount} 个块 → PostgreSQL schema "${schema}"`);

    if (!skipVectors) {
      const vectorFile = path.join(cacheDir, "vectors.json");
      const raw = await fs.readFile(vectorFile, "utf-8").catch(() => undefined);
      if (raw) {
        const parsed = JSON.parse(raw) as VectorFileV1;
        if (parsed.version === 1 && parsed.model && typeof parsed.entries === "object") {
          const vectors = new PgVectorCache({ connectionString: url, schema, model: parsed.model });
          const count = await vectors.importEntries(parsed.entries);
          console.log(`📥 已迁移 ${count} 条向量缓存（模型 ${parsed.model}）`);
        } else {
          console.warn("⚠️  vectors.json 格式不认识，跳过向量迁移（缺的向量检索时会自动补）");
        }
      } else {
        console.log("（没有 vectors.json，跳过向量迁移；缺的向量检索时会自动补）");
      }
    }

    console.log(`\n✅ 完成。rag_search / rag:ingest 现在自动读写 PostgreSQL（RAG_PG_URL）。`);
    console.log(`   回看/修数：psql 里查 ${schema}.docs / ${schema}.chunks / ${schema}.vectors`);
    console.log(`   想回到 JSON 文件：注释掉 .env 里的 RAG_PG_URL 即可，JSON 缓存原样保留。`);
  } finally {
    await closePgPools();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
