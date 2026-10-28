// benchmarks/rag_eval.ts
/**
 * RAG 检索质量评测：recall@{1,3,5} / MRR@5 / groundedness（goldTerms 覆盖率）/ webFallbackRate / 延迟分位。
 *
 * 两种模式：
 *   --self-check（缺省） 密闭自检：fixture 语料 + 假向量/重排/改写，零网络，验证 eval 管线与指标数学；
 *                        全部用例应满分（recall@5=1、groundedness=1），否则管线有问题，退出码 1。
 *   --live               打真实知识库（RAG_PG_URL / .rag-cache）与真实 embedding/rerank/rewrite 服务，
 *                        用 --labels 的 gold 标注衡量检索质量；--compare 一次跑 rerank/rewrite 四象限对照。
 *
 * 输出（--output 目录，缺省 work/rag-eval）：report.json（机器可读）、report.md（人读表格）、runs.jsonl（逐例明细，可复现）。
 * 运行：bun run benchmarks/rag_eval.ts [--self-check|--live] [--labels <path>] [--output <dir>]
 *       [--compare] [--rerank|--no-rerank] [--rewrite|--no-rewrite] [--limit <n>]
 */
import fs from "node:fs";
import path from "node:path";
import { createRagSearchTool } from "../src/tools/rag_search";
import { EmbeddingClient, createEmbeddingClientFromEnv } from "../src/rag/embeddings";
import { createRerankerFromEnv } from "../src/rag/rerank";
import { createQueryRewriterFromEnv } from "../src/rag/rewrite";
import { VectorCache } from "../src/rag/vector_store";
import { createKnowledgeStore, createVectorCache } from "../src/rag/store_factory";
import type { KnowledgeStoreApi } from "../src/rag/knowledge_store";
import type { QueryRewriter } from "../src/rag/rewrite";
import type { Reranker } from "../src/rag/rerank";
import { FIXTURE_CASES, createFixtureStore, makeFakeEmbeddings, makeFakeReranker, makeFakeRewriter } from "./rag/fixture";

interface LabelCase {
  id: string;
  query: string;
  goldSources: string[];
  goldTerms: string[];
  notes?: string;
}

interface LabelFile {
  version: number;
  cases: LabelCase[];
}

interface RagOutput {
  result_count: number;
  results: Array<{ content: string; source: string; chunk_id: string }>;
  rewritten_query?: string;
  rewrite_error?: string;
  rerank_model?: string;
  rerank_error?: string;
  vector_search_error?: string;
  web_search_error?: string;
}

interface CaseResult {
  id: string;
  query: string;
  /** 每个返回位置是否命中 gold 来源（1-based） */
  goldHits: boolean[];
  recall: { k1: number; k3: number; k5: number };
  mrr: number;
  groundedness: { matched: string[]; missing: string[]; ratio: number };
  webFallback: boolean;
  vectorError: boolean;
  errors: string[];
  latency_ms: number;
}

interface VariantMetrics {
  name: string;
  cases: number;
  recall1: number;
  recall3: number;
  recall5: number;
  mrr: number;
  groundedness: number;
  fullyGroundedRate: number;
  webFallbackRate: number;
  vectorErrorRate: number;
  p50_ms: number;
  p95_ms: number;
}

interface VariantConfig {
  name: string;
  rerank: boolean;
  rewrite: boolean;
}

