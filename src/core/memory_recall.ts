// src/core/memory_recall.ts
import fs from "node:fs/promises";
import path from "node:path";
import { LONG_TERM_SUMMARY_PREFIX, SESSION_NAME_PREFIX } from "./session_store";
import { EmbeddingClient, createEmbeddingClientFromEnv } from "../rag/embeddings";
import { VectorCache, cosineTopK } from "../rag/vector_store";
import { Bm25Index } from "../rag/bm25";
import { chunkMemorySummary } from "./memory_chunks";

/**
 * 跨会话情景记忆检索（episodic recall）：把 `.agent-sessions/` 里每个会话最新一条
 * 【长期摘要】按章节/句子分块，BM25 + 向量双路召回，经 RRF 融合后注入命中片段。
 *
 * 与 L1 核心记忆的分工：L1 索引（前 200 条常驻，其余按需查询）承载语义事实；这里承载"哪次会话干过
 * 类似的事"——对应 ChatGPT reference chat history 路线。当前会话自己的摘要在
 * longTermBlock 里已有，召回时排除。
 *
 * 成本控制：
 * - 会话索引带 mtime/size 侧车缓存（session-index.json），没变的文件不重读；
 * - 向量缓存（recall-vectors.json）按 文本哈希+模型 复用，摘要不变零 embedding 调用；
 * - 未配置 EMBEDDING_MODEL 或向量服务失败时降级为 BM25，不影响 run。
 */

interface CachedSession {
  mtimeMs: number;
  size: number;
  /** 会话名（【会话名】元记录），用于注入时给模型一个可读标签 */
  name?: string;
  /** 该会话最新一条【长期摘要】正文 */
  summary: string;
}

export interface SessionMemoryHit {
  sessionId: string;
  chunkId: string;
  section: string;
  name?: string;
  /** 命中的分块正文，不再是整篇摘要的开头 */
  summary: string;
  score: number;
  channels: Array<"keyword" | "vector">;
  similarity?: number;
  keywordScore?: number;
}

export type MemoryRetrievalMode = "hybrid" | "keyword" | "vector";

export interface MemoryRecallOptions {
  /** 会话目录（.agent-sessions）：情景记忆素材来源 */
  sessionDir: string;
  /** 侧车索引与向量缓存的落盘目录（缺省与记忆仓同目录） */
  cacheDir: string;
  /** 显式注入 embedding 客户端（测试用）；null 或未配置时使用关键词召回 */
  embeddings?: EmbeddingClient | null;
  /** 缺省 hybrid；单路模式用于离线消融评测 */
  mode?: MemoryRetrievalMode;
  topK?: number;
  /** 余弦相似度下限：低于它不算相关（embedding 模型基线不同，可按实测调整） */
  minSimilarity?: number;
  /** 注入时单条摘要的最大字符数 */
  excerptChars?: number;
  chunkChars?: number;
  /** 防止单个长会话占满结果 */
  maxChunksPerSession?: number;
  /** BM25 查询词加权覆盖率下限，过滤只命中少数泛词的结果 */
  minKeywordCoverage?: number;
}

// v1 只保留摘要前 4000 字符，必须重读源文件才能恢复尾部信息。
const SIDECAR_VERSION = 2;
const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SIMILARITY = 0.35;
const DEFAULT_EXCERPT_CHARS = 600;

export class MemoryRecall {
  private readonly sessionDir: string;
  private readonly cacheDir: string;
  private readonly sidecarPath: string;
  private readonly vectorPath: string;
  private readonly embeddings: EmbeddingClient | undefined;
  private readonly topK: number;
  private readonly minSimilarity: number;
  private readonly excerptChars: number;
  private readonly chunkChars: number;
  private readonly maxChunksPerSession: number;
  private readonly minKeywordCoverage: number;
  private readonly mode: MemoryRetrievalMode;
  private sessions = new Map<string, CachedSession>();
  private sidecarLoaded = false;
  private vectorCache: VectorCache | undefined;

