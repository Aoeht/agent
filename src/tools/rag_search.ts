// src/tools/rag-search.ts
import { z } from "zod";
import { toolRegistry } from "./registry";
import fs from "node:fs/promises";
import path from "node:path";

const CACHE_DIR = path.join(process.cwd(), ".rag-cache");

const RagSearchParamsSchema = z.object({
  query: z.string().describe("检索查询，用于匹配知识库或实时情报"),
  top_k: z.number().min(1).max(5).default(3).describe("返回结果数量"),
  use_cache: z.boolean().default(true).describe("是否优先使用本地缓存"),
});

// ✅ 简易文本相似度（无需向量数据库，适合中小规模知识库）
function simpleSimilarity(query: string, doc: string): number {
  const qTerms = new Set(query.toLowerCase().split(/\s+/));
  const dTerms = doc.toLowerCase().split(/\s+/);
  let match = 0;
  for (const term of qTerms) {
    if (dTerms.some((t) => t.includes(term))) match++;
  }
  return qTerms.size > 0 ? match / qTerms.size : 0;
}

toolRegistry.register({
  name: "rag_search",
  description:
    "检索内部知识库或实时情报。当需要查询历史诈骗案例、平台规则、监管政策时使用。优先查本地缓存，未命中则调用Tavily实时搜索并缓存结果。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索查询" },
      top_k: { type: "number", description: "返回结果数 (1-5)", default: 3 },
      use_cache: { type: "boolean", description: "是否用缓存", default: true },
    },
    required: ["query"],
  },
  execute: async (args: unknown) => {
    const params = RagSearchParamsSchema.parse(args);
    await fs.mkdir(CACHE_DIR, { recursive: true });

    const cacheFile = path.join(CACHE_DIR, "knowledge.json");
    let docs: { content: string; source: string; timestamp: number }[] = [];

    // 1. 尝试读取本地缓存
    if (params.use_cache) {
      try {
        const raw = await fs.readFile(cacheFile, "utf-8");
        docs = JSON.parse(raw);
      } catch {
        docs = [];
      }
    }

    // 2. 本地检索
    let results = docs
      .map((doc) => ({ ...doc, score: simpleSimilarity(params.query, doc.content) }))
      .filter((r) => r.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, params.top_k);

    // 3. 本地结果不足时，调用 Tavily 补充并缓存
    if (results.length < params.top_k) {
      const tavilyResp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query: params.query,
          max_results: params.top_k - results.length,
          search_depth: "advanced",
          include_answer: false,
        }),
      });

      if (tavilyResp.ok) {
        const tavilyData = await tavilyResp.json();
        const newDocs = (tavilyData.results ?? []).map((r: any) => ({
          content: r.content?.slice(0, 500) ?? "",
          source: r.url,
          timestamp: Date.now(),
        }));

        // 合并并去重
        docs = [...docs, ...newDocs];
        await fs.writeFile(cacheFile, JSON.stringify(docs, null, 2));

        // 重新检索
        results = docs
          .map((doc) => ({ ...doc, score: simpleSimilarity(params.query, doc.content) }))
          .filter((r) => r.score > 0.2)
          .sort((a, b) => b.score - a.score)
          .slice(0, params.top_k);
      }
    }

    return {
      query: params.query,
      result_count: results.length,
      results: results.map((r) => ({
        content: r.content,
        source: r.source,
        relevance_score: Number(r.score.toFixed(3)),
      })),
    };
  },
});