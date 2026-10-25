// src/core/session_store.ts
import fs from "node:fs/promises";
import path from "node:path";
import { Message } from "./types";

export interface SessionStoreOptions {
  /** 会话文件存放目录，首次写入时自动创建 */
  dir: string;
  /** 会话 ID，决定文件名；非法字符会被替换，缺省为 "default" */
  sessionId?: string;
}

export interface SessionSummary {
  /** 会话 ID（即去掉 .jsonl 后缀的文件名） */
  sessionId: string;
  /** 会话名（第一轮对话的摘要）；老会话没有这条记录时为 undefined，菜单回退到 firstUserText */
  name?: string;
  /** 实际可载入的历史条数（已剔除 system、损坏行与元记录，并修复过尾部） */
  messageCount: number;
  /** 会话文件最后修改时间，用于按最近使用排序 */
  lastUpdated: Date;
  /** 第一条 user 消息的预览，帮助用户在菜单里认出会话 */
  firstUserText: string;
}

/**
 * 会话文件里除对话消息外的"元记录"：提示模板选定/清除、会话名、模型选择。
 * 刻意保持"长着 user 消息的样子、正文带固定前缀"：这样混进消息数组时依然是一个合法的
 * OpenAI user 消息（旧版本读到也只会当成一句普通用户话，不会崩），而 readRecords 之后的
 * 各处能凭前缀把它们认出来：**历史可见但不进 LLM 上下文**——文件里查得到"哪一轮用了哪个
 * 模板/哪个模型、这个会话叫什么"，token 上不重复付一遍。
 * 前缀用全角方括号并各自带标识，正常对话几乎不可能自然产生，识别足够可靠。
 */
export const PROMPT_TEMPLATE_PREFIX = "【提示模板";

/** 会话名记录：第一轮问答结束后由摘要模型生成，用于会话选择菜单 */
export const SESSION_NAME_PREFIX = "【会话名】";

/** 模型选择记录：REPL 的 /model 切换时写入，续聊时据此恢复 */
export const MODEL_PREFIX = "【模型】";

/** 摘要模型选择记录：Web 会话级摘要模型切换时写入，续聊时据此恢复 */
export const SUMMARY_MODEL_PREFIX = "【摘要模型】";

/**
 * 跨 run 长期摘要记录：每个可记忆的 run（含纯聊天）结束时增量更新一份。
 * 磁盘层 compact 只保留最近 N 个对话轮，更早的历史（以及所有跨 run 的工具发现）
 * 没有它就无声丢失；有了它，run 开始时注入钉住前缀，20 轮之前的世界仍然可见。
 */
export const LONG_TERM_SUMMARY_PREFIX = "【长期摘要】";

/** 所有元记录前缀：判定"不算对话消息"的唯一依据 */
const META_PREFIXES = [
  PROMPT_TEMPLATE_PREFIX,
  SESSION_NAME_PREFIX,
  MODEL_PREFIX,
  SUMMARY_MODEL_PREFIX,
  LONG_TERM_SUMMARY_PREFIX,
];

/** 会话名长度上限：菜单一行要放得下，也防摘要模型话多 */
const MAX_SESSION_NAME_CHARS = 24;

/** 写进会话文件的模板生效记录（正文为 JSON，含 role 分层） */
export interface PromptTemplateSnapshot {
  label: string;
  messages: Array<{ role: string; text: string }>;
}

function templateRecordBody(snapshot: PromptTemplateSnapshot | undefined): string {
  return snapshot
    ? `${PROMPT_TEMPLATE_PREFIX} · 来源：${snapshot.label}】本会话已选定该模板：\n${JSON.stringify(snapshot.messages)}`
    : `${PROMPT_TEMPLATE_PREFIX} · 已清除】本会话不再注入模板。`;
}

/** 从记录正文还原模板快照；不是模板记录 / 已清除 / JSON 坏了都返回 undefined */
function parseTemplateRecord(text: string): PromptTemplateSnapshot | undefined {
  if (!text.startsWith(PROMPT_TEMPLATE_PREFIX) || text.includes("已清除】")) return undefined;
  const newline = text.indexOf("\n");
  if (newline === -1) return undefined;
  const label = /来源：(.+?)】/.exec(text);
  if (!label?.[1]) return undefined;
  try {
    const messages = JSON.parse(text.slice(newline + 1)) as PromptTemplateSnapshot["messages"];
    return Array.isArray(messages) ? { label: label[1], messages } : undefined;
  } catch {
    return undefined;
  }
}

