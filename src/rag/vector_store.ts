// src/rag/vector_store.ts
/**
 * 向量缓存 + 暴力余弦检索。语料上限是 maxDocs(500) 篇、数千个块，这个量级直接算点积即可
 * （千级向量毫秒级），不需要引入 ANN 索引；缓存的意义只是避免每次检索重复调 embedding 接口。
 *
 * 持久化到 sidecar 文件（.rag-cache/vectors.json），写入走 tmp+rename 原子替换。
 * ponytail: JSON 后端限单个入库进程；多进程并发导入用 PostgreSQL，避免文件覆盖导致向量缺失。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

interface VectorFileV1 {
  version: 1;
  model: string;
  /** 首次写入时的向量维度；与当前配置不符的条目视为无效并重算 */
  dims?: number;
  entries: Record<string, number[]>;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/** 缓存 key = 编码配置标识（兼容旧模型名）+ 块文本；配置/文本变更自动换 key。 */
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
  private signature: string | undefined;
  private dims: number | undefined;
  private readonly maxEntries: number;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: VectorCacheOptions) {
    this.maxEntries = options.maxEntries ?? 8_000;
  }

  /** 只读已生成的向量；外部入库更新文件后，长驻查询进程也能读到。 */
  async get(texts: string[]): Promise<Map<string, number[]>> {
    await this.writeChain;
    return this.read(texts);
  }

  private async read(texts: string[]): Promise<Map<string, number[]>> {
    await this.load();
    const result = new Map<string, number[]>();
    for (const text of new Set(texts)) {
      const cached = this.entries.get(vectorKey(this.options.model, text));
      if (cached && (this.dims === undefined || cached.length === this.dims)) result.set(text, cached);
    }
    return result;
  }

  /** 已有向量复用，缺失向量分批生成并持久化；同实例写入串行。 */
  async ensure(texts: string[], embed: (batch: string[]) => Promise<number[][]>): Promise<Map<string, number[]>> {
    const pending = this.writeChain.then(() => this.ensureBatch(texts, embed));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  private async ensureBatch(texts: string[], embed: (batch: string[]) => Promise<number[][]>): Promise<Map<string, number[]>> {
    const result = await this.read(texts);
    const missing = [...new Set(texts)].filter(text => !result.has(text));
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
      // 每批落盘：后续批失败时，重试可复用已经完成的批次。
      await this.persist();
    }
    return result;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      const stat = await fs.stat(this.options.filePath);
      const signature = `${stat.mtimeMs}:${stat.size}`;
      if (signature === this.signature) return;
      raw = await fs.readFile(this.options.filePath, "utf-8");
      this.signature = signature;
    } catch {
      this.signature = undefined;
      this.entries.clear();
      this.dims = undefined;
      return; // 不存在/不可读按空缓存处理，查询端会报告缺失向量
    }
    try {
      const parsed = JSON.parse(raw) as VectorFileV1;
      this.entries.clear();
      this.dims = undefined;
      if (parsed.version !== 1 || parsed.model !== this.options.model) return; // 换模型 = 全量失效
      this.dims = parsed.dims;
      for (const [key, vector] of Object.entries(parsed.entries ?? {})) {
        if (Array.isArray(vector) && vector.length > 0) this.entries.set(key, vector);
      }
    } catch {
      this.entries.clear();
      this.dims = undefined;
      // 坏文件按空缓存处理，下次 ensure 会重算并覆盖
    }
  }

  /** 入库只有持久化成功才算完成；失败交给调用方报告并重试。 */
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
      await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
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
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      this.signature = undefined;
      this.entries.clear();
      this.dims = undefined;
      throw error;
    }
  }
}
