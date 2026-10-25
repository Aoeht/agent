// src/core/tool_search.ts
/**
 * 按需加载（Tool Search）的元工具：工具 schema 总量逼近上下文水位时，每轮请求不再
 * 全量携带工具定义，而是只暴露第一方工具 + 本工具；模型用关键词/正则检索 MCP 工具，
 * 命中的注册进注册表激活集，自下一轮请求起可见可调——OpenAI 协议里模型只能调用
 * 当轮 tools 数组声明过的工具，所以"激活"必然作用于下一轮。
 * 对齐 Anthropic Tool Search Tool 的 deferred loading 思路；激活集只增不减，
 * 会话内持续可用（去 eviction 留给后续：按最近使用淘汰会破坏"激活即承诺"语义）。
 */
import { z } from "zod";
import { isMcpToolName, type ToolRegistry } from "./registry";
import { defineTool } from "./types";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export function createToolSearchTool(options: { registry: ToolRegistry }) {
  const { registry } = options;
  return defineTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description:
      "搜索本会话可按需加载的工具（工具清单较大时，每轮请求只加载了一部分）。" +
      "用关键词或正则匹配工具名与描述；命中的工具自下一轮起可直接调用。" +
      "需要某个还没见过的工具时先在这里检索，不要凭空猜测工具名。" +
      "找不到匹配就换关键词再试一次，仍没有就如实说明能力边界，不要硬凑。",
    schema: z.object({
      query: z.string().min(1).max(200).describe("关键词或正则（不区分大小写），匹配工具名与描述"),
      limit: z.number().int().min(1).max(20).default(8).describe("最多返回条数"),
    }),
    parallelSafe: true,
    needsReconciliation: false,
    execute: async (args) => {
      let matcher: (text: string) => boolean;
      try {
        const re = new RegExp(args.query, "i");
        matcher = (text) => re.test(text);
      } catch {
        const keyword = args.query.toLowerCase();
        matcher = (text) => text.toLowerCase().includes(keyword);
      }
      // 检索池 = 全部 MCP 工具（含已激活的：重复命中无害，激活幂等，
      // 且让模型能把 tool_search 当工具目录用而不只是"解锁器"）
      const pool = registry.list().filter((def) => isMcpToolName(def.name));
      if (pool.length === 0) {
        return {
          matches: [],
          note: "没有可检索的工具：未挂载外部 MCP server，全部工具已在本轮请求中。",
        };
      }
      const matches = pool
        .filter((def) => matcher(`${def.name} ${def.description}`))
        .slice(0, args.limit);
      const activated = registry.activateTools(matches.map((def) => def.name));
      return {
        matches: matches.map((def) => ({ name: def.name, description: def.description })),
        note:
          matches.length === 0
            ? "没有匹配的工具。可换关键词重试；确实没有就如实告知用户，不要编造工具。"
            : `已激活 ${activated.length} 个工具，自下一轮起可直接调用（完整参数 schema 随下一轮请求下发）；` +
              "未匹配的工具保持未加载。",
      };
    },
  });
}
