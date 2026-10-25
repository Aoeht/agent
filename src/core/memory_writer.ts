// src/core/memory_writer.ts
import path from "node:path";
import OpenAI from "openai";
import { isMemoryType, MemoryStore, MemoryType } from "./memory_store";
import { requestSummaryWithRetry, type SummaryUsage } from "./summary_call";
import type { EmbeddingClient } from "../rag/embeddings";
import { cosineTopK, VectorCache } from "../rag/vector_store";

/**
 * 跨会话记忆写入管线（L3）：每个可记忆的 run（含纯聊天）结束后，从本轮工作记录里单遍提取
 * 「值得跨会话记住的事实」（mem0 的 ADD-only 路线 + Zep 的 supersede 标记），写入全局记忆仓。
 *
 * 判断纪律（写进提取提示词，宁缺毋滥）：大多数轮次应该是 []——只记用户偏好、纠正/确认的
 * 做法、代码里看不出来的项目事实、外部资源位置。查重两级：
 * - 语义级：事实向量 vs 现有条目向量 ≥ 阈值 → 视为已知，跳过（防记忆膨胀）；
 * - 确定性级：MemoryStore.add 自带同类型同文本去重（embedding 未配置时的兜底）。
 * 新事实取代旧条目时不静默覆盖：先 forget 旧条目（打 supersededAt 保留痕迹）再 add。
 */
export const MEMORY_EXTRACT_PROMPT =
  "你是跨会话记忆提取器。从输入的「本轮工作记录」里挑出值得跨会话记住的事实，" +
  "只输出一个 JSON 数组（没有值得记的就输出 []），每个元素形如：\n" +
  '{"type":"user|feedback|project|reference","text":"一句完整自包含的事实","supersedes":"（可选）被它取代的现有记忆原文"}\n' +
  "判断标准（宁缺毋滥，大多数轮次应该是 []）：\n" +
  "- 记：用户角色与偏好；用户纠正你或确认有效的做法；项目里代码与 git 历史看不出来的决策与状态；外部资源位置；\n" +
  "- 不记：一次性对话细节、任务临时状态与进展、能从代码或会话历史推导的内容、工具返回的原始数据、" +
  "与「现有记忆列表」语义重复的内容；\n" +
  "- text 必须脱离本对话也能看懂；supersedes 只在现有记忆列表里有明确被取代条目时填它的原文，否则省略。\n" +
  "不要输出数组以外的任何文字。";

export interface MemoryFact {
  type: MemoryType;
  text: string;
  /** 被本条取代的现有记忆原文；与现有条目精确匹配（无匹配时按新事实追加） */
  supersedes?: string;
}

export interface MemoryWriteReport {
  /** 提取调用的 token 成本 */
  tokens: number;
  added: number;
  superseded: number;
  /** 与已有记忆语义重复而跳过的条数 */
  skipped: number;
}

export interface MemoryWriteOptions {
  store: MemoryStore;
  /** LLM 客户端；缺省首次写入时按环境变量自建（懒加载，避免无 Key 的环境启动即炸） */
  client?: OpenAI;
  /** 主模型（提取调用的回退候选） */
  model: string;
  /** 提取优先用的廉价模型（与摘要模型同一档）；缺省用主模型 */
  summaryModel?: string;
  /** 语义查重的 embedding 客户端；未配置时退化为确定性查重（同类型同文本） */
  embeddings?: EmbeddingClient | null;
  /** 查重向量缓存目录；缺省用 store.dir */
  cacheDir?: string;
  /** 余弦相似度 ≥ 该值视为与已有记忆重复；默认 0.85 */
  similarityThreshold?: number;
  /** 单次 run 最多写入几条事实，防提取失控；默认 8 */
  maxFactsPerRun?: number;
}

const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_MAX_FACTS = 8;
/** 语义查重缓存的条目上限：记忆条目数 + 提取事实数，几百封顶绰绰有余 */
const DEDUP_CACHE_MAX_ENTRIES = 4000;

export class MemoryWriter {
  private readonly store: MemoryStore;
  private readonly model: string;
  private readonly summaryModel: string | undefined;
  private readonly embeddings: EmbeddingClient | undefined;
  private readonly cacheDir: string;
  private readonly threshold: number;
  private readonly maxFacts: number;
  private client: OpenAI | undefined;
  private dedupCache: VectorCache | undefined;

  constructor(options: MemoryWriteOptions) {
    this.store = options.store;
    this.client = options.client;
    this.model = options.model;
    this.summaryModel = options.summaryModel;
    this.embeddings = options.embeddings ?? undefined;
    this.cacheDir = options.cacheDir ?? options.store.dir;
    this.threshold = options.similarityThreshold ?? DEFAULT_THRESHOLD;
    this.maxFacts = options.maxFactsPerRun ?? DEFAULT_MAX_FACTS;
  }

