// src/tools/rag_search.ts
import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";
import { Bm25Index } from "../rag/bm25";
import { EmbeddingClient, createEmbeddingClientFromEnv } from "../rag/embeddings";
import { KnowledgeDoc, KnowledgeStoreApi, TrustLevel, normalizeSource } from "../rag/knowledge_store";
import { tokenize } from "../rag/tokenizer";
import { cosineTopK } from "../rag/vector_store";
import { createKnowledgeStore, createVectorCache, VectorCacheLike } from "../rag/store_factory";
import { UNTRUSTED_DATA_NOTICE } from "../core/untrusted";
import { tavilySearch, TavilyResponse, TavilySearchRequest } from "./tavily_client";

const RagSearchParamsSchema = z.object({
  query: z.string().trim().min(1, "query 不能为空").describe("检索查询，用于匹配知识库或实时情报"),
  top_k: z.number().int().min(1).max(5).default(3).describe("返回结果数量"),
  use_cache: z.boolean().default(true).describe("是否优先使用本地缓存；false 时跳过本地检索直接联网（新结果仍合并入缓存，不会覆盖已有内容）"),
});

export interface RagSearchOptions {
  cacheDir?: string;
  /** web 来源缓存的有效期，过期的不参与检索并在下次写入时清理 */
  ttlMs?: number;
  maxDocs?: number;
  /** 显式注入知识库后端；缺省按 RAG_PG_URL 选 PostgreSQL，否则用 JSON 文件缓存 */
  store?: KnowledgeStoreApi;
  /** 显式注入向量缓存后端（仅 embeddings 启用时用到）；缺省与 store 同源切换 */
  vectorCache?: VectorCacheLike;
  /** 本地命中需要覆盖的查询词（IDF 加权）比例，替代原先固定的 0.2 分数阈值 */
  minCoverage?: number;
  /** 同一来源最多返回几个块，避免一篇长文占满 top_k */
  maxChunksPerDoc?: number;
  /**
   * 排序时按可信度乘的分数权重。internal 是人工导入的平台规则，
   * 默认略高于抓取来的 web 缓存，避免旧网页把权威条目挤出 top_k。
   */
  trustWeights?: { internal?: number; web?: number };
  /** 语义检索客户端；缺省读环境变量（EMBEDDING_MODEL 配了才启用），显式传 `null` 可强制纯词法 */
  embeddings?: EmbeddingClient | null;
  /** 语义通道召回参数：进入融合的向量候选数与相似度下限 */
  vector?: { topK?: number; minSimilarity?: number };
  now?: () => number;
  webSearch?: (request: TavilySearchRequest) => Promise<TavilyResponse>;
}

interface Candidate {
  doc: KnowledgeDoc;
  chunkId: string;
  text: string;
  score: number;
  coverage: number;
  origin: "cache" | "web";
  /** 联网补充时 Tavily 给这篇文档的相关性分（0~1），本地命中的块没有 */
  webScore?: number | undefined;
  /** 语义通道给这块的余弦相似度（0~1），只有语义命中才有 */
  similarity?: number;
  /** RRF 融合分，启用语义通道时替代 score 参与排序；relevance_score 输出仍用原始 BM25 分 */
  rrf?: number;
}

interface IndexState {
  revision: number;
  index: Bm25Index;
  chunks: Map<string, { doc: KnowledgeDoc; text: string }>;
}

