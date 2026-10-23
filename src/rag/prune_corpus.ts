// src/rag/prune_corpus.ts
/**
 * 语料清理 CLI：备份 → 按"诈骗语义"分类 → 可选执行删除。
 *
 *   bun run rag:prune              只出报告与备份，一个字都不删
 *   bun run rag:prune --apply      删掉未命中语义的文档（internal 一律删，网页按正文判定）
 *
 * 判定看正文而不是标题：繁体「虛假投資平台名單」这类标题用简体关键词匹配不到，
 * 而正文里有诈骗语义的文档必须留下。备份写在 .rag-cache/backups/（已 gitignore），
 * 恢复用 PgKnowledgeStore.importDocs（JSON 后端没有这个方法）。
 */
import fs from "node:fs";
import path from "node:path";
import { createKnowledgeStore, pgSchemaFromEnv } from "./store_factory";
import { closePgPools, getPool } from "./pg_store";
import { docIsFraudRelated } from "./fraud_terms";

const bodyOf = (doc: { chunks: { text: string }[] }): string => doc.chunks.map((c) => c.text).join(" ");

const apply = process.argv.includes("--apply");
const connectionString = process.env.RAG_PG_URL?.trim();
if (!connectionString) throw new Error("这个 CLI 只针对 PostgreSQL 后端（未配置 RAG_PG_URL）");
const schema = pgSchemaFromEnv();

const store = createKnowledgeStore();
const docs = await store.list();
const chunksOf = (list: typeof docs) => list.reduce((n, d) => n + d.chunks.length, 0);

const keep = docs.filter((d) => d.trust === "web" && docIsFraudRelated(d.title, bodyOf(d)));
const drop = docs.filter((d) => !keep.includes(d));

const dir = path.join(".rag-cache", "backups", new Date().toISOString().slice(0, 10));
fs.mkdirSync(dir, { recursive: true });
const fullFile = path.join(dir, "knowledge-full.json");
fs.writeFileSync(fullFile, JSON.stringify({ exportedAt: new Date().toISOString(), schema, docs }));
fs.writeFileSync(path.join(dir, "knowledge-dropped.json"), JSON.stringify({ schema, docs: drop }));
console.log(`备份：${fullFile}（${docs.length} 文档 / ${chunksOf(docs)} 分片 / ${fs.statSync(fullFile).size} 字节）`);
console.log(`保留：${keep.length} 文档 / ${chunksOf(keep)} 分片`);
console.log(`删除：${drop.length} 文档 / ${chunksOf(drop)} 分片 ← internal ${drop.filter((d) => d.trust === "internal").length} + web ${drop.filter((d) => d.trust === "web").length}`);
console.log("\n--- 将被删除的网页 ---");
for (const d of drop.filter((x) => x.trust === "web")) console.log(`  ${String(d.chunks.length).padStart(3)} 片 ${d.source.slice(0, 96)}`);

if (!apply) {
  console.log("\n没有 --apply：只出报告与备份，未删除。");
  await closePgPools();
  process.exit(0);
}

const pool = getPool(connectionString);
const ids = drop.map((d) => d.id);
let deleted = 0;
for (let i = 0; i < ids.length; i += 200) {
  const batch: string[] = ids.slice(i, i + 200);
  const result = await pool.query(`DELETE FROM ${schema}.docs WHERE id = ANY($1::text[])`, [batch]);
  deleted += result.rowCount ?? 0;
}
// chunks 由 ON DELETE CASCADE 一并删除；revision 自增让常驻进程重建词法与向量索引
await pool.query(
  `INSERT INTO ${schema}.meta (key, value) VALUES ('revision', '1')
     ON CONFLICT (key) DO UPDATE SET value = ((meta.value)::int + 1)::text`
);
const left = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM ${schema}.docs`);
console.log(`\n已删除 ${deleted} 文档；剩余 ${left.rows[0]?.n} 文档；revision 已自增`);
await closePgPools();
process.exit(0);
