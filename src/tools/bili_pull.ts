// src/tools/bili_pull.ts
/**
 * 从采集服务器（hub）拉取视频快照，落到本地 BILI_DATASET_DIR，供 bili_collect / scanner 使用。
 * 拉取即校验：快照必须是 bili-snapshot/v1、BV 号与请求一致；写盘走临时文件原子替换；
 * 批量里单条失败不拖垮整批。服务器内部怎么存（sqlite 等）与识别端无关。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../core/types";
import { resolveBvid, snapshotPath } from "../bili/snapshot";
import {
  fetchSnapshot,
  listSnapshots,
  resolveHubConfig,
  type HubConfig,
} from "../bili/hub";

export interface BiliPullToolOptions {
  /** 快照落盘目录；缺省 BILI_DATASET_DIR，再缺省 dataset/ */
  datasetDir?: string;
  /** 直接注入服务器配置（测试用）；缺省从环境变量解析 */
  hub?: HubConfig;
  env?: Record<string, string | undefined>;
}

const PullParamsSchema = z.object({
  bvid: z.string().trim().min(1).optional().describe("拉取单个快照的 BV 号或视频链接"),
  list: z.boolean().optional().describe("只列出服务器上的快照，不下载"),
  since: z.string().trim().min(1).optional().describe("批量拉取该 ISO 时间之后有更新的快照"),
  limit: z.number().int().min(1).max(100).optional().describe("列表/批量条数上限，默认 20"),
  cursor: z.string().trim().min(1).optional().describe("分页游标（上一页返回的 next_cursor）"),
  force: z.boolean().optional().describe("本地已存在时覆盖，默认 false 跳过"),
});

type PullParams = z.output<typeof PullParamsSchema>;

interface PulledEntry {
  bvid: string;
  snapshot: "downloaded" | "skipped";
  path: string;
  fetched_at?: string;
  bytes?: number;
}

interface PullReport {
  mode: "single" | "batch" | "list";
  items?: unknown[];
  next_cursor?: string;
  downloaded?: PulledEntry[];
  failed?: { bvid: string; error: string }[];
  notes: string[];
}

function resolveDatasetDir(override: string | undefined, envValue: string | undefined): string {
  return path.resolve(override ?? envValue?.trim() ?? "dataset");
}

async function exists(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => undefined)) !== undefined;
}

async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(temp, data, "utf8");
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createBiliPullTool(options: BiliPullToolOptions = {}) {
  return defineTool({
    name: "bili_pull",
    description:
      "从采集服务器拉取 B 站视频快照（bili-snapshot/v1 JSON）到本地数据集，供 bili_collect / scanner 读取。" +
      "支持单个 BV、按 since 批量、以及只查看服务器清单；拉取时校验快照格式与 BV 号，写盘原子替换。" +
      "服务器地址来自 BILI_HUB_URL（鉴权用 BILI_HUB_TOKEN），落盘目录为 BILI_DATASET_DIR（缺省 dataset/）。",
    schema: PullParamsSchema,
    parallelSafe: false,
    needsReconciliation: false,
    execute: async (params) => pull(params, options),
  });
}

async function pull(params: PullParams, options: BiliPullToolOptions): Promise<string> {
  const env = options.env ?? process.env;
  const hub = options.hub ?? resolveHubConfig(env);
  const datasetDir = resolveDatasetDir(options.datasetDir, env.BILI_DATASET_DIR);
  const limit = params.limit ?? 20;
  const force = params.force === true;

  if (params.bvid !== undefined && params.list === true) {
    throw new Error("bvid 与 list 不能同时使用：列清单用 list，拉单个用 bvid");
  }
  if (params.bvid === undefined && params.list !== true && params.since === undefined) {
    throw new Error("至少指定一种操作：bvid（拉单个）、since（批量）或 list:true（只看清单）");
  }

  if (params.list === true) {
    const page = await listSnapshots(hub, {
      ...(params.since !== undefined ? { since: params.since } : {}),
      limit,
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    });
    const report: PullReport = {
      mode: "list",
      items: page.items,
      ...(page.next_cursor !== undefined ? { next_cursor: page.next_cursor } : {}),
      notes: page.items.length === 0 ? ["服务器没有符合条件的快照"] : [],
    };
    return JSON.stringify(report, null, 2);
  }

  const notes: string[] = [];
  const report: PullReport = {
    mode: params.bvid !== undefined ? "single" : "batch",
    downloaded: [],
    failed: [],
    notes,
  };

  let bvids: string[];
  if (params.bvid !== undefined) {
    bvids = [resolveBvid(params.bvid)];
  } else {
    const page = await listSnapshots(hub, {
      since: params.since!,
      limit,
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    });
    if (page.next_cursor !== undefined) {
      report.next_cursor = page.next_cursor;
      notes.push("还有更多结果，用 next_cursor 继续拉取");
    }
    bvids = [...new Set(page.items.map((item) => item.bvid))];
    if (bvids.length === 0) notes.push("服务器没有 since 之后有更新的快照");
  }

  for (const bvid of bvids) {
    try {
      report.downloaded!.push(await pullOne(bvid, hub, datasetDir, force));
    } catch (error) {
      report.failed!.push({ bvid, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (report.downloaded!.length > 0) notes.push(`快照目录：${datasetDir}`);
  return JSON.stringify(report, null, 2);
}

async function pullOne(bvid: string, hub: HubConfig, datasetDir: string, force: boolean): Promise<PulledEntry> {
  const target = snapshotPath(datasetDir, bvid);
  if (!force && (await exists(target))) {
    return { bvid, snapshot: "skipped", path: target };
  }
  const pulled = await fetchSnapshot(hub, bvid);
  await writeFileAtomic(target, pulled.raw);
  return { bvid, snapshot: "downloaded", path: target, fetched_at: pulled.snapshot.fetched_at, bytes: pulled.bytes };
}
