// src/rag/vector_store.ts
/**
 * 向量缓存 + 暴力余弦检索。语料上限是 maxDocs(500) 篇、数千个块，这个量级直接算点积即可
 * （千级向量毫秒级），不需要引入 ANN 索引；缓存的意义只是避免每次检索重复调 embedding 接口。
 *
 * 持久化是"尽力而为"的 sidecar 文件（.rag-cache/vectors.json）：写入走 tmp+rename 原子替换，
 * 不加跨进程锁，两进程同时写可能互相覆盖丢几条 —— 后果只是多一次 embedding 调用，不影响检索正确性，
 * 所以不值得为此复制 knowledge_store 那套锁。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

interface VectorFileV1 {
  version: 1;
  model: string;
  /** 首次写入时的向量维度；与当前配置不符的条目视为无效并重算 */
  dims?: number;
  entries: Record<string, number[]>;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/** 缓存 key = 模型名 + 块文本：文本变（重切/内容更新）自动换 key，旧条目落盘时按容量淘汰 */
export const vectorKey = (model: string, text: string): string => sha1(`${model}\u0000${text}`);

export interface CosineHit {
  id: string;
  similarity: number;
}

/** 余弦相似度 top-K：同分按 id 定序，与 BM25 的稳定性约定一致 */
export function cosineTopK(query: number[], items: Map<string, number[]>, topK: number, minSimilarity: number): CosineHit[] {
  if (query.length === 0 || topK <= 0) return [];
  let queryNorm = 0;
  for (const value of query) queryNorm += value * value;
  queryNorm = Math.sqrt(queryNorm);
  if (queryNorm === 0) return [];

  const hits: CosineHit[] = [];
  for (const [id, vector] of items) {
    if (vector.length !== query.length) continue;
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      const value = vector[i]!;
      dot += query[i]! * value;
      norm += value * value;
    }
    const similarity = norm === 0 ? 0 : dot / (queryNorm * Math.sqrt(norm));
    // 零相似度（含零向量、正交向量）不是命中，即使调用方把阈值放到 0
    if (similarity <= 0 || similarity < minSimilarity) continue;
    hits.push({ id, similarity });
  }
  hits.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1));
  return hits.slice(0, topK);
}

/** 单请求最大条数，与 OpenAICompatibleEmbeddings 的分批上限保持同量级 */
const EMBED_BATCH = 32;

export interface VectorCacheOptions {
  filePath: string;
  model: string;
  /** 条目上限，超出按写入先后淘汰，防止已淘汰块的长尾向量把文件无限撑大 */
  maxEntries?: number;
}

export class VectorCache {
  private readonly entries = new Map<string, number[]>();
  private loaded = false;
  private dims: number | undefined;
  private readonly maxEntries: number;

  constructor(private readonly options: VectorCacheOptions) {
    this.maxEntries = options.maxEntries ?? 8_000;
  }

  /**
   * 返回每个文本对应的向量：命中的直接给，缺的按批调 embed 补齐并落盘。
   * 调用方通常传 [查询, ...全部块文本] —— 查询与块共用一张缓存，相同查询第二次起零调用。
   */
  async ensure(texts: string[], embed: (batch: string[]) => Promise<number[][]>): Promise<Map<string, number[]>> {
    await this.load();
    const result = new Map<string, number[]>();
    const missing: string[] = [];
    for (const text of new Set(texts)) {
      const cached = this.entries.get(vectorKey(this.options.model, text));
      if (cached && (this.dims === undefined || cached.length === this.dims)) result.set(text, cached);
      else missing.push(text);
    }
    if (missing.length === 0) return result;

    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      const vectors = await embed(batch);
      batch.forEach((text, j) => {
        const vector = vectors[j];
        if (!Array.isArray(vector) || vector.length === 0) return;
        this.dims ??= vector.length;
        if (vector.length !== this.dims) return; // 同进程内维度漂移的返回值直接丢弃，下次重算
        this.entries.set(vectorKey(this.options.model, text), vector);
        result.set(text, vector);
      });
    }
    await this.persist();
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await fs.readFile(this.options.filePath, "utf-8");
    } catch {
      return; // 不存在/不可读一律按空缓存处理
    }
    try {
      const parsed = JSON.parse(raw) as VectorFileV1;
      if (parsed.version !== 1 || parsed.model !== this.options.model) return; // 换模型 = 全量失效
      this.dims = parsed.dims;
      for (const [key, vector] of Object.entries(parsed.entries ?? {})) {
        if (Array.isArray(vector) && vector.length > 0) this.entries.set(key, vector);
      }
    } catch {
      // 坏文件按空缓存处理，下次 ensure 会重算并覆盖
    }
  }

  /** 失败只意味着下次多调几次接口，本次内存里的向量依然有效，所以整体吞错 */
  private async persist(): Promise<void> {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    // 5 位小数足够余弦排序用（误差 ~1e-4），文件体积能省三分之一
    const entries = Object.fromEntries(
      [...this.entries].map(([key, vector]) => [key, vector.map((value) => Number(value.toFixed(5)))])
    );
    const payload: VectorFileV1 = {
      version: 1,
      model: this.options.model,
      ...(this.dims !== undefined ? { dims: this.dims } : {}),
      entries,
    };
    const tmp = `${this.options.filePath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(payload), "utf-8");
      // Windows 上目标文件正被其它进程读取时 rename 可能短暂 EPERM/EBUSY，退避重试
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, this.options.filePath);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
