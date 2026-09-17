import { z } from "zod";
import { toolRegistry } from "./registry";

const SearchParamsSchema = z.object({
  query: z.string().describe("Search query for latest fraud patterns or regulations"),
  max_results: z.number().min(1).max(5).default(3).describe("Number of results to return"),
});

toolRegistry.register({
  name: "search_fraud_intel",
  description:
    "Search for latest scam tactics, regulatory updates, or fraud case examples. Use when encountering unfamiliar fraud patterns.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "number", description: "Max results (1-5)", default: 3 },
    },
    required: ["query"],
  },
  execute: async (args: unknown) => {
    const validated = SearchParamsSchema.parse(args);

    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query: validated.query,
        max_results: validated.max_results,
        search_depth: "advanced",
        include_answer: true,
      }),
    });

    if (!resp.ok) throw new Error(`Tavily API error: ${resp.status}`);
    const data = await resp.json();

    // ✅ 只返回 LLM 需要的精简信息
    return {
      answer: data.answer,
      sources: data.results?.map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.content?.slice(0, 300),
      })) ?? [],
    };
  },
});