// src/server/trace_viewer.ts
/**
 * 运行轨迹读取（🕘 面板的数据源）。
 *
 * core/trace.ts 写的是"每事件一行 JSON"的 .traces/<sessionId>-<时间>.jsonl；
 * 读侧只做三件事：按会话前缀列文件、按字节偏移增量读、把单条事件的超长字段截断。
 * 偏移只落在行边界——写到一半的行留到下次，不把撕裂的 JSON 交给前端。
 */
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { TraceChunkDTO, TraceEventDTO, TraceFileSummaryDTO } from "./protocol";

/** TraceRecorder 的文件名是 safeLabel + ISO 时间戳，字符合法集固定；顺带挡掉路径穿越 */
const FILE_PATTERN = /^[A-Za-z0-9_-]+\.jsonl$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 单次响应的源字节上限：长任务轨迹几 MB，面板按需续拉而不是一口气全读 */
const CHUNK_BYTES = 256 * 1024;
/** 单次响应的事件条数上限：防止短事件把前端一次塞爆 */
const MAX_EVENTS_PER_CHUNK = 2_000;
/** 单行上限：超过它的事件放弃展示（实测最大事件百 KB 级） */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** 列表标题只读文件开头这么多字节（够拿到第一条 run_start） */
const LABEL_BYTES = 8 * 1024;

/** 载荷截断：单条事件的 text 字段上限、数组项上限、嵌套深度上限 */
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 40;
const MAX_DEPTH = 5;

/** 轨迹读取失败：status 交给路由层映射（400 = 文件名不合法，404 = 文件不存在） */
export class TraceViewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404
  ) {
    super(message);
  }
}

/** 只认"本会话的轨迹文件"：前缀 + 安全字符集，两样都不满足就拒绝 */
function assertKnownFile(sessionId: string, file: string): void {
  if (!SESSION_PATTERN.test(sessionId) || !FILE_PATTERN.test(file) || !file.startsWith(`${sessionId}-`)) {
    throw new TraceViewError("轨迹文件名不合法", 400);
  }
}

