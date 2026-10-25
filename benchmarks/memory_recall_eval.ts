import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryRecall, type MemoryRetrievalMode } from "../src/core/memory_recall";
import { LONG_TERM_SUMMARY_PREFIX, SESSION_NAME_PREFIX } from "../src/core/session_store";
import { createEmbeddingClientFromEnv, type EmbeddingClient } from "../src/rag/embeddings";
import { cosineTopK } from "../src/rag/vector_store";
import { cases, sessions, mockVector, type RecallFixtureCase } from "./memory_recall/fixtures";

export interface EvalHit { sessionId: string; summary: string }
export type EvalVariant = "legacy-vector" | "chunk-keyword" | "chunk-vector" | "chunk-hybrid";
export const VARIANTS: EvalVariant[] = ["legacy-vector", "chunk-keyword", "chunk-vector", "chunk-hybrid"];

/** 以实际返回的正文证据打分，仅 sessionId 命中而证据被截掉不算成功。 */
export function scoreCase(fixture: RecallFixtureCase, hits: EvalHit[], k: number) {
  const top = hits.slice(0, k);
  const matches = (hit: EvalHit, expected: RecallFixtureCase["expected"][number]) =>
    [expected.sessionId, ...(expected.alternativeSessionIds ?? [])].includes(hit.sessionId) && hit.summary.includes(expected.evidence);
  const relevant = (hit: EvalHit) => fixture.expected.some(expected => matches(hit, expected));
  const found = fixture.expected.filter(expected => top.some(hit => matches(hit, expected))).length;
  const first = top.findIndex(relevant);
  return {
    recallAtK: fixture.expected.length ? found / fixture.expected.length : null,
    reciprocalRank: fixture.expected.length ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    precisionAtK: fixture.expected.length ? top.filter(relevant).length / k : null,
    falsePositive: fixture.expected.length === 0 && top.length > 0,
    returnedChars: top.reduce((sum, hit) => sum + hit.summary.length, 0),
  };
}

interface CaseResult extends ReturnType<typeof scoreCase> {
  id: string;
  category: string;
  query: string;
  latencyMs: number;
  hits: EvalHit[];
}

export interface VariantResult {
  variant: EvalVariant;
  recallAtK: number;
  mrr: number;
  precisionAtK: number;
  negativeFalsePositiveRate: number;
  averageReturnedChars: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  embeddingRequests: number;
  embeddingTexts: number;
  embeddingErrors: number;
  warmEmbeddingTexts: number;
  cases: CaseResult[];
}

export interface RecallEvalReport {
  fixtureVersion: 1;
  mode: "mock" | "real";
  model: string;
  k: number;
  results: VariantResult[];
}

/** 旧实现基线：每个会话一向量，前 4000 字符索引、前 600 字符注入。 */
function legacyRetriever(embeddings: EmbeddingClient, k: number) {
  const cache = new Map<string, number[]>();
  return async (fixture: RecallFixtureCase): Promise<EvalHit[]> => {
    const query = fixture.query.trim();
    if (!query) return [];
    const candidates = sessions.filter(session => session.id !== fixture.excludeSessionId)
      .map(session => ({ id: session.id, text: session.summaries.at(-1)!.slice(0, 4000) }));
    const texts = [...new Set([query, ...candidates.map(candidate => candidate.text)])].filter(text => !cache.has(text));
    if (texts.length) {
      const vectors = await embeddings.embed(texts);
      texts.forEach((text, index) => { if (vectors[index]) cache.set(text, vectors[index]!); });
    }
    const items = new Map(candidates.flatMap(candidate => cache.has(candidate.text) ? [[candidate.id, cache.get(candidate.text)!] as const] : []));
    const queryVector = cache.get(query);
    if (!queryVector) return [];
    return cosineTopK(queryVector, items, k, 0.35).map(hit => ({
      sessionId: hit.id, summary: candidates.find(candidate => candidate.id === hit.id)!.text.slice(0, 600),
    }));
  };
}

