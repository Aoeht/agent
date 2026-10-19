// src/tools/tavily_client.ts
import { z } from "zod";

const TAVILY_URL = "https://api.tavily.com/search";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TavilySearchRequest {
  query: string;
  maxResults: number;
  searchDepth?: "basic" | "advanced";
  includeAnswer?: boolean;
  /** 抓取正文（而非 Tavily 的摘要片段），供切块入库 */
  includeRawContent?: boolean;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score?: number;
}

export interface TavilyResponse {
  answer?: string;
  results: TavilyResult[];
}

export class TavilyError extends Error {
  override name = "TavilyError";
}

const ResponseSchema = z.object({
  answer: z.string().nullish(),
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string(),
        content: z.string().nullish(),
        raw_content: z.string().nullish(),
        score: z.number().nullish(),
      })
    )
    .nullish(),
});

export async function tavilySearch(request: TavilySearchRequest, fetchImpl: FetchLike = fetch): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new TavilyError("未配置 TAVILY_API_KEY，无法联网检索");

  const timeout = AbortSignal.timeout(request.timeoutMs ?? 20_000);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  // Bun 1.4 的 AbortSignal.timeout() 定时器不 ref 事件循环：若无其它待办，进程会先退出、超时永不触发。
  // 补一个会 clear 的同长度定时器，保证 await 方一定拿到结果。
  let keepAlive: ReturnType<typeof setTimeout> | undefined;
  if (!request.signal) {
    keepAlive = setTimeout(() => void 0, request.timeoutMs ?? 20_000);
  }

  let resp: Response;
  try {
    resp = await fetchImpl(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: request.query,
        max_results: request.maxResults,
        search_depth: request.searchDepth ?? "advanced",
        include_answer: request.includeAnswer ?? false,
        ...(request.includeRawContent ? { include_raw_content: "text" } : {}),
      }),
      signal,
    });
  } catch (error) {
    // 用户/上层取消原样抛出，让 Agent 按取消处理；只有超时才翻译成检索错误
    if (request.signal?.aborted) throw error;
    if (timeout.aborted) throw new TavilyError(`Tavily 请求超时（${request.timeoutMs ?? 20_000}ms）`);
    throw new TavilyError(`Tavily 请求失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (keepAlive) clearTimeout(keepAlive);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new TavilyError(`Tavily API error: ${resp.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
  }

  const data = ResponseSchema.parse(await resp.json());
  return {
    ...(data.answer ? { answer: data.answer } : {}),
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url,
      content: r.content ?? "",
      ...(r.raw_content ? { rawContent: r.raw_content } : {}),
      ...(typeof r.score === "number" ? { score: r.score } : {}),
    })),
  };
}
