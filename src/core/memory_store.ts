// src/core/memory_store.ts
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Bm25Index } from "../rag/bm25";

/**
 * 跨会话核心记忆（semantic memory）的本地存储。
 *
 * 与会话内【长期摘要】的分工：长期摘要是单会话的情景记忆（episodic），跟着会话文件走，
 * 新会话读不到；这里是全局语义记忆（事实/偏好/项目状态），跨会话、跨进程共用一份。
 * 记忆分类沿用 Claude Code auto memory 的四类：
 *   user      —— 用户角色、专长、偏好
 *   feedback  —— 用户给过的纠正、确认有效的做法
 *   project   —— 进行中的工作、代码与 git 历史里看不出来的决策
 *   reference —— 项目外部资源的位置（issue 跟踪器、仪表盘等）
 *
 * 存储：`<dir>/memory.jsonl` 一行一条记录（追加 + 原子重写）；`<dir>/MEMORY.md` 是
 * 每次写入后自动重渲的只读视图，供人直接翻阅。事实被新信息取代时**不删除**——打
 * supersededAt 保留演变历史（Zep 的 invalid_at 思想），注入与检索只取未取代的条目。
 */

export type MemoryType = "user" | "feedback" | "project" | "reference";

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  user: "用户画像与偏好",
  feedback: "纠正与确认有效的做法",
  project: "进行中的工作与项目决策",
  reference: "外部资源与指引",
};

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  /** 一句完整、自包含的事实陈述；不写"参见上文"这类依赖会话的话 */
  text: string;
  /** ISO 8601 创建时间；检索侧用新近度做次要排序 */
  createdAt: string;
  /** 内容被修改的时间；存在即代表内容不是最初版本 */
  updatedAt?: string;
  /** 被更新的信息取代的时间；存在即代表本条已不再生效（保留只为追溯演变） */
  supersededAt?: string;
  /** 主张该条记忆的会话，便于溯源与审计 */
  sourceSessionId?: string;
}

export interface MemoryAddInput {
  type: MemoryType;
  text: string;
  sourceSessionId?: string;
}

export const DEFAULT_MEMORY_PAGE_SIZE = 20;
export const MAX_MEMORY_PAGE_SIZE = 50;

export interface MemoryPageOptions {
  type?: MemoryType | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface MemoryPage<T extends MemoryEntry = MemoryEntry> {
  entries: T[];
  /** 类型筛选后（搜索时还需命中关键词）的总条数 */
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface MemorySearchEntry extends MemoryEntry {
  score: number;
}

function pagination(options: MemoryPageOptions): { offset: number; limit: number } {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_MEMORY_PAGE_SIZE;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset 必须为非负安全整数");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEMORY_PAGE_SIZE) {
    throw new Error(`limit 必须为 1 到 ${MAX_MEMORY_PAGE_SIZE} 的整数`);
  }
  if (options.type !== undefined && !isMemoryType(options.type)) throw new Error("无效的记忆类型");
  return { offset, limit };
}

function pageOf<T extends MemoryEntry>(entries: T[], offset: number, limit: number): MemoryPage<T> {
  const page = entries.slice(offset, offset + limit);
  return {
    entries: page,
    total: entries.length,
    offset,
    limit,
    nextOffset: offset + page.length < entries.length ? offset + page.length : null,
  };
}

/** 单条记忆正文上限：记忆是事实短句，不是文档；超长说明提取粒度不对，截断兜底 */
const MAX_TEXT_CHARS = 500;

/** 注入索引的条目上限（Claude Code MEMORY.md 的 200 行约束同款思路） */
const MAX_INDEX_ENTRIES = 200;

export interface MemoryStoreOptions {
  /** 记忆目录，缺文件时首次写入自动创建 */
  dir: string;
}

export class MemoryStore {
  readonly dir: string;
  private readonly recordsPath: string;
  private readonly indexPath: string;
  // 进程内写链：add/forget/update 都是「读-改-写」，用 promise 链在进程内串行化，
  // 防止同进程并发写互相覆盖；跨进程（CLI 与 Web 同时开）按单用户场景尽力而为
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.recordsPath = path.join(this.dir, "memory.jsonl");
    this.indexPath = path.join(this.dir, "MEMORY.md");
  }

  /** 全部记录（含已取代的）：审计与 L2 嵌入用 */
  async list(): Promise<MemoryEntry[]> {
    return this.readRecords();
  }

  /** 未被取代的生效记忆 */
  async active(): Promise<MemoryEntry[]> {
    return (await this.readRecords()).filter((record) => record.supersededAt === undefined);
  }

  /** 按写入顺序分页读取全部有效记忆，不受注入索引的 200 条上限影响。 */
  async readPage(options: MemoryPageOptions = {}): Promise<MemoryPage> {
    const { offset, limit } = pagination(options);
    const entries = (await this.active()).filter((entry) => options.type === undefined || entry.type === options.type);
    return pageOf(entries, offset, limit);
  }

