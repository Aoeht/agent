import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";
import { tavilySearch } from "./tavily_client";
import { UNTRUSTED_DATA_NOTICE } from "../core/untrusted";

const SearchParamsSchema = z.object({
  query: z.string().describe("Search query for latest fraud patterns or regulations"),
  max_results: z.number().min(1).max(5).default(3).describe("Number of results to return"),
});

/** 工厂形式：DI 场景下由入口显式注册进自己的注册表实例 */
export function createSearchWebTool(): ToolDefinition {
  return defineTool({
    name: "search_web",
    description:
      "Search for time-sensitive information on the web if your pretained knowledge isn't sufficient.",
    schema: SearchParamsSchema,
    parallelSafe: true,
    execute: async (validated, runtime) => {
      const data = await tavilySearch({
        query: validated.query,
        maxResults: validated.max_results,
        searchDepth: "advanced",
        includeAnswer: true,
        signal: runtime?.signal,
      });

      // ✅ 只返回 LLM 需要的精简信息
      return {
        notice: UNTRUSTED_DATA_NOTICE,
        answer: data.answer,
        sources: data.results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content.slice(0, 300),
        })),
      };
    },
  });
}
