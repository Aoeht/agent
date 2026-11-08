// src/tools/record_pattern.ts
/**
 * 反诈经验库沉淀工具：把 scanner 报告里的 novel_pattern（或主对话提炼的新套路）落成经验话术卡。
 *
 * 闭环纪律（对齐 Hermes 式自学习 agent 的防毒设计）：
 * 1. 单视频只进"草稿"层（可检索，标题带【草稿】标记，scanner 应把它当线索而非结论）；
 * 2. 同名或语义相似（向量余弦 ≥ 阈值；无 embedding 时退化为词元 Jaccard）的记录合并进同一套路，
 *    不同来源视频数 ≥ promoteThreshold 或人工 confirm 才"转正"进正式层；
 * 3. 与策展层（docs/反诈话术卡）语义高度相似的直接判"既知手法"，不入库，防止重复沉淀；
 * 4. 每张卡带来源与证据（BV + 摘录 + 日期），可追溯、可审计；
 * 5. 转正后建议跑 rag_eval 回归，确认经验库变更没有拉低既有检索质量。
 */
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { ToolDefinition, defineTool } from "../core/types";
import { collectSections, ingestPaths } from "../rag/ingest";
import { createKnowledgeStore, createVectorCache, type VectorCacheLike } from "../rag/store_factory";
import { createEmbeddingClientFromEnv, type EmbeddingClient } from "../rag/embeddings";
import { tokenize } from "../rag/tokenizer";
import { KnowledgeStoreApi } from "../rag/knowledge_store";

export const DEFAULT_EXPERIENCE_DIR = path.join(process.cwd(), "docs", "反诈经验库");
export const DEFAULT_CURATED_DIR = path.join(process.cwd(), "docs", "反诈话术卡");
/** 状态文件记录每个套路的来源/计数/状态；.json 不参与 ingest（walk 只收 md/txt），是纯元数据 */
const STATE_FILE = "状态.json";

const PatternDraftSchema = z
  .object({
    bv: z.string().trim().min(1, "bv 不能为空").max(64).describe("来源视频号（或其它稳定来源 ID）"),
    name: z.string().trim().min(2, "name 至少 2 字").max(60).describe("套路名，简短稳定（同名记录会合并到同一张卡）"),
    scripts: z.array(z.string().trim().min(1).max(200)).max(10).default([]).describe("典型话术，用视频里的原话/字幕摘录"),
    signals: z.array(z.string().trim().min(1).max(200)).max(10).default([]).describe("风险信号（画面/评论/链接/行为）"),
    points: z.array(z.string().trim().min(1).max(200)).max(10).default([]).describe("判定要点，可省略"),
    evidence: z.string().trim().max(1000).optional().describe("本次命中证据摘录：时间戳 + 原文，供溯源审计"),
    confirm: z.boolean().default(false).describe("人工已确认该套路真实存在：跳过独立视频数门槛立即转正"),
  })
  .refine((d) => d.scripts.length + d.signals.length > 0, { message: "scripts 与 signals 至少给一项" });

export type RecordPatternParams = z.output<typeof PatternDraftSchema>;

interface PatternSource {
  bv: string;
  at: string;
  evidence?: string;
}

interface PatternRecord {
  name: string;
  status: "草稿" | "正式";
  scripts: string[];
  signals: string[];
  points: string[];
  sources: PatternSource[];
  promotedAt?: string;
  updatedAt: string;
}

interface ExpState {
  version: 1;
  patterns: Record<string, PatternRecord>;
}

export interface RecordPatternOptions {
  /** 显式注入知识库后端（测试）；缺省按 RAG_PG_URL 选择 */
  store?: KnowledgeStoreApi;
  /** 经验库目录；缺省 docs/反诈经验库（草稿/ 与 正式/ 两个子层） */
  expDir?: string;
  /** 策展话术卡目录（既知手法查重用）；缺省 docs/反诈话术卡 */
  curatedDir?: string;
  /** 语义查重客户端；显式传 null 强制退化为精确同名 + 词元 Jaccard */
  embeddings?: EmbeddingClient | null;
  mainModel?: string;
  vectorCache?: VectorCacheLike;
  cacheDir?: string;
  /** 不同来源视频数达到该值自动转正；缺省 3 */
  promoteThreshold?: number;
  /**
   * 经验库内合并的余弦阈值；缺省 0.75。
   * flash 实测（2026-11-08）：同套路换说法 0.78~0.84，不同套路 0.55~0.60。
   */
  similarityThreshold?: number;
  /**
   * 与策展话术卡判"既知手法"的余弦阈值；缺省 0.62。
   * 草稿短、官方卡长，长度不对称压低余弦：既知变体实测 0.64，不同套路 0.40~0.56。
   */
  curatedSimilarityThreshold?: number;
  now?: () => number;
}

