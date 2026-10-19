// src/rag/bm25.ts
import { tokenize } from "./tokenizer";

/** text 与 tokens 二选一：调用方已分词时直接传 tokens，避免重复 tokenize */
export interface Bm25Entry {
  id: string;
  text?: string;
  tokens?: string[];
}

export interface Bm25Hit {
  id: string;
  score: number;
  /** 命中的查询词按 IDF 加权后占全部查询词的比例，0~1，用作与语料规模无关的过滤阈值 */
  coverage: number;
}

export interface Bm25SearchOptions {
  limit?: number;
  minCoverage?: number;
  filter?: (id: string) => boolean;
}

interface IndexedEntry {
  id: string;
  tf: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private readonly entries = new Map<string, IndexedEntry>();
  private readonly df = new Map<string, number>();
  private totalLength = 0;

  constructor(
    entries: Iterable<Bm25Entry> = [],
    private readonly k1 = 1.2,
    private readonly b = 0.75
  ) {
    for (const entry of entries) this.add(entry);
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 供调用方 diff 出"已从语料消失"的块 id 并 remove */
  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  private static toTokens(entry: Bm25Entry): string[] {
    if (entry.tokens) return entry.tokens;
    if (entry.text === undefined) throw new Error(`Bm25Entry ${entry.id} 需要 text 或 tokens`);
    return tokenize(entry.text);
  }

  /** 新增或替换一个条目；已存在时先撤旧条目对 df 的贡献 */
  add(entry: Bm25Entry): void {
    if (this.entries.has(entry.id)) this.remove(entry.id);
    const tokens = Bm25Index.toTokens(entry);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
    this.entries.set(entry.id, { id: entry.id, tf, length: tokens.length });
    this.totalLength += tokens.length;
  }

  remove(id: string): boolean {
    const existing = this.entries.get(id);
    if (!existing) return false;
    for (const token of existing.tf.keys()) {
      const next = (this.df.get(token) ?? 0) - 1;
      if (next <= 0) this.df.delete(token);
      else this.df.set(token, next);
    }
    this.entries.delete(id);
    this.totalLength -= existing.length;
    return true;
  }

  private get avgLength(): number {
    return this.entries.size > 0 ? this.totalLength / this.entries.size : 0;
  }

  private idf(term: string): number {
    const n = this.entries.size;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query: string, options: Bm25SearchOptions = {}): Bm25Hit[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.entries.size === 0) return [];

    const idfs = terms.map((term) => this.idf(term));
    const idfTotal = idfs.reduce((sum, value) => sum + value, 0);
    const minCoverage = options.minCoverage ?? 0;
    const avgLength = this.avgLength || 1;
    const hits: Bm25Hit[] = [];

    for (const entry of this.entries.values()) {
      if (options.filter && !options.filter(entry.id)) continue;
      let score = 0;
      let matchedIdf = 0;
      terms.forEach((term, i) => {
        const freq = entry.tf.get(term);
        if (!freq) return;
        const idf = idfs[i]!;
        matchedIdf += idf;
        const norm = this.k1 * (1 - this.b + (this.b * entry.length) / avgLength);
        score += (idf * freq * (this.k1 + 1)) / (freq + norm);
      });
      if (score <= 0) continue;
      const coverage = idfTotal > 0 ? matchedIdf / idfTotal : 0;
      if (coverage < minCoverage) continue;
      hits.push({ id: entry.id, score, coverage });
    }

    // 同分时按 id 定序：增量 add/remove 会改变插入顺序，不固定会导致重建前后排序抖动
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return options.limit === undefined ? hits : hits.slice(0, options.limit);
  }
}