/** 该条消息是否属于「元记录」（模板/会话名/模型；用于剔除，不看内容合法性） */
function isMetaRecord(message: Message): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (typeof content !== "string") return false;
  return META_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/** 该条消息是否是模板记录（会话名/模型记录外形相同，要靠前缀区分） */
function isTemplateRecord(message: Message): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  return typeof content === "string" && content.startsWith(PROMPT_TEMPLATE_PREFIX);
}

/** 从单条元记录里取"【前缀】后面的值" */
function metaValue(message: Message, prefix: string): string | undefined {
  if (message.role !== "user" || typeof message.content !== "string") return undefined;
  if (!message.content.startsWith(prefix)) return undefined;
  const value = message.content.slice(prefix.length).trim();
  return value === "" ? undefined : value;
}

/**
 * 会话名的规范化：摘要模型偶尔会带引号、换行、结尾句号。
 * 首尾一次性去噪（引号与标点可能交替出现，例如 “标题”。），失败返回 undefined ——
 * 调用方据此决定"不落盘"，让菜单回退到首条用户消息预览。
 */
export function normalizeSessionName(raw: string): string | undefined {
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const cleaned = collapsed
    .replace(/^[\s"'“”‘’「」《》]+/, "")
    .replace(/[\s"'“”‘’「」《》。．.!！?？,，;；:：、]+$/, "")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.length > MAX_SESSION_NAME_CHARS ? `${cleaned.slice(0, MAX_SESSION_NAME_CHARS)}…` : cleaned;
}

/**
 * 多轮会话历史的本地存储：一行一条消息（JSONL）。
 * 追加即落盘，进程崩溃最多丢最后一条；load 时顺手修复被中断的尾部，
 * 保证修复后的历史永远是一个合法的 OpenAI 消息序列。
 */
export class SessionStore {
  readonly filePath: string;
  /** 会话目录（构建 tool_outputs 等旁路文件用） */
  readonly dir: string;

  constructor(options: SessionStoreOptions) {
    // 消毒：sessionId 来自外部输入，防止 "./.." 之类的拼接逃出目录
    const sessionId = (options.sessionId ?? "default").replace(/[^a-zA-Z0-9_-]/g, "_");
    this.dir = path.resolve(options.dir);
    this.filePath = path.join(this.dir, `${sessionId}.jsonl`);
  }

  /**
   * 读取续聊历史 + 本会话当前生效的模板快照、会话名与模型选择。
   * 元记录留在文件里可查（历史可见），但不进返回的 messages（不重复占 token）。
   */
  async load(): Promise<{
    messages: Message[];
    promptTemplate: PromptTemplateSnapshot | undefined;
    sessionName?: string;
    model?: string;
    summaryModel?: string;
    longTermSummary?: string;
  }> {
    const records = await SessionStore.readRecords(this.filePath);
    const messages = records.filter((record) => !isMetaRecord(record));
    const sessionName = SessionStore.lastMetaValue(records, SESSION_NAME_PREFIX);
    const model = SessionStore.lastMetaValue(records, MODEL_PREFIX);
    const summaryModel = SessionStore.lastMetaValue(records, SUMMARY_MODEL_PREFIX);
    const longTermSummary = SessionStore.lastMetaValue(records, LONG_TERM_SUMMARY_PREFIX);
    return {
      messages: SessionStore.repairTail(messages),
      // 从尾部往前找最近一次"选定/清除"：清除记录本身没有正文，找到即代表模板已撤销
      promptTemplate: SessionStore.lastTemplateSnapshot(records),
      ...(sessionName !== undefined ? { sessionName } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(summaryModel !== undefined ? { summaryModel } : {}),
      ...(longTermSummary !== undefined ? { longTermSummary } : {}),
    };
  }

  /**
   * 记下"本会话的模板状态"（选定或清除），并等待落盘。
   * 重复设置同一个模板不再写第二遍：否则每轮都会追加一行，历史里全是噪声。
   */
  async recordPromptTemplate(template: PromptTemplateSnapshot | undefined): Promise<void> {
    const current = SessionStore.lastTemplateSnapshot(await SessionStore.readRecords(this.filePath));
    if (template && current?.label === template.label) return; // 已在生效中，不重复落盘
    if (!template && current === undefined) return; // 本来就没模板，不必记一笔"清除"
    await this.append({ role: "user", content: templateRecordBody(template) });
  }

  /**
   * 记下会话名（第一轮问答结束后生成）。名字为空、或与当前名字相同都不写第二遍。
   * 返回实际落盘的名字，便于调用方打印/判断。
   */
  async recordSessionName(name: string): Promise<string | undefined> {
    const normalized = normalizeSessionName(name);
    if (normalized === undefined) return undefined;
    const current = SessionStore.lastMetaValue(await SessionStore.readRecords(this.filePath), SESSION_NAME_PREFIX);
    if (current === normalized) return normalized; // 已是这个名字，不重复落盘
    await this.append({ role: "user", content: `${SESSION_NAME_PREFIX}${normalized}` });
    return normalized;
  }

  /** 记下当前选定的模型（REPL 的 /model 用）。同一个模型不重复写。 */
  async recordModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (trimmed === "") return;
    const current = SessionStore.lastMetaValue(await SessionStore.readRecords(this.filePath), MODEL_PREFIX);
    if (current === trimmed) return;
    await this.append({ role: "user", content: `${MODEL_PREFIX}${trimmed}` });
  }

  /** 记下当前选定的摘要模型（Web 会话级配置用）。同一个模型不重复写。 */
  async recordSummaryModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (trimmed === "") return;
    const current = SessionStore.lastMetaValue(await SessionStore.readRecords(this.filePath), SUMMARY_MODEL_PREFIX);
    if (current === trimmed) return;
    await this.append({ role: "user", content: `${SUMMARY_MODEL_PREFIX}${trimmed}` });
  }

  /**
   * 记录跨 run 长期摘要（包含纯聊天轮，具体触发与失败处理由 Agent 管理）。
   * 内容每次都在变，不做去重；compact 会保留最新一条。
   */
  async recordLongTermSummary(summary: string): Promise<void> {
    const trimmed = summary.trim();
    if (trimmed === "") return;
    await this.append({ role: "user", content: `${LONG_TERM_SUMMARY_PREFIX}${trimmed}` });
  }

  /** 列出 `dir` 里所有会话的摘要，最近更新的排前面（用于启动时的会话选择菜单） */
  static async list(dir: string): Promise<SessionSummary[]> {
    const resolved = path.resolve(dir);
    let entries: string[];
    try {
      entries = await fs.readdir(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(resolved, entry);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;

      const sessionId = entry.slice(0, -".jsonl".length);
      // 构造函数会对 sessionId 消毒，名字对不上的文件（手工改名等）没法续聊，跳过
      if (new SessionStore({ dir: resolved, sessionId }).filePath !== filePath) continue;

      // 元记录照读（repairTail 不碰它们），但计入消息数会让人误会，先剔掉；名字单独取出来
      const records = await SessionStore.readRecords(filePath);
      const messages = SessionStore.repairTail(records.filter((record) => !isMetaRecord(record)));
      const firstUser = messages.find((message) => message.role === "user");
      const name = SessionStore.lastMetaValue(records, SESSION_NAME_PREFIX);
      summaries.push({
        sessionId,
        ...(name !== undefined ? { name } : {}),
        messageCount: messages.length,
        lastUpdated: stat.mtime,
        firstUserText: SessionStore.preview(firstUser?.content),
      });
    }

    return summaries.sort(
      (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime() || a.sessionId.localeCompare(b.sessionId)
    );
  }

  /** 从尾部往前找最近一条元记录的取值（后写的覆盖先写的） */
  private static lastMetaValue(records: Message[], prefix: string): string | undefined {
    for (let index = records.length - 1; index >= 0; index--) {
      const value = metaValue(records[index]!, prefix);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** 从尾部往前找最近一次模板记录：选定 → 返回快照；清除记录或其后的记录 → 返回 undefined */
  private static lastTemplateSnapshot(records: Message[]): PromptTemplateSnapshot | undefined {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!;
      if (!isTemplateRecord(record)) continue;
      const text = typeof record.content === "string" ? record.content : "";
      const snapshot = parseTemplateRecord(text);
      return snapshot
        ? { label: snapshot.label, messages: snapshot.messages.map((m) => ({ role: String(m.role), text: String(m.text) })) }
        : undefined;
    }
    return undefined;
  }

  /** 逐行读原始记录：损坏行跳过并告警；system 不入库（每次 run 用当前配置重建） */
  private static async readRecords(filePath: string): Promise<Message[]> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records: Message[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Message;
        if (record.role !== "system") records.push(record);
      } catch {
        console.warn(`[Session] 跳过损坏的一行: ${filePath}`);
      }
    }
    return records;
  }

  private static preview(content: Message["content"] | undefined): string {
    const collapse = (text: string): string => {
      const compact = text.replace(/\s+/g, " ").trim();
      return compact.length > 48 ? `${compact.slice(0, 48)}…` : compact;
    };
    if (typeof content === "string") return collapse(content) || "(尚无用户消息)";
    if (Array.isArray(content)) {
      const text = content.map((part) => ("text" in part ? part.text : "")).join(" ");
      return collapse(text) || "(尚无用户消息)";
    }
    return "(尚无用户消息)";
  }

  /** 追加一条消息并等待落盘，保证 run 正常/异常退出后磁盘状态都可用 */
  async append(message: Message): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(message)}\n`, "utf-8");
  }

  /** 当前记录条数（含元记录）：检查点用它标记"本轮用户消息落盘之前"的文件边界 */
  async recordCount(): Promise<number> {
    return (await SessionStore.readRecords(this.filePath)).length;
  }

  /** 全部原始记录（含元记录），供检查点会话回滚等旁路消费者核对用 */
  async readAll(): Promise<Message[]> {
    return SessionStore.readRecords(this.filePath);
  }

  /**
   * 原子重写整个会话文件：先写临时文件、fsync，再 rename。
   * rename 之前不落到磁盘的话，系统崩溃（断电/内核挂）后可能留下一个已改名但内容为空的文件；
   * 进程崩溃没这个问题，内核会把缓冲写完——但 compact 是全量重写，不能只防前者。
   */
  private async rewrite(records: Message[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(records.map((message) => `${JSON.stringify(message)}\n`).join(""), "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, this.filePath);
  }

  /**
   * 原子截断到前 count 条记录（/rewind 的会话恢复）：与 compact 同样的临时文件替换写法，
   * 写到一半不损原会话。count 超过现有条数时不动文件。
   */
  async truncateTo(count: number): Promise<void> {
    const records = await SessionStore.readRecords(this.filePath);
    const kept = records.slice(0, Math.max(0, Math.floor(count)));
    if (kept.length === records.length) return;
    await this.rewrite(kept);
  }

  /**
   * 只保留最近的完整非工具对话轮。工具调用仅服务当前 ReAct 循环，跨进程续聊时不需要重放。
   * 旧版本留下的工具组也会在这里一起清理；以临时文件替换，避免写到一半损坏原会话。
   * 元记录不占轮次窗口：会话名与模型各原样回写一条，当前生效的模板也回写一条，
   * 既不丢状态也不随历史累积（裁掉它们等于丢会话名和模型选择）。
   */
  async compact(maxTurns: number): Promise<void> {
    try {
      await fs.access(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const records = await SessionStore.readRecords(this.filePath);
    const activeTemplate = SessionStore.lastTemplateSnapshot(records);
    const sessionName = SessionStore.lastMetaValue(records, SESSION_NAME_PREFIX);
    const model = SessionStore.lastMetaValue(records, MODEL_PREFIX);
    const summaryModel = SessionStore.lastMetaValue(records, SUMMARY_MODEL_PREFIX);
    const longTermSummary = SessionStore.lastMetaValue(records, LONG_TERM_SUMMARY_PREFIX);
    const nonMeta = records.filter((record) => !isMetaRecord(record));
    const messages = SessionStore.toConversationTurns(SessionStore.repairTail(nonMeta));
    const keepTurns = Math.max(0, Math.floor(maxTurns));
    // 迟滞窗口：历史条数没超过 maxTurns+slack 就不动文件。滑动窗口如果每轮都裁一条，
    // history 的第一条每轮都变，服务端前缀缓存对整段历史每轮作废一次；攒够一批再
    // 一次性裁到 maxTurns，把失效频率从每轮一次降到每 slack 轮一次。
    // 有"要清理的东西"（旧版本遗留的工具组、未配对的残尾）时不受迟滞限制，照常重写。
    if (keepTurns > 0) {
      const slackTurns = Math.max(4, Math.ceil(keepTurns * 0.25));
      const hasForeignRecords = nonMeta.length !== messages.length;
      if (!hasForeignRecords && messages.length <= (keepTurns + slackTurns) * 2) return;
    }
    const kept = messages.slice(-keepTurns * 2);
    if (activeTemplate) {
      kept.push({ role: "user", content: templateRecordBody(activeTemplate) });
    }
    if (sessionName !== undefined) {
      kept.push({ role: "user", content: `${SESSION_NAME_PREFIX}${sessionName}` });
    }
    if (model !== undefined) {
      kept.push({ role: "user", content: `${MODEL_PREFIX}${model}` });
    }
    if (summaryModel !== undefined) {
      kept.push({ role: "user", content: `${SUMMARY_MODEL_PREFIX}${summaryModel}` });
    }
    // 长期摘要必须原样回写：它是 20 轮窗口之外历史的唯一存活形态，裁掉等于失忆
    if (longTermSummary !== undefined) {
      kept.push({ role: "user", content: `${LONG_TERM_SUMMARY_PREFIX}${longTermSummary}` });
    }
    await this.rewrite(kept);
  }

  /** 只抽取 user → 无 tool_calls assistant 的完整对话轮，忽略所有工具调用组。 */
  private static toConversationTurns(messages: Message[]): Message[] {
    const turns: Message[] = [];
    let user: Extract<Message, { role: "user" }> | null = null;
    for (const message of messages) {
      if (message.role === "user") {
        user = message;
        continue;
      }
      if (message.role === "assistant" && !message.tool_calls?.length && user) {
        turns.push(user, message);
        user = null;
      }
    }
    return turns;
  }

  /**
   * 修复被中断的尾部（崩溃 / Ctrl+C 都可能留下半个回合）：
   * - 末尾未被回答的 user 消息 → 丢弃（下次 run 会重新写入新提问）
   * - 末尾 assistant(tool_calls) 缺 tool 或 tool 响应不齐 → 整组丢弃
   * - "assistant(tool_calls) + 齐全的 tool 响应"是合法停顿点（如达到 maxIterations），保留
   * - 末尾 assistant 最终回答 → 保留
   */
  private static repairTail(messages: Message[]): Message[] {
    let end = messages.length;
    while (end > 0) {
      const last = messages[end - 1]!;

      if (last.role === "user") {
        end--;
        continue;
      }

      // 它后面本该跟着 tool 响应，却处在末尾 → 工具执行被打断
      if (last.role === "assistant" && last.tool_calls?.length) {
        end--;
        continue;
      }

      if (last.role === "tool") {
        let start = end - 1;
        while (start > 0 && messages[start - 1]!.role === "tool") start--;
        const owner = start > 0 ? messages[start - 1]! : undefined;

        if (owner?.role === "assistant" && owner.tool_calls) {
          const responded = new Set(
            messages.slice(start, end).map((m) => (m.role === "tool" ? m.tool_call_id : ""))
          );
          if (owner.tool_calls.every((call) => responded.has(call.id))) break;
        }
        // 所属 assistant 缺失或响应不齐：从 owner 起整组丢弃，再检查新的队尾
        end = start - 1;
        continue;
      }

      break; // assistant 最终回答，或不属于本写入器产出的尾部结构
    }
    return messages.slice(0, end);
  }
}