export async function runRecallEval(options: { embeddings?: EmbeddingClient; k?: number } = {}): Promise<RecallEvalReport> {
  const k = options.k ?? 3;
  if (!Number.isSafeInteger(k) || k < 1) throw new Error("k 必须为正整数");
  const embeddings = options.embeddings ?? { model: "synthetic-concept-v1", embed: async (texts: string[]) => texts.map(mockVector) };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-recall-eval-"));
  const sessionDir = path.join(root, "sessions");
  try {
    await fs.mkdir(sessionDir);
    for (const session of sessions) {
      const records = [{ role: "user", content: `${SESSION_NAME_PREFIX}${session.name}` },
        ...session.summaries.map(summary => ({ role: "user", content: `${LONG_TERM_SUMMARY_PREFIX}${summary}` }))];
      await fs.writeFile(path.join(sessionDir, `${session.id}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    }
    const results: VariantResult[] = [];
    for (const variant of VARIANTS) {
      let embeddingRequests = 0;
      let embeddingTexts = 0;
      let embeddingErrors = 0;
      const counting: EmbeddingClient = { model: embeddings.model, embed: async (texts, signal) => {
        embeddingRequests++;
        embeddingTexts += texts.length;
        try { return await embeddings.embed(texts, signal); }
        catch (error) { embeddingErrors++; throw error; }
      } };
      const mode = variant.slice("chunk-".length) as MemoryRetrievalMode;
      const recall = variant === "legacy-vector" ? undefined : new MemoryRecall({
        sessionDir, cacheDir: path.join(root, variant), embeddings: counting, mode, topK: k,
      });
      const retrieve = recall
        ? (fixture: RecallFixtureCase) => recall.recall(fixture.query, { excludeSessionId: fixture.excludeSessionId })
        : legacyRetriever(counting, k);
      const rows: CaseResult[] = [];
      for (const fixture of cases) {
        const start = performance.now();
        const hits = await retrieve(fixture);
        rows.push({ id: fixture.id, category: fixture.category, query: fixture.query,
          latencyMs: performance.now() - start, hits, ...scoreCase(fixture, hits, k) });
      }
      const coldEmbeddingRequests = embeddingRequests;
      const coldEmbeddingTexts = embeddingTexts;
      for (const fixture of cases) await retrieve(fixture);
      const positive = rows.filter(row => row.recallAtK !== null);
      const negative = rows.filter(row => row.recallAtK === null);
      const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      const times = rows.map(row => row.latencyMs).sort((a, b) => a - b);
      results.push({
        variant, recallAtK: avg(positive.map(row => row.recallAtK!)),
        mrr: avg(positive.map(row => row.reciprocalRank!)), precisionAtK: avg(positive.map(row => row.precisionAtK!)),
        negativeFalsePositiveRate: negative.filter(row => row.falsePositive).length / Math.max(1, negative.length),
        averageReturnedChars: avg(rows.map(row => row.returnedChars)), meanLatencyMs: avg(times),
        p95LatencyMs: times[Math.ceil(times.length * 0.95) - 1] ?? 0,
        embeddingRequests: coldEmbeddingRequests, embeddingTexts: coldEmbeddingTexts,
        embeddingErrors,
        warmEmbeddingTexts: embeddingTexts - coldEmbeddingTexts, cases: rows,
      });
    }
    return { fixtureVersion: 1, mode: options.embeddings ? "real" : "mock", model: embeddings.model, k, results };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function renderRecallReport(report: RecallEvalReport): string {
  return [
    "# 记忆召回评测", "", `模式：${report.mode}；模型：${report.model}；K=${report.k}；语料版本：${report.fixtureVersion}。`, "",
    report.mode === "mock" ? "合成概念向量只验证分块、融合和证据注入机制，分数不代表真实 embedding 的语义质量。" : "本报告使用真实 embedding 和合成语料；不等于端到端回答质量评测。", "",
    "| 方案 | 证据 Recall@K | MRR | Precision@K | 负例误召回率 | 平均正文字符 | 平均/p95 ms | 向量请求/文本 | 热缓存新增文本 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.results.map(result => `| ${result.variant} | ${result.recallAtK.toFixed(3)} | ${result.mrr.toFixed(3)} | ${result.precisionAtK.toFixed(3)} | ${result.negativeFalsePositiveRate.toFixed(3)} | ${result.averageReturnedChars.toFixed(0)} | ${result.meanLatencyMs.toFixed(1)}/${result.p95LatencyMs.toFixed(1)} | ${result.embeddingRequests}/${result.embeddingTexts} | ${result.warmEmbeddingTexts} |`),
    "", "Recall/MRR 只统计正例；负例单独统计误召回。证据必须在返回正文中出现，单纯选中会话不算。正文字符不含来源标签；向量请求按客户端 embed 调用计，不含客户端内部 HTTP 分批。旧基线只复现检索与截断逻辑，未复现磁盘索引开销，因此延迟不可用来断言新旧性能优劣。", "",
    `向量错误数：${report.results.map(result => `${result.variant}=${result.embeddingErrors}`).join("，")}。发生错误的结果包含降级行为，不应作为正常模型质量分数。`, "",
    "## 各题证据召回", "", "| 用例 | 类别 | " + report.results.map(result => result.variant).join(" | ") + " |",
    "|---|---|" + report.results.map(() => "---:").join("|") + "|",
    ...cases.map(fixture => `| ${fixture.id} | ${fixture.category} | ${report.results.map(result => {
      const row = result.cases.find(candidate => candidate.id === fixture.id)!;
      return row.recallAtK === null ? (row.falsePositive ? "误召回" : "正确拒绝") : row.recallAtK.toFixed(2);
    }).join(" | ")} |`), "",
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("bun run benchmarks/memory_recall_eval.ts [--mock | --real] [--output work/memory-recall-eval]\n默认 --mock，不联网；--real 使用 EMBEDDING_* 配置并产生调用费用。输出 report.json 与 report.md。");
  } else {
    const outputIndex = args.indexOf("--output");
    const allowed = new Set(["--mock", "--real", "--output"]);
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i]!)) throw new Error(`未知参数 ${args[i]}`);
      if (args[i] === "--output") { if (!args[++i] || args[i]!.startsWith("--")) throw new Error("--output 需要路径"); }
    }
    if (args.includes("--mock") && args.includes("--real")) throw new Error("--mock 与 --real 不能同时使用");
    const embeddings = args.includes("--real") ? createEmbeddingClientFromEnv() : undefined;
    if (args.includes("--real") && !embeddings) throw new Error("--real 需要配置 EMBEDDING_MODEL 与服务地址/Key");
    const report = await runRecallEval(embeddings ? { embeddings } : {});
    const output = path.resolve(outputIndex < 0 ? "work/memory-recall-eval" : args[outputIndex + 1]!);
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await fs.writeFile(path.join(output, "report.md"), renderRecallReport(report));
    console.log(renderRecallReport(report));
    console.log(`报告已保存：${output}`);
    if (report.results.some(result => result.embeddingErrors > 0)) process.exitCode = 1;
  }
}
