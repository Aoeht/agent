// src/core/context_manager.ts
import OpenAI from "openai";
import { Message } from "./types";
import { CommercialTokenCounter } from "../utils/token_counter";
import { wrapSummaryBlock } from "./untrusted";
import {
  stripCitationPreamble,
  citationPreambleOf,
  parseCitationLines,
  renderCitationDigest,
} from "./citations";
import { requestSummaryWithRetry } from "./summary_call";
import type { CompactEvent } from "./events";
import {
  SUMMARY_FRESH_PROMPT,
  SUMMARY_MERGE_PROMPT,
  summaryMaxTokensFor,
} from "./summary_prompts";

interface ContextConfig {
  modelName: string;
  maxTokens: number;        // 模型上下文上限
  compressThreshold?: number; // 触发压缩的安全水位，如 100,000 (留出 buffer)
  reserveTokens: number;    // 预留给当前回复的token
  summaryModel: string;     // 用于摘要的廉价模型
  client: OpenAI;           // LLM 客户端由外部注入，内部不再自建
}

/** 摘要连续失败多少次后放弃 LLM 摘要，改用硬截断兜底 */
const MAX_SUMMARY_FAILURES = 3;

/** 摘要输入 token 上限：折叠量极大时先中段截断，别让摘要调用自己先爆上下文 */
const SUMMARY_INPUT_TOKEN_CAP = 20_000;

/** 阶梯 3 复核裁剪时，单条最新工具输出至少保留的 token（低于它等于没留观察） */
const MIN_TOOL_OUTPUT_TOKENS = 120;

/** 一次工具组的定位：[start, end) 是它在 messages 里的下标区间（含 owner assistant）。 */
interface ToolGroupSpan {
  start: number;
  end: number;
}

interface MessageAnalysis {
  systemMsgs: Message[];
  pinned: Message[];
  /** 普通对话（user + 无 tool_calls 的 assistant），不含 system 与 pinned */
  conv: Message[];
  groups: ToolGroupSpan[];
}

export class ContextManager {
  private client: OpenAI;
  private config: ContextConfig;
  private tokenCounter: CommercialTokenCounter;
  // 滚动摘要：已折叠历史累积出的摘要文本（增量维护，跨调用复用）
  private rollingSummary: string | null = null;
  // 已折叠进摘要的普通对话条数（conv 去掉 system/pinned 后的前缀长度，只增不减）
  private foldedCount = 0;
  // 已并入摘要的工具组数（下标水位，只增不减）：同一批观察不重复喂摘要
  private foldedGroupCount = 0;
  // 摘要块消息缓存：仅在摘要更新时重建，保证跨请求前缀引用稳定
  private summaryBlock: Message[] | null = null;
  // 钉住前缀：永远原样保留、永不折叠的消息（跨 run 长期摘要块）。按对象身份识别。
  private pinnedPrefix: Message[] = [];
  private pinnedSet = new Set<Message>();
  // 每请求消息之外的固定开销（工具 schema 等），计入越线判断
  private overheadTokens = 0;
  // 估算校准：actual/estimate 的 EMA。估算盲区（图片、tokenizer 误差）靠它吸收，
  // 钳在 [1, 3]：只允许"更保守"，估算偏大时不会推迟压缩。
  private calibrationRatio = 1;
  // 每条消息原始内容的 token 缓存：run 内消息 append-only，按对象身份缓存一次测量
  private tokenCache = new WeakMap<Message, { original: number; stubText?: string; stubTokens?: number }>();
  // 阶梯去重：同一 run 内某级压缩只发一次事件，避免每步刷屏
  private reachedStage = 0;
  // 摘要连续失败计数：达到上限后本 run 不再尝试 LLM 摘要，直接硬截断
  private summaryFailures = 0;