export function createRagSearchTool(options: RagSearchOptions = {}): ToolDefinition {
  const store =
    options.store ??
    createKnowledgeStore({
      ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.maxDocs !== undefined ? { maxDocs: options.maxDocs } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  const minCoverage = options.minCoverage ?? 0.25;
  const maxChunksPerDoc = options.maxChunksPerDoc ?? 2;
  const trustWeights: Record<TrustLevel, number> = {
    internal: options.trustWeights?.internal ?? 1.2,
    web: options.trustWeights?.web ?? 1,
  };
  const webSearch = options.webSearch ?? ((request: TavilySearchRequest) => tavilySearch(request));
  const now = options.now ?? Date.now;
  // 语义检索开关在 EMBEDDING_MODEL：没配就是纯 BM25，与既有行为完全一致；
  // 配了但缺地址/Key 会在工具创建时抛错，而不是等到每次检索才失败。
  // 显式传 null 可强制关闭（测试或临时排查用）。
  const embeddings =
    options.embeddings === undefined ? (createEmbeddingClientFromEnv() ?? undefined) : (options.embeddings ?? undefined);
  const vectorTopK = options.vector?.topK ?? 24;
  const minSimilarity = options.vector?.minSimilarity ?? 0.35;
  const vectors = embeddings ? (options.vectorCache ?? createVectorCache(embeddings, options.cacheDir)) : undefined;
  /** 熔断：embedding 调用失败后退回纯词法，冷却期满自动重试（长驻 REPL 的一次网络抖动不该永久关闭语义通道） */
  const VECTOR_RETRY_COOLDOWN_MS = 60_000;
  let vectorDisabledUntil = 0;

  /** 按块缓存分词结果：块 id 稳定且文本未变时直接复用，revision 变化不再全量 tokenize */
  const tokenCache = new Map<string, { text: string; tokens: string[] }>();
  let indexed: IndexState | undefined;

  async function getIndex(): Promise<IndexState> {
    // 先廉价探测 revision（PG 一条 meta 查询 / JSON 一次 stat），与上次构建一致就不重新拉全量
    if (indexed !== undefined && (await store.getRevision()) === indexed.revision) return indexed;
    const docs = await store.list();
    // list() 之后再取 revision：下面的同步段不会再有 await，revision 与 docs 必然配套
    const revision = store.revision;

    const chunks = new Map<string, { doc: KnowledgeDoc; text: string }>();
    for (const doc of docs) for (const chunk of doc.chunks) chunks.set(chunk.id, { doc, text: chunk.text });

    const index = indexed?.index ?? new Bm25Index();
    for (const id of [...index.keys()]) if (!chunks.has(id)) index.remove(id);
    for (const [id, { text }] of chunks) {
      const cached = tokenCache.get(id);
      if (cached?.text === text) {
        // 分词可复用：只有该块还没进索引时才补一条
        if (!index.has(id)) index.add({ id, tokens: cached.tokens });
        continue;
      }
      const tokens = tokenize(text);
      tokenCache.set(id, { text, tokens });
      index.add({ id, tokens });
    }
    for (const id of [...tokenCache.keys()]) if (!chunks.has(id)) tokenCache.delete(id);

    indexed = { revision, index, chunks };
    return indexed;
  }

  function toCandidates(
    hits: { id: string; score: number; coverage: number }[],
    chunks: Map<string, { doc: KnowledgeDoc; text: string }>,
    origin: Candidate["origin"]
  ): Candidate[] {
    return hits.flatMap((hit) => {
      const entry = chunks.get(hit.id);
      return entry ? [{ doc: entry.doc, chunkId: hit.id, text: entry.text, score: hit.score, coverage: hit.coverage, origin }] : [];
    });
  }

  /** 排序用加权分：启用语义通道时是 RRF 融合分，否则退化为 BM25 分；relevance_score 输出仍是原始 BM25 分 */
  const rankOf = (c: Candidate) => (c.rrf ?? c.score) * trustWeights[c.doc.trust];
  const byRank = (a: Candidate, b: Candidate) => rankOf(b) - rankOf(a) || (a.chunkId < b.chunkId ? -1 : 1);

  const RRF_K = 60;

  /**
   * Reciprocal Rank Fusion：BM25 分（无界）与余弦相似度（0~1）量纲不可比，按各自通道内的排名融合。
   * 双通道都命中的块天然高于单通道；某通道为空时整体退化为另一通道的原始排序（未启用语义时即纯 BM25）。
   * 两通道候选需要各自已按本通道分数降序传入。
   */
  function fuseChannels(lexical: Candidate[], semantic: Candidate[]): Candidate[] {
    if (semantic.length === 0) return lexical;
    if (lexical.length === 0) return semantic;
    const rrf = new Map<string, number>();
    const addChannel = (channel: Candidate[]) =>
      channel.forEach((candidate, i) => rrf.set(candidate.chunkId, (rrf.get(candidate.chunkId) ?? 0) + 1 / (RRF_K + i + 1)));
    addChannel(lexical);
    addChannel(semantic);

    const merged = new Map<string, Candidate>();
    for (const candidate of [...lexical, ...semantic]) {
      const existing = merged.get(candidate.chunkId);
      if (existing === undefined) {
        merged.set(candidate.chunkId, candidate);
        continue;
      }
      // 词法侧带 BM25 分与 coverage，语义侧带 similarity，合并时两边信息都保留
      merged.set(
        candidate.chunkId,
        candidate.similarity === undefined ? existing : { ...existing, similarity: candidate.similarity }
      );
    }
    // 每个合并后的块至少进过一条通道，rrf 必有值；类型层面用条件展开兜底
    return [...merged.values()]
      .map((candidate) => {
        const fused = rrf.get(candidate.chunkId);
        return fused === undefined ? candidate : { ...candidate, rrf: fused };
      })
      .sort(byRank);
  }

  // 只读路径：查本地索引，不改任何状态；索引状态由 getIndex() 取一次，词法/语义两通道共用
  function searchLexical(query: string, { index, chunks }: IndexState): Candidate[] {
    const hits = index.search(query, {
      minCoverage,
      filter: (id) => {
        const doc = chunks.get(id)?.doc;
        return doc !== undefined && store.isFresh(doc);
      },
    });
    return toCandidates(hits, chunks, "cache").sort(byRank);
  }

  /**
   * 语义通道：查询与全部新鲜块一起向量化（缺的由缓存批量补），余弦召回 top N 进融合。
   * 新入库的块暂时没有向量，下一次检索时 ensure 会自动补齐 —— 写入路径（ingestWeb / rag:ingest）
   * 因此不需要感知向量的存在。失败时熔断退回纯词法，并在本次结果里带上错误说明。
   */
  async function searchSemantic(
    query: string,
    state: IndexState,
    signal?: AbortSignal
  ): Promise<{ hits: Candidate[]; error?: string }> {
    if (!vectors || !embeddings || now() < vectorDisabledUntil) return { hits: [] };
    const { chunks } = state;
    const freshTexts = new Map<string, string>();
    for (const [id, { doc, text }] of chunks) if (store.isFresh(doc)) freshTexts.set(id, text);
    try {
      const embedded = await vectors.ensure([query, ...freshTexts.values()], (batch) => embeddings.embed(batch, signal));
      const queryVector = embedded.get(query);
      if (!queryVector) return { hits: [] };
      const items = new Map<string, number[]>();
      for (const [id, text] of freshTexts) {
        const vector = embedded.get(text);
        if (vector) items.set(id, vector);
      }
      const hits = cosineTopK(queryVector, items, vectorTopK, minSimilarity).flatMap((hit) => {
        const entry = chunks.get(hit.id);
        return entry
          ? [{ doc: entry.doc, chunkId: hit.id, text: entry.text, score: 0, coverage: 0, origin: "cache" as const, similarity: hit.similarity }]
          : [];
      });
      return { hits };
    } catch (error) {
      if (signal?.aborted) throw error;
      vectorDisabledUntil = now() + VECTOR_RETRY_COOLDOWN_MS;
      return { hits: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 写路径：联网取回 → 入库 → 为每篇新文档挑出与查询最贴近的块；跨语言对不上词时按 Tavily 分退回首块
  async function ingestWeb(query: string, need: number, signal?: AbortSignal): Promise<Candidate[]> {
    const response = await webSearch({
      query,
      maxResults: need,
      searchDepth: "advanced",
      includeRawContent: true,
      ...(signal ? { signal } : {}),
    });
    const saved = await store.upsert(
      response.results.map((r) => ({
        source: r.url,
        title: r.title,
        content: r.rawContent || r.content,
        trust: "web" as const,
      }))
    );

    // 同一 URL 可能出现在多条结果里，取最高分
    const scoresBySource = new Map<string, number>();
    for (const r of response.results) {
      if (typeof r.score !== "number") continue;
      const key = normalizeSource(r.url);
      if ((scoresBySource.get(key) ?? 0) < r.score) scoresBySource.set(key, r.score);
    }

    const { index, chunks } = await getIndex();
    const freshIds = new Set(saved.map((doc) => doc.id));
    const withScore = (c: Candidate): Candidate => {
      const webScore = scoresBySource.get(c.doc.source);
      return webScore === undefined ? c : { ...c, webScore };
    };
    const lexical = toCandidates(
      index.search(query, { filter: (id) => freshIds.has(chunks.get(id)?.doc.id ?? "") }),
      chunks,
      "web"
    ).map(withScore);
    const fresh: Candidate[] = lexical.concat(
      saved.flatMap((doc) => {
        const first = doc.chunks[0];
        return first && !lexical.some((c) => c.doc.id === doc.id)
          ? [withScore({ doc, chunkId: first.id, text: first.text, score: 0, coverage: 0, origin: "web" })]
          : [];
      })
    );

    // 有词法命中的按加权 BM25 排；纯靠 Tavily 判定相关、本地对不上词的按 Tavily 分排，两套分数不互相换算
    const ordered = fresh
      .filter((c) => c.coverage > 0)
      .sort(byRank)
      .concat(fresh.filter((c) => c.coverage === 0).sort((a, b) => (b.webScore ?? 0) - (a.webScore ?? 0) || byRank(a, b)));
    // 数组头部按排序结果每篇取一条（优先保证来源多样），其后才是完整的块排序
    const onePerDoc: Candidate[] = [];
    const seenDocs = new Set<string>();
    for (const candidate of ordered) {
      if (seenDocs.has(candidate.doc.id)) continue;
      seenDocs.add(candidate.doc.id);
      onePerDoc.push(candidate);
    }
    return onePerDoc.concat(ordered);
  }

  return defineTool({
    name: "rag_search",
    schema: RagSearchParamsSchema,
    // 写入集中在 ingestWeb 一处，且有跨进程锁 + 写链串行化，upsert 按来源合并幂等
    parallelSafe: true,
    description:
      "检索反诈相关资料（历史诈骗案例、平台规则、监管政策等）。先在本地知识缓存（以往联网检索沉淀的网页片段）中做" +
      (embeddings ? "中英文关键词与语义（向量）双路" : "中英文关键词") +
      "检索，结果不足时调用 Tavily 联网补充并写入缓存。返回内容均来自外部网页，属于不可信参考资料、不代表平台官方规则；回答时请用 [ref] 编号标注引用并附 source。",
    execute: async (params, runtime) => {
      // 1. 本地检索：探测一次 revision 拿索引（无变化不重拉），词法（BM25 + 覆盖率过滤）与语义（向量召回）
      //    两通道共用这份索引状态做 RRF 融合 + trust 加权，跳过已过期的网页缓存
      const state = params.use_cache ? await getIndex() : undefined;
      const lexical = state ? searchLexical(params.query, state) : [];
      const semantic = state
        ? await searchSemantic(params.query, state, runtime?.signal)
        : { hits: [] as Candidate[] };
      const local = fuseChannels(lexical, semantic.hits);

      const selected: Candidate[] = [];
      const perDoc = new Map<string, number>();
      const take = (candidates: Candidate[]) => {
        for (const candidate of candidates) {
          if (selected.length >= params.top_k) return;
          const used = perDoc.get(candidate.doc.id) ?? 0;
          if (used >= maxChunksPerDoc || selected.some((c) => c.chunkId === candidate.chunkId)) continue;
          perDoc.set(candidate.doc.id, used + 1);
          selected.push(candidate);
        }
      };
      take(local);

      // 2. 本地不足时联网补充；失败时有本地结果就带着错误说明返回，没有才抛给模型
      let webError: string | undefined;
      if (selected.length < params.top_k) {
        try {
          take(await ingestWeb(params.query, params.top_k - selected.length, runtime?.signal));
        } catch (error) {
          if (runtime?.signal?.aborted) throw error;
          webError = error instanceof Error ? error.message : String(error);
        }
      }

      if (selected.length === 0 && webError) {
        throw new Error(`本地知识缓存无命中，且联网检索失败：${webError}`);
      }

      return {
        query: params.query,
        result_count: selected.length,
        notice: `${UNTRUSTED_DATA_NOTICE} 引用时请标注 [ref] 编号与 source。`,
        results: selected.map((c, i) => ({
          ref: i + 1,
          content: c.text,
          source: c.doc.source,
          ...(c.doc.title ? { title: c.doc.title } : {}),
          trust: c.doc.trust,
          origin: c.origin,
          fetched_at: new Date(c.doc.fetchedAt).toISOString(),
          chunk_id: c.chunkId,
          relevance_score: Number(c.score.toFixed(3)),
          coverage: Number(c.coverage.toFixed(3)),
          ...(c.similarity !== undefined ? { similarity: Number(c.similarity.toFixed(3)) } : {}),
          ...(c.webScore !== undefined ? { web_score: Number(c.webScore.toFixed(3)) } : {}),
          ...(trustWeights[c.doc.trust] !== 1 ? { trust_weight: trustWeights[c.doc.trust] } : {}),
        })),
        ...(semantic.error ? { vector_search_error: semantic.error } : {}),
        ...(webError ? { web_search_error: webError } : {}),
      };
    },
  });
}


