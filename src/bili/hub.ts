// src/bili/hub.ts
/**
 * 采集服务器（hub）的只读 HTTP 客户端。
 *
 * 服务端契约（采集侧按此实现；库内部用 sqlite 还是别的存储由服务端决定，识别端不感知）：
 *   GET {base}/api/snapshots?since=<ISO>&limit=<n>&cursor=<c>
 *       -> { "items": [{ "bvid", "fetched_at", "updated_at"? }], "next_cursor"? }
 *   GET {base}/api/snapshots/{bvid}  -> bili-snapshot/v1 JSON 原文
 *
 * 鉴权：配置了 BILI_HUB_TOKEN 时带 `Authorization: Bearer <token>`。
 * 服务器返回的一切都按不可信数据处理：大小设上限、JSON 走 zod 校验、BV 号回查。
 */
import { z } from "zod";
import { resolveBvid, SnapshotSchema, type VideoSnapshot } from "./snapshot";

export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface HubConfig {
  /** 不含结尾斜杠，如 http://10.0.0.5:8080 */
  baseUrl: string;
  token?: string;
  timeoutMs: number;
}

export class BiliHubError extends Error {
  readonly status?: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BiliHubError";
    if (options.status !== undefined) this.status = options.status;
  }
}

export interface HubListItem {
  bvid: string;
  fetched_at: string;
  updated_at?: string;
}

export interface HubListPage {
  items: HubListItem[];
  next_cursor?: string;
}

export interface HubSnapshot {
  bvid: string;
  raw: string;
  snapshot: VideoSnapshot;
  bytes: number;
}

const HubListItemSchema = z.object({
  bvid: z.string().min(1),
  fetched_at: z.string().min(1),
  updated_at: z.string().optional(),
});

const HubListSchema = z.object({
  items: z.array(HubListItemSchema),
  next_cursor: z.string().optional(),
});

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 从环境变量解析服务器配置；缺 BILI_HUB_URL 时抛可直接展示给用户的错误 */
export function resolveHubConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const raw = env.BILI_HUB_URL?.trim();
  if (!raw) {
    throw new BiliHubError(
      "未配置 BILI_HUB_URL：请把它指向采集服务器，例如 BILI_HUB_URL=http://10.0.0.5:8080；" +
      "需要鉴权时同时设置 BILI_HUB_TOKEN。",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BiliHubError(`BILI_HUB_URL 不是合法 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BiliHubError(`BILI_HUB_URL 只支持 http/https：${raw}`);
  }
  const token = env.BILI_HUB_TOKEN?.trim();
  return {
    baseUrl: raw.replace(/\/+$/, ""),
    timeoutMs: positiveInt(env.BILI_HUB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    ...(token ? { token } : {}),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function hubFetch(config: HubConfig, pathName: string): Promise<Response> {
  const url = `${config.baseUrl}${pathName}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(config.timeoutMs) });
  } catch (error) {
    if (isAbort(error)) {
      throw new BiliHubError(`请求采集服务器超时（${config.timeoutMs}ms）：${url}`, { cause: error });
    }
    throw new BiliHubError(
      `无法连接采集服务器：${url}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const snippet = body.slice(0, 300).replace(/\s+/g, " ").trim();
    throw new BiliHubError(
      `采集服务器返回 ${response.status}${response.statusText ? ` ${response.statusText}` : ""}：${url}` +
      (snippet ? `（${snippet}）` : ""),
      { status: response.status },
    );
  }
  return response;
}

function validateItemBvid(raw: string): string {
  try {
    return resolveBvid(raw);
  } catch {
    throw new BiliHubError(`采集服务器返回了非法 BV 号：${raw.slice(0, 40)}`);
  }
}

/** 列出服务器上的快照；since 之后有更新的条目由服务器过滤 */
export async function listSnapshots(
  config: HubConfig,
  query: { since?: string; limit?: number; cursor?: string } = {},
): Promise<HubListPage> {
  const params = new URLSearchParams();
  if (query.since) params.set("since", query.since);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await hubFetch(config, `/api/snapshots${suffix}`);

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new BiliHubError(`快照列表不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
  const result = HubListSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new BiliHubError(`快照列表格式不符合约定：${first?.path.join(".") || "(root)"} — ${first?.message}`);
  }
  return {
    items: result.data.items.map((item) => ({
      bvid: validateItemBvid(item.bvid),
      fetched_at: item.fetched_at,
      ...(item.updated_at !== undefined ? { updated_at: item.updated_at } : {}),
    })),
    ...(result.data.next_cursor !== undefined ? { next_cursor: result.data.next_cursor } : {}),
  };
}

/** 拉取并校验单个快照；返回服务器原文（落盘用）与解析结果 */
export async function fetchSnapshot(config: HubConfig, bvidInput: string): Promise<HubSnapshot> {
  const bvid = resolveBvid(bvidInput);
  const response = await hubFetch(config, `/api/snapshots/${encodeURIComponent(bvid)}`);

  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_SNAPSHOT_BYTES) {
    throw new BiliHubError(`服务器快照过大：${declared} 字节（上限 ${MAX_SNAPSHOT_BYTES}）：${bvid}`);
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    if (isAbort(error)) throw new BiliHubError(`下载快照超时：${bvid}`, { cause: error });
    throw new BiliHubError(
      `读取快照响应失败：${bvid}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new BiliHubError(`服务器快照过大：${bytes} 字节（上限 ${MAX_SNAPSHOT_BYTES}）：${bvid}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BiliHubError(`服务器快照不是合法 JSON：${bvid}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const result = SnapshotSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new BiliHubError(
      `服务器快照不符合 bili-snapshot/v1：${bvid} — ${first?.path.join(".") || "(root)"}: ${first?.message}`,
    );
  }
  if (result.data.schema !== "bili-snapshot/v1") {
    throw new BiliHubError(`服务器快照版本是 ${result.data.schema}，识别端只支持 bili-snapshot/v1：${bvid}`);
  }
  if (result.data.bvid !== bvid) {
    throw new BiliHubError(`服务器返回的快照 BV 号不匹配：请求 ${bvid}，收到 ${result.data.bvid}`);
  }
  return { bvid, raw, snapshot: result.data, bytes };
}