interface EvalContext {
  store: KnowledgeStoreApi;
  embeddings: EmbeddingClient | undefined;
  reranker: Reranker | null;
  rewriter: QueryRewriter | null;
  vectorModel: string;
  rootDir: string;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/** gold 来源匹配：小写化后双向子串（gold 可以是完整 URL、域名片段或路径尾巴） */
function sourceMatches(gold: string, source: string): boolean {
  const g = gold.toLowerCase();
  const s = source.toLowerCase();
  return s.includes(g) || g.includes(s);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function aggregate(name: string, cases: CaseResult[]): VariantMetrics {
  const n = cases.length || 1;
  const latencies = cases.map((c) => c.latency_ms);
  return {
    name,
    cases: cases.length,
    recall1: cases.reduce((s, c) => s + c.recall.k1, 0) / n,
    recall3: cases.reduce((s, c) => s + c.recall.k3, 0) / n,
    recall5: cases.reduce((s, c) => s + c.recall.k5, 0) / n,
    mrr: cases.reduce((s, c) => s + c.mrr, 0) / n,
    groundedness: cases.reduce((s, c) => s + c.groundedness.ratio, 0) / n,
    fullyGroundedRate: cases.filter((c) => c.groundedness.missing.length === 0).length / n,
    webFallbackRate: cases.filter((c) => c.webFallback).length / n,
    vectorErrorRate: cases.filter((c) => c.vectorError).length / n,
    p50_ms: Math.round(percentile(latencies, 50)),
    p95_ms: Math.round(percentile(latencies, 95)),
  };
}

/** 跑单个用例并计算指标；top_k 固定 5（schema 上限），k=1/3/5 从同一份排序里切 */
async function runCase(tool: ReturnType<typeof createRagSearchTool>, label: LabelCase): Promise<CaseResult> {
  const started = performance.now();
  let output: RagOutput;
  let executionError: string | undefined;
  try {
    output = (await tool.execute({ query: label.query, top_k: 5, use_cache: true })) as RagOutput;
  } catch (error) {
    output = { result_count: 0, results: [] };
    executionError = error instanceof Error ? error.message : String(error);
  }
  const latency = performance.now() - started;

  const goldHits = output.results.map((r) => label.goldSources.some((g) => sourceMatches(g, r.source)));
  const recallAt = (k: number) => {
    const top = new Set(output.results.slice(0, k).map((r) => r.source));
    const hit = label.goldSources.filter((g) => [...top].some((s) => sourceMatches(g, s))).length;
    return Math.min(1, hit / (label.goldSources.length || 1));
  };
  const firstGoldRank = goldHits.findIndex((hit) => hit);
  const haystack = output.results.map((r) => r.content).join("\n").toLowerCase();
  const matched = label.goldTerms.filter((t) => haystack.includes(t.toLowerCase()));
  const missing = label.goldTerms.filter((t) => !matched.includes(t));

  const errors = [
    output.rewrite_error ? `rewrite: ${output.rewrite_error}` : undefined,
    output.rerank_error ? `rerank: ${output.rerank_error}` : undefined,
    output.vector_search_error ? `vector: ${output.vector_search_error}` : undefined,
    output.web_search_error ? `web: ${output.web_search_error}` : undefined,
    executionError ? `execute: ${executionError}` : undefined,
  ].filter((e): e is string => e !== undefined);

  return {
    id: label.id,
    query: label.query,
    goldHits,
    recall: { k1: recallAt(1), k3: recallAt(3), k5: recallAt(5) },
    mrr: firstGoldRank >= 0 ? 1 / (firstGoldRank + 1) : 0,
    groundedness: { matched, missing, ratio: label.goldTerms.length === 0 ? 1 : matched.length / label.goldTerms.length },
    webFallback: output.web_search_error !== undefined,
    vectorError: output.vector_search_error !== undefined,
    errors,
    latency_ms: Number(latency.toFixed(1)),
  };
}

/** 按变体构造工具：self-check 用 fixture + 假客户端，live 按环境变量接真实服务（缺的通道记警告后关闭） */
async function buildContext(variant: VariantConfig, mode: "self-check" | "live", rootDir: string): Promise<EvalContext> {
  if (mode === "self-check") {
    const store = await createFixtureStore(rootDir);
    const embeddings = makeFakeEmbeddings();
    return {
      store,
      embeddings,
      reranker: variant.rerank ? makeFakeReranker() : null,
      rewriter: variant.rewrite ? makeFakeRewriter() : null,
      vectorModel: embeddings.model,
      rootDir,
    };
  }
  const store = createKnowledgeStore();
  let embeddings;
  try {
    embeddings = createEmbeddingClientFromEnv();
  } catch (error) {
    console.warn(`⚠ 语义通道不可用（${error instanceof Error ? error.message : error}），本次按纯词法评测`);
    embeddings = undefined;
  }
  let reranker: Reranker | null = null;
  if (variant.rerank) {
    reranker = createRerankerFromEnv() ?? null;
    if (!reranker) console.warn("⚠ 未配置 RERANK_MODEL，rerank 变体按无重排跑");
  }
  let rewriter: QueryRewriter | null = null;
  if (variant.rewrite) {
    const model = process.env.AGENT_RAG_REWRITE_MODEL?.trim() || process.env.AGENT_SUMMARY_MODEL?.trim();
    rewriter = model ? (createQueryRewriterFromEnv({ model }) ?? null) : null;
    if (!rewriter) console.warn("⚠ 没有可用的改写模型（AGENT_RAG_REWRITE_MODEL / AGENT_SUMMARY_MODEL），rewrite 变体按原查询跑");
  }
  return {
    store,
    embeddings,
    reranker,
    rewriter,
    vectorModel: embeddings?.model ?? "(纯词法)",
    rootDir,
  };
}

async function runVariant(
  variant: VariantConfig,
  labels: LabelCase[],
  mode: "self-check" | "live",
  rootDir: string
): Promise<{ metrics: VariantMetrics; cases: CaseResult[]; runs: object[] }> {
  const context = await buildContext(variant, mode, rootDir);
  const tool = createRagSearchTool({
    store: context.store,
    ...(context.embeddings
      ? {
          embeddings: context.embeddings,
          vectorCache:
            mode === "self-check"
              ? new VectorCache({ filePath: path.join(rootDir, "vectors.json"), model: context.vectorModel })
              : createVectorCache(context.embeddings),
        }
      : {}),
    reranker: variant.rerank ? context.reranker : null,
    rewriter: variant.rewrite ? context.rewriter : null,
    // 评测只考本地检索质量：联网一律拒绝，每次触发都会在结果里留下 web_search_error 供统计
    webSearch: async () => {
      throw new Error("eval 禁网：本地语料不足以填满 top_k");
    },
  });

  const cases: CaseResult[] = [];
  const runs: object[] = [];
  for (const label of labels) {
    const result = await runCase(tool, label);
    cases.push(result);
    runs.push({ variant: variant.name, ...result });
  }
  return { metrics: aggregate(variant.name, cases), cases, runs };
}

function renderMarkdown(mode: string, corpus: string, metrics: VariantMetrics[], cases: CaseResult[]): string {
  const lines: string[] = [
    `# RAG 检索评测（${mode}）`,
    "",
    `- 语料：${corpus}`,
    `- 用例数：${metrics[0]?.cases ?? 0}（gold 标注见 labels；recall/MRR 基于 gold 来源命中，groundedness 为 goldTerms 在返回内容中的覆盖率）`,
    `- 生成时间：${new Date().toISOString()}`,
    "",
    "## 变体对照",
    "",
    "| 变体 | recall@1 | recall@3 | recall@5 | MRR@5 | groundedness | 全覆盖 | 联网兜底 | 向量故障 | p50 | p95 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const m of metrics) {
    lines.push(
      `| ${m.name} | ${(m.recall1 * 100).toFixed(0)}% | ${(m.recall3 * 100).toFixed(0)}% | ${(m.recall5 * 100).toFixed(0)}% | ${m.mrr.toFixed(3)} | ${(m.groundedness * 100).toFixed(0)}% | ${(m.fullyGroundedRate * 100).toFixed(0)}% | ${(m.webFallbackRate * 100).toFixed(0)}% | ${(m.vectorErrorRate * 100).toFixed(0)}% | ${m.p50_ms}ms | ${m.p95_ms}ms |`
    );
  }
  lines.push("", "## 逐例明细（第一个变体）", "", "| 用例 | recall@5 | MRR | groundedness | 缺失术语 | 错误 | 延迟 |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cases) {
    lines.push(
      `| ${c.id} | ${(c.recall.k5 * 100).toFixed(0)}% | ${c.mrr.toFixed(2)} | ${(c.groundedness.ratio * 100).toFixed(0)}% | ${c.groundedness.missing.join("、") || "-"} | ${c.errors.join("；") || "-"} | ${c.latency_ms}ms |`
    );
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args["live"] ? "live" : "self-check";
  const outputDir = typeof args["output"] === "string" ? (args["output"] as string) : "work/rag-eval";
  const rootDir = path.resolve(".sand-box/.tmp-rag-eval");
  await fs.promises.rm(rootDir, { recursive: true, force: true });
  await fs.promises.mkdir(rootDir, { recursive: true });
  await fs.promises.mkdir(outputDir, { recursive: true });

  const limit = typeof args["limit"] === "string" ? Number.parseInt(args["limit"] as string, 10) : undefined;

  let labels: LabelCase[];
  let corpus: string;
  if (mode === "self-check") {
    labels = [...FIXTURE_CASES];
    corpus = "内置 fixture 语料（8 篇反诈主题文档，密闭无网络）";
  } else {
    const labelsPath = typeof args["labels"] === "string" ? (args["labels"] as string) : "benchmarks/rag/labels.json";
    const parsed = JSON.parse(await fs.promises.readFile(labelsPath, "utf8")) as LabelFile;
    labels = parsed.cases;
    corpus = `store_factory 默认后端（RAG_PG_URL 配置时为 PostgreSQL，否则 .rag-cache JSON）；labels: ${labelsPath}`;
  }
  if (limit !== undefined && Number.isFinite(limit)) labels = labels.slice(0, limit);

  // 变体：--compare 跑四象限（基线 / 只改写 / 只重排 / 全开）；否则按开关跑单个配置
  const rerankFlag = args["no-rerank"] ? false : args["rerank"] ? true : undefined;
  const rewriteFlag = args["no-rewrite"] ? false : args["rewrite"] ? true : undefined;
  const variants: VariantConfig[] = args["compare"]
    ? [
        { name: "baseline（无改写无重排）", rerank: false, rewrite: false },
        { name: "rewrite only", rerank: false, rewrite: true },
        { name: "rerank only", rerank: true, rewrite: false },
        { name: "full（改写+重排）", rerank: true, rewrite: true },
      ]
    : [{ name: "full（改写+重排）", rerank: rerankFlag ?? true, rewrite: rewriteFlag ?? true }];

  const allRuns: object[] = [];
  const metrics: VariantMetrics[] = [];
  let firstCases: CaseResult[] = [];
  for (const variant of variants) {
    const { metrics: m, cases, runs } = await runVariant(variant, labels, mode, rootDir);
    metrics.push(m);
    allRuns.push(...runs);
    if (firstCases.length === 0) firstCases = cases;
    console.log(`✔ ${variant.name}: recall@5=${(m.recall5 * 100).toFixed(0)}% groundedness=${(m.groundedness * 100).toFixed(0)}% web兜底=${(m.webFallbackRate * 100).toFixed(0)}%`);
  }

  await fs.promises.writeFile(path.join(outputDir, "report.json"), JSON.stringify({ mode, corpus, metrics }, null, 2) + "\n");
  await fs.promises.writeFile(path.join(outputDir, "report.md"), renderMarkdown(mode, corpus, metrics, firstCases));
  await fs.promises.writeFile(path.join(outputDir, "runs.jsonl"), allRuns.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`报告已写入 ${outputDir}/report.{json,md} 与 runs.jsonl`);

  // 自检红线：fixture + 满配应当全量命中、术语全覆盖 —— 管线或语料被改坏时在这里炸。
  // fixture 语料很小，特定查询填不满 top_k=5 会触发联网兜底（语料贫瘠的预期行为），因此不卡 webFallbackRate
  if (mode === "self-check") {
    const primary = metrics[0]!;
    const failures: string[] = [];
    if (primary.recall5 < 1) failures.push(`recall@5=${primary.recall5}`);
    if (primary.groundedness < 1) failures.push(`groundedness=${primary.groundedness}`);
    if (failures.length > 0) {
      console.error(`❌ self-check 未达红线：${failures.join("；")}`);
      process.exitCode = 1;
    } else {
      console.log(
        `✅ self-check 全部用例 recall@5=1、groundedness=1（联网兜底 ${(primary.webFallbackRate * 100).toFixed(0)}%，语料填不满 top_k 时属预期）`
      );
    }
  }
  await fs.promises.rm(rootDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("EVAL CRASHED:", error);
  process.exitCode = 1;
});