  /** 本地关键词搜索：按 BM25 相关度排序，同分按 id；每次读取最新有效记录。 */
  async search(query: string, options: MemoryPageOptions = {}): Promise<MemoryPage<MemorySearchEntry>> {
    const { offset, limit } = pagination(options);
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > 500) throw new Error("query 需要 1 到 500 个字符的关键词");
    const entries = (await this.active()).filter((entry) => options.type === undefined || entry.type === options.type);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const hits = new Bm25Index(entries).search(trimmed);
    return pageOf(hits.map((hit) => ({ ...byId.get(hit.id)!, score: hit.score })), offset, limit);
  }

  /**
   * 追加一条记忆。同类型同文本的生效条目已存在时跳过（返回 undefined）——
   * 这是确定性的兜底去重，语义级查重是调用方（L3 写入管线）的事。
   */
  async add(input: MemoryAddInput): Promise<MemoryEntry | undefined> {
    return this.serialize(async () => {
      const trimmed = input.text.trim();
      if (trimmed === "") return undefined;
      const text = trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS)}…` : trimmed;
      const records = await this.readRecords();
      if (records.some((r) => r.supersededAt === undefined && r.type === input.type && r.text === text)) {
        return undefined;
      }
      const entry: MemoryEntry = {
        id: `m-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`,
        type: input.type,
        text,
        createdAt: new Date().toISOString(),
        ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
      };
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.recordsPath, `${JSON.stringify(entry)}\n`, "utf-8");
      await this.persistIndex([...records, entry]);
      return entry;
    });
  }

  /** 把一条生效记忆标记为已取代（不物理删除）。找不到未取代的同 id 条目返回 false */
  async forget(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const records = await this.readRecords();
      const target = records.find((r) => r.id === id && r.supersededAt === undefined);
      if (!target) return false;
      target.supersededAt = new Date().toISOString();
      await this.rewriteRecords(records);
      await this.persistIndex(records);
      return true;
    });
  }

  /** 修改一条生效记忆的正文。返回更新后的条目；找不到未取代的同 id 条目返回 undefined */
  async update(id: string, text: string): Promise<MemoryEntry | undefined> {
    return this.serialize(async () => {
      const trimmed = text.trim();
      if (trimmed === "") return undefined;
      const records = await this.readRecords();
      const target = records.find((r) => r.id === id && r.supersededAt === undefined);
      if (!target) return undefined;
      target.text = trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS)}…` : trimmed;
      target.updatedAt = new Date().toISOString();
      await this.rewriteRecords(records);
      await this.persistIndex(records);
      return target;
    });
  }

  /** 渲染注入用的索引文本：按类型分节、一行一条带 id（模型据此 forget/update）。空记忆返回空串 */
  renderIndex(entries: MemoryEntry[]): string {
    const active = entries.filter((entry) => entry.supersededAt === undefined);
    if (active.length === 0) return "";
    const shown = active.slice(0, MAX_INDEX_ENTRIES);
    const sections = MEMORY_TYPES.map((type) => {
      const of = shown.filter((entry) => entry.type === type);
      if (of.length === 0) return undefined;
      const lines = of.map((entry) => {
        const date = entry.createdAt.slice(0, 10);
        return `- [${entry.id} · ${date}] ${entry.text}`;
      });
      return `## ${type}（${MEMORY_TYPE_LABELS[type]}）\n${lines.join("\n")}`;
    }).filter((section) => section !== undefined);
    const overflow = active.length - shown.length;
    const body = sections.join("\n\n");
    return overflow > 0
      ? `${body}\n\n（仅显示前 ${shown.length} 条，其余 ${overflow} 条已省略）\n可用 memory action=read offset=${shown.length} 分页读取其余记忆，或 action=search query=关键词 搜索全部有效记忆。`
      : body;
  }

  /** 便捷入口：生效记忆 → 注入索引文本；没有任何记忆时返回空串（调用方据此不注入） */
  async loadIndex(): Promise<string> {
    return this.renderIndex(await this.active());
  }

  /** 进程内写链：前一次写失败不阻塞后续写（吞掉前任的 rejection） */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /** 逐行读记录：损坏行与字段不合法的行跳过并告警 */
  private async readRecords(): Promise<MemoryEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.recordsPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: MemoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as MemoryEntry;
        if (typeof parsed.id === "string" && isMemoryType(String(parsed.type)) &&
            typeof parsed.text === "string" && typeof parsed.createdAt === "string") {
          records.push(parsed);
        }
      } catch {
        console.warn(`[Memory] 跳过损坏的一行: ${this.recordsPath}`);
      }
    }
    return records;
  }

  /** 原子重写记录文件（forget/update 的读-改-写落点）：临时文件 + fsync + rename */
  private async rewriteRecords(records: MemoryEntry[]): Promise<void> {
    await this.atomicWrite(
      this.recordsPath,
      records.map((record) => `${JSON.stringify(record)}\n`).join("")
    );
  }

  /** 重渲 MEMORY.md 视图；视图只是投影，写失败不影响权威数据（jsonl） */
  private async persistIndex(records: MemoryEntry[]): Promise<void> {
    const body = this.renderIndex(records);
    if (body === "") {
      await fs.rm(this.indexPath, { force: true }).catch(() => undefined);
      return;
    }
    await this.atomicWrite(this.indexPath, `${body}\n`, { sync: false });
  }

  /** tmp + fsync + rename 的原子替换；Windows 上目标被读时 rename 短暂 EPERM/EBUSY，退避重试 */
  private async atomicWrite(filePath: string, content: string, options: { sync?: boolean } = {}): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(content, "utf-8");
      if (options.sync !== false) await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
}
