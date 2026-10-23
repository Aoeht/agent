// src/core/citations.ts
/**
 * Grounded 引用：把工具结果里的证据来源升级成可溯源的引用。
 *
 * 工作方式（编号注入式，模型无需自行数编号）：
 *   1. 工具返回 JSON 里带 `sources: [{ title, url, snippet }]` 时（search_web / rag_search /
 *      inspect_link 等），Agent 在结果进入上下文前解析并分配全局递增编号；
 *   2. 编号清单以「【引用来源】[1] title (url)」块注入该条 tool 消息头部 —— 模型在最终回答里
 *      用 [n] 指代来源时，编号永远与它见过的块一致；
 *   3. 编号表随 AgentResult / run_end 事件一起透出，CLI 与 Web 把 [n] 渲染成可点击的来源。
 *
 * 跨工具按 url（无 url 时按 title）去重：同一来源被多个工具带回时只占一个编号。
 */

export interface Citation {
  /** 引用编号（1 起，一次 run 内跨工具全局递增） */
  index: number;
  /** 来源标题 */
  title: string;
  /** 来源链接（可为空，如本地文件类来源） */
  url?: string;
  /** 来源摘要（可为空） */
  snippet?: string;
  /** 产出该来源的工具名（排查与 UI 标注用） */
  tool: string;
}

/** 分配编号前的裸来源（index 由 Agent 统一分配） */
export type PendingCitation = Omit<Citation, "index">;

/** 从工具结果 JSON 文本中提取来源列表；非 JSON 或形状不符一律返回 []（安全兼容所有工具） */
export function extractSources(toolName: string, resultText: string): PendingCitation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const sources = (parsed as Record<string, unknown>).sources;
  if (!Array.isArray(sources)) return [];

  const out: PendingCitation[] = [];
  for (const item of sources) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as Record<string, unknown>;
    const title = typeof s.title === "string" ? s.title.trim() : "";
    if (!title) continue;
    const url = typeof s.url === "string" && s.url.trim() ? s.url.trim() : undefined;
    const snippet = typeof s.snippet === "string" && s.snippet.trim() ? s.snippet.trim() : undefined;
    out.push({
      title,
      ...(url !== undefined ? { url } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      tool: toolName,
    });
  }
  return out;
}

/** 渲染注入到 tool 消息头部的引用块（模型可见的编号清单，截断优先保头部所以不会被裁掉） */
export function renderCitationBlock(citations: Citation[]): string {
  if (citations.length === 0) return "";
  const lines = citations.map((c) => {
    const suffix = c.url ? `（${c.url}）` : "";
    return `[${c.index}] ${c.title}${suffix}`;
  });
  // 块头就地写约束：模型最容易模仿紧邻工具结果的格式，这里比系统提示中段更有效
  return `【引用来源】编号只放在被支撑句子的末尾；不要复制本列表，不要把编号放在回答开头\n${lines.join("\n")}`;
}

/**
 * 去掉 tool 消息头部的【引用来源】块，只留工具正文。
 * 摘要观察按字符截断时若从块头开始，编号清单会把真正的结果挤出窗口。
 */
export function stripCitationPreamble(text: string): string {
  if (!text.startsWith("【引用来源】")) return text;
  const separator = text.indexOf("\n\n");
  return separator === -1 ? "" : text.slice(separator + 2);
}

/** RAG 的证据块使用 Agent 已分配的来源编号，避免每次检索从 1 开始。 */
export function bindRagCitationRefs(toolName: string, resultText: string, citations: Citation[]): string {
  if (toolName !== "rag_search") return resultText;
  let parsed: unknown;
  try { parsed = JSON.parse(resultText); } catch { return resultText; }
  if (typeof parsed !== "object" || parsed === null) return resultText;
  const result = parsed as Record<string, unknown>;
  if (!Array.isArray(result.results)) return resultText;
  const bySource = new Map(citations.filter(c => c.url).map(c => [c.url, c.index]));
  result.results = result.results.map((item: unknown) => {
    if (typeof item !== "object" || item === null) return item;
    const { ref: _localRef, ...chunk } = item as Record<string, unknown>;
    const ref = typeof chunk.source === "string" ? bySource.get(chunk.source.trim()) : undefined;
    return ref === undefined ? chunk : { ...chunk, ref };
  });
  return JSON.stringify(result);
}

/** 从最终回答中提取实际被引用的编号（去重、保持出现顺序） */
export function extractCitedIndices(answer: string): number[] {
  const indices: number[] = [];
  const seen = new Set<number>();
  const re = /\[(\d{1,3})\]/g;
  for (let m = re.exec(answer); m !== null; m = re.exec(answer)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 0 && !seen.has(n)) {
      seen.add(n);
      indices.push(n);
    }
  }
  return indices;
}