  /** 摘要调用产生 token 时的记账回调（Agent 用来喂 RunBudget 与总账） */
  onSummaryUsage: ((usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void) | null = null;
  /** 压缩动作的可观测性回调（Agent 转发到事件总线） */
  onCompact: ((event: CompactEvent) => void) | null = null;

  constructor(config: ContextConfig) {
    this.client = config.client;
    this.config = config;
    this.tokenCounter = new CommercialTokenCounter();
  }

  /** 一个 Agent.run 对应一段独立的消息序列，不能复用上一轮 run 的折叠水位或摘要。 */
  reset(): void {
    this.rollingSummary = null;
    this.foldedCount = 0;
    this.foldedGroupCount = 0;
    this.summaryBlock = null;
    this.pinnedPrefix = [];
    this.pinnedSet = new Set();
    this.reachedStage = 0;
    this.summaryFailures = 0;
    this.tokenCache = new WeakMap();
  }

  /**
   * 切换主模型：token 估算与窗口按新模型走（压缩摘要模型不变，它由 summaryModel 指定）。
   * 只影响后续 run —— 已经折叠出的摘要文本不需要重算。
   */
  setModel(modelName: string, maxTokens?: number): void {
    this.config.modelName = modelName;
    if (maxTokens !== undefined) this.config.maxTokens = maxTokens;
  }

  /** 会话级切换摘要模型（压缩/折叠调用）：config.summaryModel 每次请求时现读，改完即生效 */
  setSummaryModel(modelName: string): void {
    const trimmed = modelName.trim();
    if (trimmed !== "") this.config.summaryModel = trimmed;
  }

  /**
   * 设置钉住前缀（跨 run 长期摘要块）：它在每次表示里都排在最前、永不折叠也不进摘要。
   * 每次 run 都要重新设置（reset 会清空），传空数组表示本 run 没有。
   */
  setPinnedPrefix(messages: Message[]): void {
    this.pinnedPrefix = [...messages];
    this.pinnedSet = new Set(messages);
  }

  /** 设置每请求的固定 token 开销（工具 schema 等），计入越线判断 */
  setRequestOverheadTokens(tokens: number): void {
    this.overheadTokens = Math.max(0, Math.floor(tokens));
  }

  /**
   * 用真实 usage 校准估算：估算盲区（图片、tokenizer 词表差异、协议开销）表现为
   * actual/estimate 的比值，EMA 平滑后乘到后续估算上。
   */
  recordPromptUsage(messages: Message[], actualPromptTokens: number): void {
    if (actualPromptTokens <= 0) return;
    const estimate = this.estimateTokens(messages) + this.overheadTokens;
    if (estimate <= 0) return;
    const ratio = actualPromptTokens / estimate;
    this.calibrationRatio = Math.min(3, Math.max(1, this.calibrationRatio * 0.7 + ratio * 0.3));
  }

  private estimateTokens(messages: Message[]): number {
    let total = 0;
    for (const msg of messages) {
      // 每条消息有固定的协议开销 (~4 tokens)
      total += 4 + this.entryFor(msg).original;
    }
    return total;
  }

  /** 越线判断用的估算：原始估算 + 固定开销，再乘校准比（只放大不缩小） */
  private effectiveTokens(rawEstimate: number): number {
    return Math.ceil((rawEstimate + this.overheadTokens) * this.calibrationRatio);
  }

  private entryFor(msg: Message): { original: number; stubText?: string; stubTokens?: number } {
    let entry = this.tokenCache.get(msg);
    if (!entry) {
      entry = { original: this.measure(msg) };
      this.tokenCache.set(msg, entry);
    }
    return entry;
  }

  private measure(msg: Message): number {
    let total = 0;
    if (typeof msg.content === "string") {
      total += this.tokenCounter.estimateText(msg.content, this.config.modelName);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          total += this.tokenCounter.estimateText(part.text, this.config.modelName);
        }
      }
    }
    if ("tool_calls" in msg && msg.tool_calls) {
      total += this.tokenCounter.estimateText(JSON.stringify(msg.tool_calls), this.config.modelName);
    }
    if ("tool_call_id" in msg && msg.tool_call_id) {
      total += this.tokenCounter.estimateText(msg.tool_call_id, this.config.modelName);
    }
    return total;
  }

  /** 把普通 user/assistant 对话按完整轮分组，窗口与摘要都只能在轮边界处分割。 */
  private conversationGroups(conv: Message[]): Message[][] {
    const groups: Message[][] = [];
    let pending: Message[] = [];
    for (const message of conv) {
      if (message.role === "user") {
        if (pending.length > 0) groups.push(pending);
        pending = [message];
      } else if (message.role === "assistant") {
        if (pending.length > 0) {
          pending.push(message);
          groups.push(pending);
          pending = [];
        } else {
          groups.push([message]);
        }
      }
    }
    if (pending.length > 0) groups.push(pending);
    return groups;
  }

  /**
   * 一次遍历完成消息分类：system / pinned / 普通对话 / 工具组。
   * 工具组 = assistant(tool_calls) + 紧随其后的全部 tool 响应。
   */
  private analyze(messages: Message[]): MessageAnalysis {
    const systemMsgs: Message[] = [];
    const pinned: Message[] = [];
    const conv: Message[] = [];
    const groups: ToolGroupSpan[] = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === "system") {
        systemMsgs.push(message);
        continue;
      }
      if (this.pinnedSet.has(message)) {
        pinned.push(message);
        continue;
      }
      if (message.role === "user" || (message.role === "assistant" && !message.tool_calls?.length)) {
        conv.push(message);
        continue;
      }
      if (message.role === "assistant" && message.tool_calls?.length) {
        let end = i + 1;
        while (end < messages.length && messages[end]!.role === "tool") end++;
        groups.push({ start: i, end });
        i = end - 1; // for 循环的 i++ 会跳到 end
      }
      // 孤立的 tool 消息（没有 owner）不该出现，直接跳过
    }
    return { systemMsgs, pinned, conv, groups };
  }

  /** 旧工具消息的占位文本：保留"调用过什么、参数是什么"，只省输出。确定性生成，可缓存。 */
  private stubEntryFor(toolMsg: Message & { role: "tool" }, owner: Message) {
    const entry = this.entryFor(toolMsg);
    if (entry.stubText !== undefined) return entry;
    const calls = owner.role === "assistant" ? owner.tool_calls : undefined;
    const call = calls?.find((c) => c.id === toolMsg.tool_call_id);
    const name = call?.function.name ?? "unknown_tool";
    const rawArgs = call?.function.arguments ?? "";
    const argsPreview = rawArgs.length > 120 ? `${rawArgs.slice(0, 120)}…` : rawArgs;
    // 引用块是编号→来源的映射，不随工具正文一起省略；否则模型记忆里的 [n] 会失去出处
    const preamble = citationPreambleOf(toolMsg.content);
    entry.stubText = `[工具输出已省略以节省上下文：原约 ${entry.original} tokens。此前调用了 ${name}(${argsPreview})。]${preamble ? `\n\n${preamble}` : ""}`;
    entry.stubTokens = 4 + this.tokenCounter.estimateText(entry.stubText, this.config.modelName);
    return entry;
  }

  /** 中段截断：保留头尾，掐掉中间（最早的原始请求和最近的进展通常都重要） */
  private clipMiddle(text: string, tokenCap: number): string {
    const tokens = this.tokenCounter.estimateText(text, this.config.summaryModel);
    if (tokens <= tokenCap) return text;
    const charsPerToken = text.length / tokens;
    const headChars = Math.floor(charsPerToken * tokenCap * 0.3);
    const tailChars = Math.floor(charsPerToken * tokenCap * 0.7);
    return `${text.slice(0, headChars)}\n…[此处省略约 ${tokens - tokenCap} tokens]…\n${text.slice(text.length - tailChars)}`;
  }

  /**
   * 上下文压缩的降级阶梯（每级只在上一级不够时才启用）：
   * 0. 原样发送；
   * 1. 旧工具输出替换为占位符（保留调用与参数，模型知道"我做过什么"）；
   * 2. 旧工具组整体移出请求（最新待消费的完整工具组永远原样保留）；
   * 3. 旧对话轮折叠进滚动摘要（结构化 8 节，工具观察一并并入）。
   * emergency（API 已报上下文超限）：跳过 0-2 的越线判断直接做 3，最近窗口压到 15%。
   */
  async compress(
    messages: Message[],
    opts: { emergency?: boolean; signal?: AbortSignal | undefined } = {}
  ): Promise<Message[]> {
    if (messages.length <= 2) return messages;
    const emergency = opts.emergency === true;
    const { systemMsgs, pinned, conv, groups } = this.analyze(messages);

    // 消息序列变短（外部直接复用本类、新 run 未 reset）时折叠水位失效，全部重来
    if (this.foldedCount > conv.length) {
      this.rollingSummary = null;
      this.foldedCount = 0;
      this.foldedGroupCount = 0;
      this.summaryBlock = null;
      this.reachedStage = 0;
      this.summaryFailures = 0;
    }
    // 工具组变少（同上）时水位回落到当前可观察范围
    this.foldedGroupCount = Math.min(this.foldedGroupCount, Math.max(0, groups.length - 1));

    const budget = this.config.compressThreshold ?? this.config.maxTokens - this.config.reserveTokens;

    if (!emergency) {
      if (this.effectiveTokens(this.estimateTokens(messages)) <= budget) return messages;

      if (groups.length > 1) {
        const { stubbedEstimate, droppedEstimate } = this.ladderEstimates(messages, groups);
        if (stubbedEstimate !== null && this.effectiveTokens(stubbedEstimate) <= budget) {
          this.notifyStage(1, {
            action: "stub_tool_outputs",
            tokens: this.estimateTokens(messages) - stubbedEstimate,
          });
          return this.buildWithStubs(messages, groups);
        }
        if (droppedEstimate !== null && this.effectiveTokens(droppedEstimate) <= budget) {
          this.notifyStage(2, {
            action: "drop_tool_history",
            tokens: this.estimateTokens(messages) - droppedEstimate,
          });
          return this.buildWithoutOldGroups(messages, groups);
        }
      }
    }

    // 阶梯 3：滚动摘要。摘要不可用（连续失败达上限）时硬截断兜底，保证请求能进窗口。
    const recentRatio = emergency ? 0.15 : 0.4;
    const recentBudget = Math.floor(budget * recentRatio);
    const convGroups = this.conversationGroups(conv);
    let windowStart = conv.length;
    let recentTokens = 0;
    for (let i = convGroups.length - 1; i >= 0; i--) {
      const group = convGroups[i]!;
      const groupTokens = this.estimateTokens(group);
      if (recentTokens + groupTokens > recentBudget) {
        // 最近一轮自己就超预算时仍要保留它，否则模型连当前问题都看不到
        if (i === convGroups.length - 1 && recentTokens === 0) windowStart -= group.length;
        break;
      }
      recentTokens += groupTokens;
      windowStart -= group.length;
    }

    const foldTarget = Math.max(windowStart, this.foldedCount);
    const unobservedGroups = Math.max(0, groups.length - 1 - this.foldedGroupCount);
    const canSummarize = this.summaryFailures < MAX_SUMMARY_FAILURES;
    // 有新对话要折叠，或旧工具组还没进过摘要（典型 ReAct 回合里对话只有开头一条 user，
    // 此时 foldTarget 恒为 0，但 stage 3 已经要丢掉旧工具组），都要合并一次。
    if (canSummarize && (foldTarget > this.foldedCount || unobservedGroups > 0)) {
      const observations = this.collectToolObservations(messages, groups);
      if (foldTarget > this.foldedCount || observations.length > 0) {
        try {
          this.rollingSummary = await this.mergeSummary(
            this.rollingSummary,
            conv.slice(this.foldedCount, foldTarget),
            observations,
            opts.signal
          );
          this.foldedCount = foldTarget;
          this.foldedGroupCount = groups.length - 1;
          this.summaryBlock = null;
          this.summaryFailures = 0;
          this.onCompact?.({
            action: "fold_summary",
            messages: foldTarget,
            detail: `${observations.length} 条工具观察并入摘要`,
          });
        } catch (error) {
          this.summaryFailures++;
          this.onCompact?.({
            action: "summary_failed",
            detail: `${error instanceof Error ? error.message : String(error)}（连续第 ${this.summaryFailures} 次）`,
          });
          if (!emergency) {
            // 摘要失败不折叠：不丢消息，先返回阶梯 2 的无损表示，下轮迭代再试摘要
            return groups.length > 1 ? this.buildWithoutOldGroups(messages, groups) : messages;
          }
          return this.hardTruncate(messages, { systemMsgs, pinned, conv, groups });
        }
      } else {
        // 可观察的工具组里没有文本（如纯图片结果）：水位前进，避免每轮重复检查
        this.foldedGroupCount = groups.length - 1;
      }
    } else if (!canSummarize) {
      return this.hardTruncate(messages, { systemMsgs, pinned, conv, groups });
    }

    return this.stage3Representation(messages, { systemMsgs, pinned, conv, groups }, budget);
  }

  /** 阶梯 1/2 的估算值：不物化数组，直接在原估算上做增减（groups > 1 时才有意义） */
  private ladderEstimates(messages: Message[], groups: ToolGroupSpan[]): {
    stubbedEstimate: number | null;
    droppedEstimate: number | null;
  } {
    if (groups.length <= 1) return { stubbedEstimate: null, droppedEstimate: null };
    const base = this.estimateTokens(messages);
    let toolSaved = 0;
    let stubAdded = 0;
    let groupSaved = 0;
    for (let g = 0; g < groups.length - 1; g++) {
      const span = groups[g]!;
      groupSaved += (span.end - span.start) * 4;
      for (let i = span.start; i < span.end; i++) {
        const msg = messages[i]!;
        groupSaved += this.entryFor(msg).original;
        if (msg.role === "tool") {
          toolSaved += this.entryFor(msg).original;
          stubAdded += this.stubEntryFor(msg, messages[span.start]!).stubTokens ?? 0;
        }
      }
    }
    const digest = this.droppedCitationDigest(messages, groups);
    return {
      stubbedEstimate: base - toolSaved + stubAdded,
      droppedEstimate: base - groupSaved + (digest ? this.estimateTokens(this.citationDigestBlock(digest)) : 0),
    };
  }

  /**
   * 旧工具组被移出请求后，把其中引用块里的来源行收成一条索引，编号映射不随输出消失。
   * 最新组仍原样保留在请求里，它的编号不重复列；没有可保留的来源时返回 null。
   */
  private droppedCitationDigest(messages: Message[], groups: ToolGroupSpan[]): string | null {
    if (groups.length <= 1) return null;
    const latest = groups[groups.length - 1]!;
    const visible = new Set<number>();
    for (let i = latest.start + 1; i < latest.end; i++) {
      const message = messages[i]!;
      if (message.role !== "tool") continue;
      for (const entry of parseCitationLines(citationPreambleOf(message.content))) visible.add(entry.index);
    }
    const seen = new Set<number>();
    const lines: string[] = [];
    for (let g = 0; g < groups.length - 1; g++) {
      const span = groups[g]!;
      for (let i = span.start + 1; i < span.end; i++) {
        const message = messages[i]!;
        if (message.role !== "tool") continue;
        for (const entry of parseCitationLines(citationPreambleOf(message.content))) {
          if (visible.has(entry.index) || seen.has(entry.index)) continue;
          seen.add(entry.index);
          lines.push(entry.line);
        }
      }
    }
    return lines.length ? renderCitationDigest(lines) : null;
  }

  /** 索引块成对注入，保持 user/assistant 交替，与摘要块同构 */
  private citationDigestBlock(text: string): Message[] {
    return [
      { role: "user", content: text },
      { role: "assistant", content: "收到，以上来源编号保持不变，我会按编号引用。" },
    ];
  }

  /** 阶梯 1 表示：旧工具组的 tool 输出替换为占位符，assistant 的调用与参数原样保留 */
  private buildWithStubs(messages: Message[], groups: ToolGroupSpan[]): Message[] {
    const owners = new Map<number, Message>();
    for (let g = 0; g < groups.length - 1; g++) {
      const span = groups[g]!;
      for (let i = span.start + 1; i < span.end; i++) owners.set(i, messages[span.start]!);
    }
    return messages.map((message, index) => {
      const owner = owners.get(index);
      if (!owner || message.role !== "tool") return message;
      return { ...message, content: this.stubEntryFor(message, owner).stubText! };
    });
  }

  /** 阶梯 2 表示：旧工具组（owner + 响应）整体移出，只留最新一组；引用编号转成索引块留在 system 之后 */
  private buildWithoutOldGroups(messages: Message[], groups: ToolGroupSpan[]): Message[] {
    const dropped = new Set<number>();
    for (let g = 0; g < groups.length - 1; g++) {
      for (let i = groups[g]!.start; i < groups[g]!.end; i++) dropped.add(i);
    }
    const kept = messages.filter((_, index) => !dropped.has(index));
    const digest = this.droppedCitationDigest(messages, groups);
    if (!digest) return kept;
    let insertAt = 0;
    while (insertAt < kept.length && kept[insertAt]!.role === "system") insertAt++;
    kept.splice(insertAt, 0, ...this.citationDigestBlock(digest));
    return kept;
  }

  /**
   * 工具观察（给摘要当输入）：阶梯 3 会把「除最新组外」的所有工具组从请求里丢掉，
   * 它们的关键结果必须先并入摘要，否则 run 内最重要的观察就无声消失了。
   * 只取尚未并入摘要的旧工具组（foldedGroupCount 水位），同一批观察不重复喂。
   * 每条先剥掉引用块再截断——编号清单不是工具结果，不能挤占观察窗口。
   */
  private collectToolObservations(messages: Message[], groups: ToolGroupSpan[]): string[] {
    const out: string[] = [];
    const endGroup = groups.length - 1; // 最新一组还留在请求里，不用并入摘要
    for (let g = this.foldedGroupCount; g < endGroup; g++) {
      const span = groups[g]!;
      const owner = messages[span.start]!;
      const calls = owner.role === "assistant" ? owner.tool_calls : undefined;
      for (let i = span.start + 1; i < span.end; i++) {
        const toolMsg = messages[i]!;
        if (toolMsg.role !== "tool" || typeof toolMsg.content !== "string") continue;
        const body = stripCitationPreamble(toolMsg.content);
        if (!body.trim()) continue;
        const call = calls?.find((c) => c.id === toolMsg.tool_call_id);
        const name = call?.function.name ?? "unknown_tool";
        const args = (call?.function.arguments ?? "").slice(0, 200);
        out.push(`${name}(${args}) → ${body.slice(0, 800)}`);
      }
    }
    return out.length > 8 ? [...out.slice(-8), `（更早的 ${out.length - 8} 条工具观察已省略）`] : out;
  }

  /**
   * 阶梯 3 表示：「system + 钉住前缀 + 摘要块 + 未折叠对话 + 最新工具组」。
   * 这一层也可能超预算：最新工具组不受阶梯 2 约束，摘要块与钉住前缀又没有上限。
   * 出手前复核一次尺寸：先按体积裁最新工具输出（保头留尾），再从旧到新丢未折叠对话。
   * 只改本次请求的表示，不动 foldedCount——被丢的对话仍留给后续折叠进摘要。
   */
  private stage3Representation(messages: Message[], parts: MessageAnalysis, budget: number): Message[] {
    const head: Message[] = [...parts.systemMsgs, ...parts.pinned];
    if (this.rollingSummary !== null) {
      head.push(
        ...(this.summaryBlock ?? (this.summaryBlock = [
          { role: "user", content: wrapSummaryBlock("历史上下文摘要", this.rollingSummary) },
          { role: "assistant", content: "收到，我已了解以上历史摘要。" },
        ]))
      );
    }
    // 旧工具组被移出请求后，编号→来源的映射改由索引块承载
    const digest = this.droppedCitationDigest(messages, parts.groups);
    if (digest) head.push(...this.citationDigestBlock(digest));
    let convGroups = this.conversationGroups(parts.conv.slice(this.foldedCount));
    const latestSpan = parts.groups[parts.groups.length - 1];
    const latest = latestSpan ? messages.slice(latestSpan.start, latestSpan.end) : [];
    const compose = (): Message[] => [...head, ...convGroups.flat(), ...latest];

    let result = compose();
    const initial = this.effectiveTokens(this.estimateTokens(result));
    if (initial <= budget) return result;

    // 1) 最新工具输出从大到小裁到预算内（同一组里先裁最占地方的那条）
    const toolOutputs: Array<{ index: number; tokens: number }> = [];
    latest.forEach((message, index) => {
      if (message.role === "tool") {
        toolOutputs.push({ index, tokens: this.tokenCounter.estimateText(message.content, this.config.modelName) });
      }
    });
    toolOutputs.sort((a, b) => b.tokens - a.tokens);
    let clipped = 0;
    let size = initial;
    for (const { index, tokens } of toolOutputs) {
      if (size <= budget) break;
      const message = latest[index]!;
      if (message.role !== "tool" || tokens <= MIN_TOOL_OUTPUT_TOKENS) continue;
      const rawExcess = Math.ceil((size - budget) / this.calibrationRatio);
      const keep = Math.max(MIN_TOOL_OUTPUT_TOKENS, tokens - rawExcess);
      if (keep >= tokens) continue;
      latest[index] = { ...message, content: this.clipToTokens(message.content, keep) };
      result = compose();
      size = this.effectiveTokens(this.estimateTokens(result));
      clipped++;
    }

    // 2) 仍超预算：从最旧的未折叠轮开始丢，至少留下最近一轮（当前问题）
    let droppedMessages = 0;
    while (size > budget && convGroups.length > 1) {
      droppedMessages += convGroups[0]!.length;
      convGroups = convGroups.slice(1);
      result = compose();
      size = this.effectiveTokens(this.estimateTokens(result));
    }

    if (clipped > 0 || droppedMessages > 0) {
      this.onCompact?.({
        action: "stage3_clip",
        messages: droppedMessages,
        tokens: Math.max(0, initial - size),
        detail: `阶梯 3 表示仍超预算：裁剪 ${clipped} 条最新工具输出${droppedMessages ? `，丢弃 ${droppedMessages} 条更早对话` : ""}`,
      });
    }
    return result;
  }

  /** 按 token 预算保头留尾、掐掉中段；给阶梯 3 复核裁剪最新工具输出用 */
  private clipToTokens(text: string, tokenCap: number): string {
    // 引用块必须整块保留：裁剪后编号仍然要对得上来源，正文才是可以省的部分
    const preamble = citationPreambleOf(text);
    if (preamble) {
      const body = stripCitationPreamble(text);
      const preambleTokens = this.tokenCounter.estimateText(preamble, this.config.modelName);
      return body
        ? `${preamble}\n\n${this.clipPlainToTokens(body, Math.max(MIN_TOOL_OUTPUT_TOKENS, tokenCap - preambleTokens))}`
        : preamble;
    }
    return this.clipPlainToTokens(text, tokenCap);
  }

  private clipPlainToTokens(text: string, tokenCap: number): string {
    const total = this.tokenCounter.estimateText(text, this.config.modelName);
    if (total <= tokenCap) return text;
    const headCap = Math.floor(tokenCap * 0.3);
    const head = this.takeTokenPrefix(text, headCap);
    const tail = this.takeTokenSuffix(text, tokenCap - headCap);
    return `${head}\n…[此处省略约 ${Math.max(1, total - tokenCap)} tokens 以适应上下文]…\n${tail}`;
  }

  /** 二分找最长前缀：token 数随前缀长度近似单调，头尾各探 O(log n) 次 */
  private takeTokenPrefix(text: string, cap: number): string {
    if (cap <= 0) return "";
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.tokenCounter.estimateText(text.slice(0, mid), this.config.modelName) <= cap) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo);
  }

  private takeTokenSuffix(text: string, cap: number): string {
    if (cap <= 0) return "";
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this.tokenCounter.estimateText(text.slice(mid), this.config.modelName) <= cap) hi = mid;
      else lo = mid + 1;
    }
    return text.slice(lo);
  }

  /** 最后兜底：摘要不可用时按轮硬截断，只保留预算 25% 内的最近对话 + 最新工具组 */
  private hardTruncate(messages: Message[], parts: MessageAnalysis): Message[] {
    const budget = this.config.compressThreshold ?? this.config.maxTokens - this.config.reserveTokens;
    const keepBudget = Math.floor(budget * 0.25);
    const convGroups = this.conversationGroups(parts.conv);
    let used = 0;
    let start = parts.conv.length;
    for (let i = convGroups.length - 1; i >= 0; i--) {
      const groupTokens = this.estimateTokens(convGroups[i]!);
      if (used + groupTokens > keepBudget) break;
      used += groupTokens;
      start -= convGroups[i]!.length;
    }
    // 被截掉的对话不再出现在任何表示里，水位推到截断点，后续折叠不会再碰它们
    this.foldedCount = Math.max(this.foldedCount, start);
    this.notifyStage(4, {
      action: "hard_truncate",
      messages: start,
      detail: "摘要不可用，更早的普通对话已被直接丢弃",
    });
    return this.stage3Representation(messages, parts, budget);
  }

  private notifyStage(stage: number, event: CompactEvent): void {
    if (stage <= this.reachedStage) return;
    this.reachedStage = stage;
    this.onCompact?.(event);
  }

  /**
   * 增量合并摘要：有旧摘要则把「新折叠段 + 工具观察」并入旧摘要，无则首次摘要。
   * 结构化 8 节 + 任务节只补不改，对抗迭代衰减；失败直接抛出，由 compress 降级处理。
   */
  private async mergeSummary(
    previous: string | null,
    newMessages: Message[],
    observations: string[],
    signal?: AbortSignal
  ): Promise<string> {
    const conversationText = newMessages
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[non-text]"}`)
      .join("\n");
    const sections: string[] = [];
    if (conversationText) sections.push(conversationText);
    if (observations.length) {
      sections.push(`折叠范围内的工具观察（已截断）：\n${observations.map((o) => `- ${o}`).join("\n")}`);
    }

    // 允许「只有工具观察、没有新对话」的追加（ReAct 回合里对话可能早就折完了）
    const input = this.clipMiddle(
      previous
        ? `现有摘要：\n${previous}\n\n新产生的对话与工具观察：\n${sections.join("\n\n")}`
        : `对话与工具观察：\n${sections.join("\n\n")}`,
      SUMMARY_INPUT_TOKEN_CAP
    );
    const inputTokens = this.tokenCounter.estimateText(input, this.config.summaryModel);

    return this.requestSummary(
      previous ? SUMMARY_MERGE_PROMPT : SUMMARY_FRESH_PROMPT,
      input,
      inputTokens,
      signal
    );
  }

  /** 摘要模型调用：重试/回退策略见 requestSummaryWithRetry；只有成功响应才记 usage */
  private async requestSummary(
    systemPrompt: string,
    input: string,
    inputTokens: number,
    signal?: AbortSignal
  ): Promise<string> {
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: input },
    ];
    const result = await requestSummaryWithRetry({
      models: [this.config.summaryModel, this.config.modelName],
      signal,
      call: async (model) => {
        const resp = await this.client.chat.completions.create(
          {
            model,
            messages,
            max_tokens: summaryMaxTokensFor(inputTokens),
            temperature: 0,
          },
          signal ? { signal } : {}
        );
        if (resp.usage) {
          this.onSummaryUsage?.({
            promptTokens: resp.usage.prompt_tokens ?? 0,
            completionTokens: resp.usage.completion_tokens ?? 0,
            totalTokens: resp.usage.total_tokens ?? 0,
          });
        }
        return { content: resp.choices[0]?.message?.content ?? "" };
      },
    });
    return result.content;
  }
}