const COSINE_EPSILON = 1e-9;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < COSINE_EPSILON ? 0 : dot / denom;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

const union = (existing: string[], incoming: string[], cap = 12): string[] => {
  const seen = new Set(existing);
  return [...existing, ...incoming.filter((item) => !seen.has(item) && seen.add(item))].slice(0, cap);
};

/** Windows 非法文件名字符替换；点结尾也去掉 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/, "").trim() || "未命名套路";
}

function patternText(rec: { name: string; scripts: string[]; signals: string[]; points: string[] }): string {
  return (
    `${rec.name}\n` +
    (rec.scripts.length ? `典型话术：${rec.scripts.join("；")}\n` : "") +
    (rec.signals.length ? `风险信号：${rec.signals.join("；")}\n` : "") +
    (rec.points.length ? `判定要点：${rec.points.join("；")}` : "")
  ).trim();
}

function cardBody(rec: PatternRecord): string {
  const lines: string[] = [`# ${rec.status === "草稿" ? "【草稿】" : ""}${rec.name}`, ""];
  if (rec.scripts.length) lines.push("## 典型话术", ...rec.scripts.map((s) => `- ${s}`), "");
  if (rec.signals.length) lines.push("## 风险信号", ...rec.signals.map((s) => `- ${s}`), "");
  if (rec.points.length) lines.push("## 判定要点", ...rec.points.map((s) => `- ${s}`), "");
  lines.push("## 来源与证据");
  for (const src of rec.sources) lines.push(`- ${src.at.slice(0, 10)} ${src.bv}${src.evidence ? `：${src.evidence}` : ""}`);
  if (rec.status === "草稿") {
    lines.push("", "> 草稿：scanner 报告自动沉淀、未经确认，仅作检索线索不作定性依据；独立来源视频数达标或人工确认后转正。");
  }
  return lines.join("\n");
}

function cardFile(expDir: string, rec: { name: string; status: string }): string {
  return rec.status === "草稿" ? path.join(expDir, "草稿", `${safeFileName(rec.name)}.md`) : path.join(expDir, "正式", `${safeFileName(rec.name)}.md`);
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

async function readState(expDir: string): Promise<ExpState> {
  try {
    const raw = await fs.readFile(path.join(expDir, STATE_FILE), "utf-8");
    const parsed = JSON.parse(raw) as ExpState;
    return parsed && typeof parsed === "object" && parsed.patterns ? parsed : { version: 1, patterns: {} };
  } catch {
    return { version: 1, patterns: {} };
  }
}

async function writeState(expDir: string, state: ExpState): Promise<void> {
  await writeFileAtomic(path.join(expDir, STATE_FILE), JSON.stringify(state, null, 2));
}

export function createRecordPatternTool(options: RecordPatternOptions = {}): ToolDefinition {
  const expDir = options.expDir ?? DEFAULT_EXPERIENCE_DIR;
  const curatedDir = options.curatedDir ?? DEFAULT_CURATED_DIR;
  const promoteThreshold = options.promoteThreshold ?? 3;
  const similarityThreshold = options.similarityThreshold ?? 0.75;
  const curatedSimilarityThreshold = options.curatedSimilarityThreshold ?? 0.62;
  const now = options.now ?? Date.now;
  const store = options.store ?? createKnowledgeStore();
  const embeddings =
    options.embeddings === undefined ? createEmbeddingClientFromEnv({ mainModel: options.mainModel }) : options.embeddings;
  const vectors = embeddings ? (options.vectorCache ?? createVectorCache(embeddings, options.cacheDir)) : undefined;
  const writeChain: { current: Promise<unknown> } = { current: Promise.resolve() };

  /** 卡片文本批量取向量：走共享向量缓存，稳定文本不重复编码 */
  async function embedAll(texts: string[], errors: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    if (!embeddings || !vectors || texts.length === 0) return result;
    try {
      const embedded = await vectors.ensure([...new Set(texts)], (batch) => embeddings.embed(batch));
      for (const text of texts) {
        const vector = embedded.get(text);
        if (vector) result.set(text, vector);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      errors.push(`语义查重降级为词法（向量服务失败：${error instanceof Error ? error.message : String(error)}）`);
    }
    return result;
  }

  const buildResult = (
    status: string,
    rec: PatternRecord | undefined,
    matched: { name: string; similarity: number } | undefined,
    state: ExpState,
    warnings: string[],
    promoted: boolean
  ) => ({
    status,
    ...(rec ? { pattern: { name: rec.name, card_status: rec.status, source_videos: new Set(rec.sources.map((s) => s.bv)).size, recorded_sources: rec.sources.length } } : {}),
    ...(matched ? { matched_pattern: matched } : {}),
    library: {
      draft: Object.values(state.patterns).filter((p) => p.status === "草稿").length,
      formal: Object.values(state.patterns).filter((p) => p.status === "正式").length,
    },
    ...(warnings.length ? { warnings } : {}),
    ...(promoted ? { hint: "已转正：建议运行 bun benchmarks/rag_eval.ts --live 确认经验库变更没有拉低既有检索指标" } : {}),
  });

  return defineTool({
    name: "record_pattern",
    schema: PatternDraftSchema,
    parallelSafe: true,
    needsReconciliation: false,
    description:
      "把审查中发现的疑似新型诈骗套路沉淀进反诈经验库（docs/反诈经验库）。适用：scanner 报告含 novel_pattern 字段，" +
      "或主对话确认某视频的话术在 rag_search 对照中没有既知手法覆盖。同名/语义相似的记录自动合并，不同来源视频数达标" +
      "（或 confirm=true 人工确认）才从草稿转正；单视频经验永远是草稿层，防止误报污染知识库。name 请给简短稳定的手法名，" +
      "scripts/signals 尽量用视频里的原话摘录，evidence 带 BV+时间戳。",
    execute: async (params: RecordPatternParams) => {
      const run = writeChain.current.then(async () => {
        const warnings: string[] = [];
        const state = await readState(expDir);

        // 文件是卡片存在的最终事实：被人工删掉文件的套路，状态条目随之清理
        for (const [name, rec] of Object.entries(state.patterns)) {
          const exists = await fs.stat(cardFile(expDir, rec)).then(() => true, () => false);
          if (!exists) delete state.patterns[name];
        }

        // 1. 精确同名合并（name 是主对话选定的语义键，最可靠）
        let target: PatternRecord | undefined = state.patterns[params.name];
        let matched: { name: string; similarity: number } | undefined;

        // 2. 语义查重：与经验库现有套路 + 策展话术卡分别比对
        const draftText = patternText({ name: params.name, scripts: params.scripts, signals: params.signals, points: params.points });
        if (!target && embeddings && vectors) {
          const [draftVectorMap, expVectorMap] = await Promise.all([
            embedAll([draftText], warnings),
            embedAll(Object.values(state.patterns).map((p) => patternText(p)), warnings),
          ]);
          const draftVector = draftVectorMap.get(draftText);
          if (draftVector) {
            let best: { rec: PatternRecord; similarity: number } | undefined;
            for (const rec of Object.values(state.patterns)) {
              const vector = expVectorMap.get(patternText(rec));
              if (!vector) continue;
              const similarity = cosine(draftVector, vector);
              if (!best || similarity > best.similarity) best = { rec, similarity };
            }
            if (best && best.similarity >= similarityThreshold) {
              target = best.rec;
              matched = { name: best.rec.name, similarity: Number(best.similarity.toFixed(3)) };
            }
          }
        } else if (!target && !embeddings) {
          // 无向量通道的退化查重：词元 Jaccard（同名精确匹配在上面已处理）
          const draftTokens = tokenize(draftText);
          let best: { rec: PatternRecord; similarity: number } | undefined;
          for (const rec of Object.values(state.patterns)) {
            const similarity = jaccard(draftTokens, tokenize(patternText(rec)));
            if (!best || similarity > best.similarity) best = { rec, similarity };
          }
          if (best && best.similarity >= 0.5) {
            target = best.rec;
            matched = { name: best.rec.name, similarity: Number(best.similarity.toFixed(3)) };
          }
        }

        if (!target && embeddings && vectors) {
          // 策展层查重：高相似说明这是既知手法的变体，不重复沉淀
          const curated = await collectSections([curatedDir], {}).catch(() => ({ sections: [], issues: [] }));
          if (curated.sections.length > 0) {
            const curatedVectorMap = await embedAll(curated.sections.map((s) => `${s.title}\n${s.body}`), warnings);
            const draftVector = (await embedAll([draftText], warnings)).get(draftText);
            if (draftVector) {
              let best: { title: string; similarity: number } | undefined;
              for (const section of curated.sections) {
                const vector = curatedVectorMap.get(`${section.title}\n${section.body}`);
                if (!vector) continue;
                const similarity = cosine(draftVector, vector);
                if (!best || similarity > best.similarity) best = { title: section.title, similarity };
              }
              if (best && best.similarity >= curatedSimilarityThreshold) {
                return buildResult("known", undefined, { name: best.title.split(" / ")[0]!, similarity: Number(best.similarity.toFixed(3)) }, state, warnings, false);
              }
            }
          }
        }

        const at = new Date(now()).toISOString();
        let promoted = false;
        let createdNew = false;
        if (target) {
          // 合并：字段并集 + 来源追加；不同来源视频数达标或人工确认 → 转正
          const oldFile = cardFile(expDir, target);
          target.scripts = union(target.scripts, params.scripts);
          target.signals = union(target.signals, params.signals);
          target.points = union(target.points, params.points);
          if (!target.sources.some((s) => s.bv === params.bv)) {
            target.sources.push({ ...(params.evidence ? { evidence: params.evidence } : {}), bv: params.bv, at });
          }
          target.updatedAt = at;
          const distinctVideos = new Set(target.sources.map((s) => s.bv)).size;
          if (target.status === "草稿" && (distinctVideos >= promoteThreshold || params.confirm)) {
            target.status = "正式";
            target.promotedAt = at;
            promoted = true;
          }
          const newFile = cardFile(expDir, target);
          await writeFileAtomic(newFile, cardBody(target));
          if (newFile !== oldFile) await fs.rm(oldFile, { force: true });
          state.patterns[target.name] = target;
        } else {
          // 新建：默认草稿层；人工确认可直接建为正式
          const rec: PatternRecord = {
            name: params.name,
            status: params.confirm ? "正式" : "草稿",
            scripts: [...params.scripts],
            signals: [...params.signals],
            points: [...params.points],
            sources: [{ ...(params.evidence ? { evidence: params.evidence } : {}), bv: params.bv, at }],
            ...(params.confirm ? { promotedAt: at } : {}),
            updatedAt: at,
          };
          promoted = rec.status === "正式";
          createdNew = true;
          await writeFileAtomic(cardFile(expDir, rec), cardBody(rec));
          state.patterns[rec.name] = rec;
          target = rec;
        }

        // 3. 入库同步：先 upsert 当前卡片，再清掉经验库前缀下的孤儿章节（人工删卡/改名留下的）
        const saved = await ingestPaths([expDir], {
          store,
          ...(embeddings ? { embeddings } : { embeddings: null }),
          ...(vectors ? { vectorCache: vectors } : {}),
        });
        if (saved.issues.length > 0) warnings.push(...saved.issues.map((i) => `跳过 ${i.file}: ${i.error}`));
        const relExpDir = path.relative(process.cwd(), expDir).split(path.sep).join("/");
        const keepIds = new Set(
          (await collectSections([expDir], {})).sections.map((section) => store.docId(section.source))
        );
        await store.pruneInternal([`internal://${relExpDir}`], keepIds);

        await writeState(expDir, state);
        return buildResult(promoted ? "promoted" : createdNew ? "created" : "merged", target, matched, state, warnings, promoted);
      });
      writeChain.current = run.catch(() => undefined);
      return run;
    },
  });
}
