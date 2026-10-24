// src/core/memory_recall.ts
import fs from "node:fs/promises";
import path from "node:path";
import { LONG_TERM_SUMMARY_PREFIX, SESSION_NAME_PREFIX } from "./session_store";
import { EmbeddingClient, createEmbeddingClientFromEnv } from "../rag/embeddings";
import { VectorCache, cosineTopK } from "../rag/vector_store";

/**
 * 跨会话情景记忆检索（episodic recall）：把 `.agent-sessions/` 里每个会话最新一条
 * 【长期摘要】当作情景记忆条目，用向量相似度按当前用户问题召回 top-K 注入。
 *
 * 与 L1 核心记忆的分工：L1 索引（全量、常驻）承载语义事实；这里承载"哪次会话干过
 * 类似的事"——对应 ChatGPT reference chat history 路线。当前会话自己的摘要在
 * longTermBlock 里已有，召回时排除。
 *
 * 成本控制：
 * - 会话索引带 mtime/size 侧车缓存（session-index.json），没变的文件不重读；
 * - 向量缓存（recall-vectors.json）按 文本哈希+模型 复用，摘要不变零 embedding 调用；
 * - 未配置 EMBEDDING_MODEL 时召回整体停用（返回空串），不影响 run。
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
  name?: string;
  summary: string;
  similarity: number;
}

export interface MemoryRecallOptions {
  /** 会话目录（.agent-sessions）：情景记忆素材来源 */
  sessionDir: string;
  /** 侧车索引与向量缓存的落盘目录（缺省与记忆仓同目录） */
  cacheDir: string;
  /** 显式注入 embedding 客户端（测试用）；缺省读环境变量，未配置 EMBEDDING_MODEL 时停用 */
  embeddings?: EmbeddingClient | null;
  topK?: number;
  /** 余弦相似度下限：低于它不算相关（embedding 模型基线不同，可按实测调整） */
  minSimilarity?: number;
  /** 注入时单条摘要的最大字符数 */
  excerptChars?: number;
}

/** 侧车索引里单条摘要的存储上限：摘要本身 8 节结构，4000 字符足够语义检索用 */
const MAX_SUMMARY_CHARS = 4000;
const SIDECAR_VERSION = 1;
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
  }

  /** 是否具备召回条件（embedding 客户端在且至少有一个会话带摘要） */
  async available(): Promise<boolean> {
    if (!this.embeddings) return false;
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
      seen.add(sessionId);
      const filePath = path.join(this.sessionDir, entry);
      const stat = await fs.stat(filePath).catch(() => undefined);
      if (!stat?.isFile()) continue;
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
   * longTermBlock 里已注入，召回只会重复）。embedding 不可用或无候选时返回空数组。
   */
  async recall(query: string, opts: { excludeSessionId?: string | undefined } = {}): Promise<SessionMemoryHit[]> {
    if (!this.embeddings) return [];
    await this.refresh();

    const candidates = [...this.sessions.entries()]
      .filter(([sessionId, session]) => sessionId !== opts.excludeSessionId && session.summary !== "")
      .map(([sessionId, session]) => ({ sessionId, name: session.name, text: session.summary }));
    if (candidates.length === 0) return [];

    const queryText = clipText(query, 1500);
    this.vectorCache ??= new VectorCache({
      filePath: this.vectorPath,
      model: this.embeddings.model,
      maxEntries: 4000,
    });
    const vectors = await this.vectorCache.ensure(
      [queryText, ...candidates.map((candidate) => candidate.text)],
      (batch) => this.embeddings!.embed(batch)
    );
    const queryVector = vectors.get(queryText);
    if (!queryVector) return [];

    // 以会话 id 为 key 建检索表（查询自身不进表，避免恒 1.0 的自匹配占满 top-K）
    const items = new Map<string, number[]>();
    for (const candidate of candidates) {
      const vector = vectors.get(candidate.text);
      if (vector) items.set(candidate.sessionId, vector);
    }
    return cosineTopK(queryVector, items, this.topK, this.minSimilarity).map((hit) => {
      const candidate = candidates.find((c) => c.sessionId === hit.id)!;
      return {
        sessionId: candidate.sessionId,
        ...(candidate.name !== undefined ? { name: candidate.name } : {}),
        summary: candidate.text,
        similarity: hit.similarity,
      };
    });
  }

  /** 渲染注入块正文：一行一条带来源标签与相关度；无命中返回空串（调用方据此不注入） */
  async recallBlock(query: string, opts: { excludeSessionId?: string | undefined } = {}): Promise<string> {
    const hits = await this.recall(query, opts);
    if (hits.length === 0) return "";
    return hits
      .map((hit) => {
        const label = hit.name ? `会话 ${hit.sessionId} · ${hit.name}` : `会话 ${hit.sessionId}`;
        return `- [${label} · 相关度 ${hit.similarity.toFixed(2)}] ${clipText(hit.summary, this.excerptChars)}`;
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
          summary = clipText(record.content.slice(LONG_TERM_SUMMARY_PREFIX.length).trim(), MAX_SUMMARY_CHARS);
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