/** 本会话的轨迹文件清单；目录不存在/没跑过回合时返回空列表而不是报错 */
export async function listSessionTraces(traceDir: string, sessionId: string): Promise<TraceFileSummaryDTO[]> {
  if (!SESSION_PATTERN.test(sessionId)) return [];
  const root = path.resolve(traceDir);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const prefix = `${sessionId}-`;
  const found: Array<{ summary: TraceFileSummaryDTO; mtimeMs: number }> = [];
  for (const file of entries) {
    if (!file.startsWith(prefix) || !FILE_PATTERN.test(file)) continue;
    const full = path.join(root, file);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      const label = await readLabel(full);
      found.push({
        summary: {
          file,
          sizeBytes: stat.size,
          modified: stat.mtime.toISOString(),
          ...(label !== undefined ? { label } : {}),
        },
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // 列目录期间被清理：跳过这一条
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.summary.file.localeCompare(a.summary.file));
  return found.map((item) => item.summary);
}

/** 从文件开头读第一条 run_start 的用户消息，给列表当标题 */
async function readLabel(full: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(full, "r");
    const buffer = Buffer.alloc(LABEL_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, LABEL_BYTES, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf-8").split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 尾部半行/坏行：继续看下一行
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (record["type"] !== "run_start" || typeof record["userMessage"] !== "string") continue;
      const collapsed = record["userMessage"].replace(/\s+/g, " ").trim();
      return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed || "（空输入）";
    }
  } catch {
    // 读不到标题不影响列出文件
  } finally {
    await handle?.close().catch(() => {});
  }
  return undefined;
}

/**
 * 增量读取一个轨迹文件。after 缺省从 0 开始；offset 落在最后一条完整行的行尾。
 * 传进来的 after 不落在行边界（文件被重写过、调用方算错）时重置从 0 重读，宁可重复也不丢事件。
 * 文件末尾没写完的半行不消费（解析不了就下次再读），写完整了但缺换行则照常给出。
 */
export async function readTraceChunk(
  traceDir: string,
  sessionId: string,
  file: string,
  after?: number
): Promise<TraceChunkDTO> {
  assertKnownFile(sessionId, file);
  const full = path.join(path.resolve(traceDir), file);
  let size: number;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new TraceViewError("轨迹文件不存在", 404);
  }

  let start = after ?? 0;
  let reset = false;
  if (!Number.isFinite(start) || start < 0 || start > size) {
    start = 0;
    reset = after !== undefined;
  }
  if (start === size) return { events: [], offset: size, size, reset };

  const handle = await fs.open(full, "r");
  try {
    if (start > 0) {
      // 上一字节必须是换行：否则这个偏移落在行中间，按它读会静默漏掉半条事件
      const probe = Buffer.alloc(1);
      const { bytesRead } = await handle.read(probe, 0, 1, start - 1);
      if (bytesRead === 1 && probe[0] !== 0x0a) {
        start = 0;
        reset = true;
      }
    }
    const want = Math.min(CHUNK_BYTES, size - start);
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, start);
    if (bytesRead <= 0) return { events: [], offset: start, size, reset };
    const window = buffer.subarray(0, bytesRead);
    const lastNewline = window.lastIndexOf(0x0a);

    if (lastNewline >= 0) {
      const parsed = parseWindow(window.subarray(0, lastNewline + 1));
      return { events: parsed.events, offset: start + parsed.consumed, size, reset };
    }

    // 窗口里没有行尾：文件末尾的半行，或单行超长（跳过并提示）
    if (start + bytesRead >= size) {
      // 文件末尾没有换行：写完整了就当一条事件消费（崩溃时留下的半行解析失败，留到下次）
      const tail = window.toString("utf-8");
      const event = tail.trim() === "" ? undefined : parseEvent(tail);
      return event === undefined
        ? { events: [], offset: start, size, reset }
        : { events: [event], offset: size, size, reset };
    }
    const lineEnd = await scanForNewline(handle, start + bytesRead, size, MAX_LINE_BYTES - bytesRead);
    const bytes = (lineEnd === undefined ? Math.min(size, start + bytesRead) : lineEnd + 1) - start;
    return {
      events: [{
        ts: "",
        type: "oversize",
        data: { note: `单条事件超过 ${Math.round(CHUNK_BYTES / 1024)}KB，已跳过（${bytes} 字节）` },
        truncated: true,
      }],
      offset: start + bytes,
      size,
      reset,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 解析窗口内所有完整行；consumed 是实际吃掉的字节数（达到条数上限时可能小于窗口） */
function parseWindow(window: Buffer): { events: TraceEventDTO[]; consumed: number } {
  const events: TraceEventDTO[] = [];
  let lineStart = 0;
  let consumed = 0;
  for (let index = 0; index < window.length; index++) {
    if (window[index] !== 0x0a) continue;
    const line = window.subarray(lineStart, index).toString("utf-8");
    lineStart = index + 1;
    consumed = lineStart;
    if (line.trim() === "") continue;
    const event = parseEvent(line);
    if (event !== undefined) events.push(event);
    if (events.length >= MAX_EVENTS_PER_CHUNK) break;
  }
  return { events, consumed };
}

function parseEvent(line: string): TraceEventDTO | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") return undefined;
  const { ts, type: _type, ...rest } = record;
  const state = { truncated: false };
  const data = truncateValue(rest, 0, state) as Record<string, unknown>;
  return {
    ts: typeof ts === "string" ? ts : "",
    type,
    data,
    ...(state.truncated ? { truncated: true } : {}),
  };
}

/** 递归截断载荷：长字符串、长数组、过深嵌套都收缩，并记下发生过截断 */
function truncateValue(value: unknown, depth: number, state: { truncated: boolean }): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_CHARS) return value;
    state.truncated = true;
    return `${value.slice(0, MAX_STRING_CHARS)}…`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) state.truncated = true;
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => truncateValue(item, depth + 1, state));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      state.truncated = true;
      return "…";
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = truncateValue(item, depth + 1, state);
    return out;
  }
  return value;
}

/** 从 from 向后找下一个行尾（绝对偏移）；超过 limitBytes 或到文件末尾返回 undefined */
async function scanForNewline(
  handle: FileHandle,
  from: number,
  size: number,
  limitBytes: number
): Promise<number | undefined> {
  const limit = Math.min(size, from + Math.max(0, limitBytes));
  let cursor = from;
  while (cursor < limit) {
    const want = Math.min(64 * 1024, limit - cursor);
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, cursor);
    if (bytesRead <= 0) return undefined;
    const index = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (index >= 0) return cursor + index;
    cursor += bytesRead;
  }
  return undefined;
}