  constructor(options: MemoryRecallOptions) {
    this.sessionDir = path.resolve(options.sessionDir);
    this.cacheDir = path.resolve(options.cacheDir);
    this.sidecarPath = path.join(this.cacheDir, "session-index.json");
    this.vectorPath = path.join(this.cacheDir, "recall-vectors.json");
    this.embeddings = options.embeddings !== undefined ? (options.embeddings ?? undefined) : createEmbeddingClientFromEnv();
    this.topK = options.topK ?? DEFAULT_TOP_K;
    this.minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    this.excerptChars = options.excerptChars ?? DEFAULT_EXCERPT_CHARS;
    this.chunkChars = Math.min(options.chunkChars ?? 500, this.excerptChars);
    this.maxChunksPerSession = options.maxChunksPerSession ?? 2;
    this.minKeywordCoverage = options.minKeywordCoverage ?? 0.2;
    this.mode = options.mode ?? "hybrid";
    for (const [key, value] of Object.entries({ topK: this.topK, maxChunksPerSession: this.maxChunksPerSession })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须为正整数`);
    }
    if (!Number.isSafeInteger(this.excerptChars) || this.excerptChars < 32 ||
        !Number.isSafeInteger(this.chunkChars) || this.chunkChars < 32) throw new Error("分块和摘录长度必须为至少 32 的整数");
    if (!Number.isFinite(this.minSimilarity) || this.minSimilarity < 0 || this.minSimilarity > 1 ||
        !Number.isFinite(this.minKeywordCoverage) || this.minKeywordCoverage < 0 || this.minKeywordCoverage > 1) {
      throw new Error("召回阈值必须在 0 到 1 之间");
    }
  }

  /** 是否具备召回素材；关键词通道无需 embedding 配置 */
  async available(): Promise<boolean> {
    if (this.mode === "vector" && !this.embeddings) return false;
    await this.refresh();
    return [...this.sessions.values()].some((session) => session.summary !== "");
  }

  /**
   * 刷新会话索引：stat 一遍目录，只重读 mtime/size 变了的文件；已删除的会话从索引剔除。
   * 每次 run 开始调一次——37 个会话的 stat 开销可忽略，重读只发生在文件真正变化时。
   */
  async refresh(): Promise<void> {
    await this.loadSidecar();
    let entries: string[];
    try {
      entries = await fs.readdir(this.sessionDir);
    } catch {
      entries = []; // 目录不存在 = 还没有任何会话
    }

    let dirty = false;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      const filePath = path.join(this.sessionDir, entry);
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (!stat?.isFile()) continue;
      seen.add(sessionId);
      const cached = this.sessions.get(sessionId);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      const parsed = await this.parseSessionFile(filePath);
      this.sessions.set(sessionId, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        summary: parsed.summary,
      });
      dirty = true;
    }
    for (const sessionId of [...this.sessions.keys()]) {
      if (!seen.has(sessionId)) {
        this.sessions.delete(sessionId);
        dirty = true;
      }
    }
    if (dirty) await this.persistSidecar();
  }

  /**
   * 按当前问题召回相关会话。excludeSessionId 用于排除当前会话（它的摘要在
   * longTermBlock 里已注入，召回只会重复）。无向量服务时仍可按关键词检索。
   */
  async recall(query: string, opts: { excludeSessionId?: string | undefined } = {}): Promise<SessionMemoryHit[]> {
    const queryText = clipText(query.trim(), 1500);
    if (!queryText) return [];
    await this.refresh();

    const candidates = [...this.sessions.entries()]
      .filter(([sessionId, session]) => sessionId !== opts.excludeSessionId && session.summary !== "")
      .flatMap(([sessionId, session]) => chunkMemorySummary(sessionId, session.summary, this.chunkChars)
        .map((chunk) => ({ ...chunk, name: session.name, embeddingText: `${chunk.section}\n${chunk.text}` })));
    if (candidates.length === 0) return [];
    const byId = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]));
    const keyword = this.mode === "vector" ? [] : new Bm25Index(candidates.map((candidate) => ({
      id: candidate.chunkId, text: candidate.embeddingText,
    }))).search(queryText, { minCoverage: this.minKeywordCoverage });
    let vector: Array<{ id: string; similarity: number }> = [];
    if (this.embeddings && this.mode !== "keyword") {
      try {
        this.vectorCache ??= new VectorCache({ filePath: this.vectorPath, model: this.embeddings.model, maxEntries: 4000 });
        const vectors = await this.vectorCache.ensure(
          [queryText, ...candidates.map((candidate) => candidate.embeddingText)],
          (batch) => this.embeddings!.embed(batch)
        );
        const queryVector = vectors.get(queryText);
        if (queryVector) {
          const items = new Map<string, number[]>();
          for (const candidate of candidates) {
            const value = vectors.get(candidate.embeddingText);
            if (value) items.set(candidate.chunkId, value);
          }
          vector = cosineTopK(queryVector, items, candidates.length, this.minSimilarity);
        }
      } catch (error) {
        console.warn(`[Memory] 向量召回失败，使用关键词结果: ${error instanceof Error ? error.message : error}`);
      }
    }
    // RRF 融合排名而非不同尺度的原始分数；全部候选参与，避免去重/会话限额后不足 top-K。
    const scores = new Map<string, { score: number; keywordScore?: number; similarity?: number }>();
    keyword.forEach((hit, rank) => scores.set(hit.id, { score: 1 / (60 + rank + 1), keywordScore: hit.score }));
    vector.forEach((hit, rank) => {
      const previous = scores.get(hit.id);
      scores.set(hit.id, { ...previous, score: (previous?.score ?? 0) + 1 / (60 + rank + 1), similarity: hit.similarity });
    });
    const ranked = [...scores.entries()].sort(([a, x], [b, y]) => y.score - x.score || (a < b ? -1 : a > b ? 1 : 0));
    const perSession = new Map<string, number>();
    const seenText = new Set<string>();
    const hits: SessionMemoryHit[] = [];
    for (const [id, score] of ranked) {
      const candidate = byId.get(id)!;
      const count = perSession.get(candidate.sessionId) ?? 0;
      const textKey = candidate.text.normalize("NFKC").replace(/\s+/g, " ").trim();
      if (count >= this.maxChunksPerSession || seenText.has(textKey)) continue;
      perSession.set(candidate.sessionId, count + 1);
      seenText.add(textKey);
      hits.push({
        sessionId: candidate.sessionId,
        chunkId: candidate.chunkId,
        section: candidate.section,
        ...(candidate.name !== undefined ? { name: candidate.name } : {}),
        summary: candidate.text,
        ...score,
        channels: [...(score.keywordScore !== undefined ? ["keyword" as const] : []), ...(score.similarity !== undefined ? ["vector" as const] : [])],
      });
      if (hits.length >= this.topK) break;
    }
    return hits;
  }

  /** 渲染注入块正文：一行一条带来源标签与相关度；无命中返回空串（调用方据此不注入） */
  async recallBlock(query: string, opts: { excludeSessionId?: string | undefined } = {}): Promise<string> {
    const hits = await this.recall(query, opts);
    if (hits.length === 0) return "";
    return hits
      .map((hit) => {
        const label = hit.name ? `会话 ${hit.sessionId} · ${hit.name}` : `会话 ${hit.sessionId}`;
        return `- [${label} · ${hit.section} · 块 ${hit.chunkId} · ${hit.channels.join("+")} · 融合分 ${hit.score.toFixed(4)}] ${hit.summary}`;
      })
      .join("\n");
  }

  /** 解析单个会话文件：取最后一条【长期摘要】与【会话名】元记录 */
  private async parseSessionFile(filePath: string): Promise<{ name?: string; summary: string }> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return { summary: "" };
    }
    let name: string | undefined;
    let summary = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(LONG_TERM_SUMMARY_PREFIX) && !trimmed.includes(SESSION_NAME_PREFIX)) continue;
      try {
        const record = JSON.parse(trimmed) as { role?: string; content?: unknown };
        if (record.role !== "user" || typeof record.content !== "string") continue;
        if (record.content.startsWith(LONG_TERM_SUMMARY_PREFIX)) {
          summary = record.content.slice(LONG_TERM_SUMMARY_PREFIX.length).trim();
        } else if (record.content.startsWith(SESSION_NAME_PREFIX)) {
          name = record.content.slice(SESSION_NAME_PREFIX.length).trim() || undefined;
        }
      } catch {
        // 损坏行照 SessionStore 的口径跳过
      }
    }
    return { ...(name !== undefined ? { name } : {}), summary };
  }

  private async loadSidecar(): Promise<void> {
    if (this.sidecarLoaded) return;
    this.sidecarLoaded = true;
    let raw: string;
    try {
      raw = await fs.readFile(this.sidecarPath, "utf-8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { version?: number; sessions?: Record<string, CachedSession> };
      if (parsed.version !== SIDECAR_VERSION) return;
      for (const [sessionId, cached] of Object.entries(parsed.sessions ?? {})) {
        if (typeof cached?.mtimeMs === "number" && typeof cached?.summary === "string") {
          this.sessions.set(sessionId, cached);
        }
      }
    } catch {
      // 坏侧车按空索引处理，本次 refresh 会全量重读并覆盖
    }
  }

  private async persistSidecar(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const payload = {
      version: SIDECAR_VERSION,
      sessions: Object.fromEntries([...this.sessions.entries()].map(([id, cached]) => [id, cached])),
    };
    const tmp = `${this.sidecarPath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(payload), "utf-8");
      await fs.rename(tmp, this.sidecarPath);
    } catch (error) {
      // 侧车写失败只意味着下次多读几个文件，不拦召回
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      console.warn(`[Memory] 会话索引侧车写入失败: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function clipText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
