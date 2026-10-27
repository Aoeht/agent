// src/prompts/env_block.ts
/**
 * 运行环境块：会话创建时快照一次（日期/操作系统/宿主 cwd/工作区 git 状态），渲染成
 * 系统提示末尾的【运行环境】段——补齐现代 agent 的动态环境块缺口（现代Agent知识框架 3.8）。
 *
 * 会话内稳定是硬约束：环境块若每轮重算，自己就成了缓存破坏点。所以快照只在本模块
 * 被调用时取一次，之后由调用方持有，会话生命周期内不重算（buildSystemPrompt 每会话
 * 只调一次，快照天然随会话固定；promptHash 随之覆盖环境块内容，trace 可归因）。
 *
 * 渲染位置在系统提示最末尾（静态规则与技能段之后）也是刻意的：provider 按前缀块缓存，
 * 静态规则跨会话逐字节相同可命中；env 每会话都变，放最后只废掉它自己那一小段。
 */
import { spawnSync } from "node:child_process";
import os from "node:os";

export interface EnvSnapshot {
  /** "2026-10-27（周二，UTC+8）" 形态；快照由调用方固定，格式确定性（进系统提示） */
  currentDate: string;
  /** "Windows 10.0.19045（x64）" 形态 */
  os: string;
  /** 宿主进程工作目录——可能与工作区根目录不同，模型不该靠猜 */
  cwd: string;
  /** 一句话 git 状态；null = 工作区（含上层目录）不是 git 仓库，或 git 缺失/查询失败/超时 */
  git: string | null;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

function formatDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  // getTimezoneOffset 是"领先 UTC 的分钟数的相反数"（UTC+8 → -480），翻回正负
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const tz = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
  return `${y}-${m}-${d}（周${WEEKDAYS[now.getDay()]}，${tz}）`;
}

function describeOs(): string {
  const names: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
  const name = names[os.platform()] ?? os.platform();
  return `${name} ${os.release()}（${os.arch()}）`;
}

/**
 * git status --porcelain=v2 --branch 的输出 → 一句话。
 * 宽进严出：任何解析不动的形状（空输出、未来格式变化）都返回 null，宁可整行省略。
 */
export function parseGitStatus(stdout: string): string | null {
  let branch: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let dirty = 0;
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
    else if (line.startsWith("# branch.ab ")) {
      // "# branch.ab +1 -2"；无上游时整行缺席
      const parts = line.split(" ");
      const a = Number.parseInt((parts[2] ?? "").slice(1), 10);
      const b = Number.parseInt((parts[3] ?? "").slice(1), 10);
      if (!Number.isNaN(a)) ahead = a;
      if (!Number.isNaN(b)) behind = b;
    } else if (!line.startsWith("#")) dirty++;
  }
  if (branch === null) return null;
  const parts: string[] = [];
  parts.push(branch === "(detached)" ? "处于游离 HEAD（不挂在任何分支上）" : `分支 ${branch}`);
  if (ahead !== null && behind !== null && (ahead > 0 || behind > 0)) {
    const relation: string[] = [];
    if (ahead > 0) relation.push(`领先上游 ${ahead}`);
    if (behind > 0) relation.push(`落后 ${behind}`);
    parts.push(relation.join("、"));
  }
  parts.push(dirty === 0 ? "工作区干净" : `${dirty} 处未提交变更`);
  return parts.join("，");
}

const GIT_TIMEOUT_MS = 1500;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * 查询工作区 git 状态。子进程环境清空所有 GIT_* 变量（与 checkpoint_store 同一硬防线，
 * 防外层影子仓库/用户环境污染结果）；限时 + 限缓冲，失败一律静默降级为 null——
 * 环境信息是锦上添花，绝不能因为它拖住或打断会话创建。
 */
function queryGitStatus(root: string): string | null {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value;
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("git", ["-C", root, "status", "--porcelain=v2", "--branch"], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env,
      windowsHide: true,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return parseGitStatus(result.stdout);
}

/**
 * 取一次环境快照。withGit:false 跳过 git 子进程（短命子代理只需要日期，不值得为
 * 每个孩子付一次 spawn；主会话每会话一次，成本可忽略）。
 */
export function snapshotEnv(
  sandboxRoot: string,
  options: { now?: Date; withGit?: boolean } = {}
): EnvSnapshot {
  return {
    currentDate: formatDate(options.now ?? new Date()),
    os: describeOs(),
    cwd: process.cwd(),
    git: options.withGit === false ? null : queryGitStatus(sandboxRoot),
  };
}

export function renderEnvBlock(snapshot: EnvSnapshot): string {
  const lines = [
    "【运行环境】（会话创建时的快照，会话内不变；涉及时效的判断以其中日期为准，不要凭训练记忆猜日期）",
    `- 当前日期：${snapshot.currentDate}`,
    `- 操作系统：${snapshot.os}`,
    `- 宿主工作目录：${snapshot.cwd}`,
  ];
  if (snapshot.git !== null) lines.push(`- 工作区 git：${snapshot.git}`);
  return lines.join("\n");
}
