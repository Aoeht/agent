// src/mcp/hot_reload.ts
/**
 * MCP 配置热载入：服务器清单从编译期静态数组（config.ts 的 McpServers）扩展为
 * 「内置默认 ⊕ .mcp.json」合并结果，文件变更无需重启进程即生效。
 *
 * 合并语义（按 id）：
 *   - 文件条目替换同 id 的内置配置（可改 args/headers/超时等）；
 *   - 新 id 追加；
 *   - 值为 false 表示下线该 server（含内置的）；
 *   - 文件不存在 → 只用内置；解析失败/条目不合法 → 告警并保持上一次有效结果（fail-safe）。
 *
 * 应用方式：与当前已加载集合做增量 diff——新增 addServer、消失 removeServer、
 * 配置变化 removeServer + addServer（重连）。单个 server 失败不影响其余。
 */
import fs from "node:fs/promises";
import { watch as watchSync, type FSWatcher } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServers } from "./config";
import type { McpClientManager } from "./client_manager";
import type { McpServerConfig } from "./types";

/** 热载入配置文件路径：项目根 .mcp.json，AGENT_MCP_CONFIG 可改 */
export const MCP_CONFIG_PATH = path.resolve(
  process.env.AGENT_MCP_CONFIG ?? path.join(process.cwd(), ".mcp.json")
);