  /**
   * 从一轮工作记录提取并写入记忆。LLM 失败/输出不可解析时抛出（调用方转成
   * memory_failed 事件）；提取出的零条事实是正常结果（大多数轮次就该如此）。
   * summaryModel：调用方（Agent）的会话级摘要模型覆盖，缺省用构造时的默认。
   */
  async writeFromRun(
    digest: string,
    opts: { sourceSessionId?: string | undefined; summaryModel?: string | undefined; signal?: AbortSignal | undefined } = {}
  ): Promise<MemoryWriteReport> {
    const active = await this.store.active();
    const existingIndex = this.store.renderIndex(active) || "（暂无）";
    const input = `现有记忆列表：\n${existingIndex}\n\n本轮工作记录：\n${digest}`;
    const usage = await this.requestExtraction(input, opts.signal, opts.summaryModel);
    const facts = this.parseFacts(usage.content).slice(0, this.maxFacts);
    if (facts.length === 0) {
      return { tokens: usage.tokens, added: 0, superseded: 0, skipped: 0 };
    }

    const duplicates = await this.findSemanticDuplicates(facts, active);
    let added = 0;
    let superseded = 0;
    let skipped = 0;
    for (const fact of facts) {
      const duplicate = duplicates.get(fact.text);
      const supersedesTarget = this.matchSupersedeTarget(fact, active, duplicate);
      if (!fact.supersedes && duplicate !== undefined) {
        skipped++; // 已知事实，不重复记
        continue;
      }
      if (supersedesTarget !== undefined) {
        if (await this.store.forget(supersedesTarget.id)) superseded++;
      }
      const entry = await this.store.add({ type: fact.type, text: fact.text, ...(opts.sourceSessionId !== undefined ? { sourceSessionId: opts.sourceSessionId } : {}) });
      if (entry) added++;
    }
    return { tokens: usage.tokens, added, superseded, skipped };
  }

  /**
   * 语义查重：事实向量 vs 现有条目向量，余弦 ≥ 阈值记为重复。
   * embedding 未配置时返回空表（退化到 store 的确定性去重）。
   */
  private async findSemanticDuplicates(
    facts: MemoryFact[],
    active: Awaited<ReturnType<MemoryStore["active"]>>
  ): Promise<Map<string, number>> {
    if (!this.embeddings || facts.length === 0 || active.length === 0) return new Map();
    this.dedupCache ??= new VectorCache({
      filePath: path.join(this.cacheDir, "write-vectors.json"),
      model: this.embeddings.model,
      maxEntries: DEDUP_CACHE_MAX_ENTRIES,
    });
    const factTexts = facts.map((fact) => fact.text);
    const vectors = await this.dedupCache.ensure(
      [...factTexts, ...active.map((entry) => entry.text)],
      (batch) => this.embeddings!.embed(batch)
    );
    const entries = new Map(
      active
        .map((entry) => [entry.text, vectors.get(entry.text)])
        .filter((pair): pair is [string, number[]] => pair[1] !== undefined)
    );
    const result = new Map<string, number>();
    for (const text of factTexts) {
      const factVector = vectors.get(text);
      if (!factVector) continue;
      const [best] = cosineTopK(factVector, entries, 1, this.threshold);
      if (best) result.set(text, best.similarity);
    }
    return result;
  }

  /** supersedes 的落点：原文精确匹配优先，退而取语义重复命中的那条 */
  private matchSupersedeTarget(
    fact: MemoryFact,
    active: Array<{ id: string; text: string }>,
    duplicate: number | undefined
  ): { id: string } | undefined {
    if (fact.supersedes === undefined && duplicate === undefined) return undefined;
    if (fact.supersedes !== undefined) {
      const exact = active.find((entry) => entry.text === fact.supersedes);
      if (exact) return { id: exact.id };
    }
    return undefined; // 语义命中的取代需要 LLM 明确指认，不做相似度自动取代（宁漏勿错）
  }

  private async requestExtraction(
    input: string,
    signal?: AbortSignal | undefined,
    summaryModelOverride?: string | undefined
  ): Promise<{ content: string; tokens: number }> {
    this.client ??= new OpenAI({ maxRetries: 1, timeout: 60_000 });
    const client = this.client;
    const messages = [
      { role: "system" as const, content: MEMORY_EXTRACT_PROMPT },
      { role: "user" as const, content: input },
    ];
    const result = await requestSummaryWithRetry({
      models: [summaryModelOverride ?? this.summaryModel ?? this.model, this.model],
      signal,
      call: async (model) => {
        const resp = await client.chat.completions.create(
          { model, messages, max_tokens: 1200, temperature: 0 },
          signal ? { signal } : {}
        );
        const usage: SummaryUsage | undefined = resp.usage
          ? {
              promptTokens: resp.usage.prompt_tokens ?? 0,
              completionTokens: resp.usage.completion_tokens ?? 0,
              totalTokens: resp.usage.total_tokens ?? 0,
            }
          : undefined;
        return { content: resp.choices[0]?.message?.content ?? "", ...(usage ? { usage } : {}) };
      },
    });
    return { content: result.content, tokens: result.usage?.totalTokens ?? 0 };
  }

  /** 宽容解析：剥掉 markdown 围栏后取首尾方括号之间的 JSON 数组 */
  private parseFacts(content: string): MemoryFact[] {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start === -1 || end <= start) {
      throw new Error(`记忆提取输出不是 JSON 数组：${content.slice(0, 120)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch (error) {
      throw new Error(`记忆提取 JSON 解析失败：${error instanceof Error ? error.message : error}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("记忆提取输出不是 JSON 数组");
    }
    const facts: MemoryFact[] = [];
    for (const item of parsed) {
      const record = item as { type?: unknown; text?: unknown; supersedes?: unknown };
      const type = String(record.type ?? "");
      if (!isMemoryType(type) || typeof record.text !== "string" || record.text.trim() === "") continue;
      facts.push({
        type,
        text: record.text.trim(),
        ...(typeof record.supersedes === "string" && record.supersedes.trim() !== ""
          ? { supersedes: record.supersedes.trim() }
          : {}),
      });
    }
    return facts;
  }
}