const stdioEntry = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const httpEntry = z.object({
  transport: z.literal("streamableHttp"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const sseEntry = z.object({
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** 文件条目公共字段（与 McpServerConfigBase 对齐；id 来自外层键名） */
const entrySchema = z.intersection(
  z.union([stdioEntry, httpEntry, sseEntry]),
  z.object({
    enabled: z.boolean().optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    allowedTools: z.array(z.string()).optional(),
    loggingLevel: z.enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]).optional(),
    roots: z.array(z.string()).optional(),
  })
);

const fileSchema = z.object({ servers: z.record(z.string(), z.unknown()) });

/** 一次热载入的变更摘要（日志与测试断言用） */
export interface McpConfigDiff {
  added: McpServerConfig[];
  removed: string[];
  reloaded: McpServerConfig[];
  unchanged: string[];
}

/**
 * 读文件并与内置默认合并。文件缺失 → 纯内置；文件坏/条目不合法 → 告警并用内置兜底。
 * 返回 null 表示"读取失败且没有内置兜底语义"之外不应发生的情况（目前不会，保留给调用方判空）。
 */
export async function resolveMcpServers(
  filePath: string = MCP_CONFIG_PATH
): Promise<{ servers: McpServerConfig[]; fileIssues: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return { servers: [...McpServers], fileIssues: [] }; // 没有配置文件：与旧行为一致
  }

  const fileIssues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fileIssues.push(`JSON 解析失败（${error instanceof Error ? error.message : error}），忽略整个文件`);
    return { servers: [...McpServers], fileIssues };
  }
  const check = fileSchema.safeParse(parsed);
  if (!check.success) {
    fileIssues.push(`文件结构不合法（${check.error.issues[0]?.path.join(".")} ${check.error.issues[0]?.message}），忽略整个文件`);
    return { servers: [...McpServers], fileIssues };
  }

  const merged = new Map(McpServers.map((config) => [config.id, config]));
  // 逐条校验：单个条目不合法只跳过它并告警，不拖垮整个文件
  for (const [id, rawEntry] of Object.entries(check.data.servers)) {
    if (id.trim() === "") {
      fileIssues.push("空 id 条目已跳过");
      continue;
    }
    if (rawEntry === false) {
      merged.delete(id);
      continue;
    }
    const entryCheck = entrySchema.safeParse(rawEntry);
    if (!entryCheck.success) {
      fileIssues.push(`条目 ${id} 不合法（${entryCheck.error.issues[0]?.path.join(".")} ${entryCheck.error.issues[0]?.message}），已跳过`);
      continue;
    }
    // zod 已保证形状与 McpServerConfig 兼容（transport 分支字段 + 公共可选字段）；
    // exactOptionalPropertyTypes 下逐字段展开太啰嗦，这里收窄一次
    const config = { id, ...entryCheck.data } as McpServerConfig;
    merged.set(id, config);
  }
  return { servers: [...merged.values()], fileIssues };
}

/** 目标清单 vs 当前已应用清单的增量计划（纯函数，测试可直接断言） */
export function planMcpDiff(current: Map<string, McpServerConfig>, target: McpServerConfig[]): McpConfigDiff {
  const targetMap = new Map(target.map((config) => [config.id, config]));
  const diff: McpConfigDiff = { added: [], removed: [], reloaded: [], unchanged: [] };
  for (const [id, config] of targetMap) {
    const existing = current.get(id);
    if (config.enabled === false) continue; // 目标里被禁用：等价于不存在，由 removed 收拾
    if (!existing) diff.added.push(config);
    else if (canonicalOf(existing) !== canonicalOf(config)) diff.reloaded.push(config);
    else diff.unchanged.push(id);
  }
  for (const id of current.keys()) {
    if (!targetMap.has(id) || targetMap.get(id)!.enabled === false) diff.removed.push(id);
  }
  return diff;
}

/**
 * 配置的规范化比较键：键序无关、`enabled` 缺省视为 true、空 args 视为缺省——
 * 避免"用户文件里少写了 enabled: true"导致每次重载都被误判为配置变化而重连。
 */
function canonicalOf(config: McpServerConfig): string {
  const record = { ...config } as Record<string, unknown>;
  if (record.enabled === true) delete record.enabled;
  if (Array.isArray(record.args) && record.args.length === 0) delete record.args;
  const sorted = Object.keys(record).sort().map((key) => [key, record[key]]);
  return JSON.stringify(sorted);
}

/** 按计划增量应用；返回实际执行结果摘要。串行执行避免并发重连同一个 server。 */
export async function applyMcpPlan(
  mcp: Pick<McpClientManager, "addServer" | "removeServer">,
  plan: McpConfigDiff
): Promise<{ ok: string[]; failed: Array<{ id: string; error: string }> }> {
  const ok: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of plan.removed) {
    try {
      await mcp.removeServer(id);
      ok.push(`-${id}`);
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const reloadIds = new Set(plan.reloaded.map((config) => config.id));
  for (const config of [...plan.reloaded, ...plan.added]) {
    try {
      if (reloadIds.has(config.id)) {
        await mcp.removeServer(config.id);
        ok.push(`-${config.id}`);
      }
      await mcp.addServer(config);
      ok.push(`+${config.id}`);
    } catch (error) {
      failed.push({ id: config.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok, failed };
}

/** 应用成功后的"当前已应用"状态（禁用条目剔除——它们不该被记为已加载） */
export function appliedMapOf(servers: McpServerConfig[]): Map<string, McpServerConfig> {
  return new Map(servers.filter((config) => config.enabled !== false).map((config) => [config.id, config]));
}

/**
 * 配置文件 watcher：防抖监听（目录级——编辑器常以原子替换写文件，只 watch 文件句柄会丢事件），
 * 变更后重新 resolve → diff → 增量应用。解析失败保持上一次有效结果。
 */
export class McpConfigWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private applied: Map<string, McpServerConfig>;

  constructor(
    private readonly mcp: Pick<McpClientManager, "addServer" | "removeServer">,
    private readonly filePath: string = MCP_CONFIG_PATH,
    applied: McpServerConfig[] = [...McpServers]
  ) {
    this.applied = appliedMapOf(applied);
  }

  /** 当前已应用清单（外部初始加载后应把实际结果喂回来：见 useApplied） */
  useApplied(servers: McpServerConfig[]): void {
    this.applied = appliedMapOf(servers);
  }

  start(): void {
    try {
      this.watcher = watchSync(path.dirname(this.filePath), { persistent: false }, (_event, filename) => {
        if (filename !== path.basename(this.filePath)) return;
        this.scheduleReload();
      });
      this.watcher.on("error", (error) => {
        console.warn(`[MCP] 配置目录监听失败（热载入停用）: ${error instanceof Error ? error.message : error}`);
        this.close();
      });
    } catch (error) {
      console.warn(`[MCP] 配置目录监听启动失败（热载入停用）: ${error instanceof Error ? error.message : error}`);
    }
  }

  close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** 防抖：编辑器保存常触发多个事件，攒 300ms 一次处理 */
  private scheduleReload(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, 300);
  }

  /** 手动触发重载（测试用；watcher 正常走 scheduleReload）。排队在链尾执行，避免并发读到同一旧水位 */
  async reload(): Promise<McpConfigDiff | null> {
    const run = async (): Promise<McpConfigDiff | null> => {
      const { servers, fileIssues } = await resolveMcpServers(this.filePath);
      for (const issue of fileIssues) console.warn(`[MCP] .mcp.json: ${issue}`);
      const plan = planMcpDiff(this.applied, servers);
      if (plan.added.length === 0 && plan.removed.length === 0 && plan.reloaded.length === 0) return plan;
      const { ok, failed } = await applyMcpPlan(this.mcp, plan);
      if (ok.length > 0) console.log(`🔁 [MCP] 配置热载入生效: ${ok.join("、")}`);
      for (const miss of failed) console.error(`[MCP] 热载入 ${miss.id} 失败: ${miss.error}`);
      // 按"目标清单"推进水位：失败的 server 下轮重载会作为差异重试
      this.applied = appliedMapOf(servers);
      return plan;
    };
    const task = this.chain.then(run, run);
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }
}
