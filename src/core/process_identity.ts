// src/core/process_identity.ts
/**
 * 进程身份：pid 会被系统复用，只判断「这个 pid 还活着」不足以说明账本里记录的属主还是当初那个执行器。
 * 身份因此是「pid + 进程启动时间」：本进程的启动时间从 performance.timeOrigin 取（免探针），
 * 其它进程只能问系统，结果按 pid 缓存并带 TTL —— 探针一次在 Windows 上要起一个 PowerShell（~300ms），
 * 而恢复疑似存活的属主会在每次读写账本时走到，不能每次都付这个代价。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * 允许的启动时间误差。本进程用 performance.timeOrigin（运行时初始化后的时间原点），
 * 系统探针给的是进程创建时刻，实测 Windows 上差 ~20ms；POSIX 的 ps 只有秒级精度。
 * 这个窗口只需区分「同一进程」与「pid 被复用后新起的进程」——后者必然晚于原进程退出，
 * 而任务账本里的属主至少活了数秒，2s 的窗口不会把两者混起来。
 */
const START_TOLERANCE_MS = 2_000;
/** 探针结果缓存时长：只在存在并发执行器时才会反复探测同一 pid，避免每次账本事务都起子进程 */
const PROBE_TTL_MS = 10_000;

const probes = new Map<number, { at: number; startedAt: number | undefined }>();

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** 本进程启动时刻（epoch ms）；Node/Bun 的 performance.timeOrigin 即进程启动时间，无需探针 */
export function ownProcessStartedAt(): number {
  return Math.round(performance.timeOrigin);
}

/**
 * 任意进程的启动时刻（epoch ms）。探测不可用（平台不支持、命令缺失、权限不足）时返回 undefined，
 * 调用方据此退回「只看存活」的旧语义，而不是把探测失败当成进程已死。
 */
export function processStartedAt(pid: number): number | undefined {
  const now = Date.now();
  const cached = probes.get(pid);
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.startedAt;
  let startedAt: number | undefined;
  try { startedAt = probe(pid); } catch { startedAt = undefined; }
  probes.set(pid, { at: now, startedAt });
  return startedAt;
}

function probe(pid: number): number | undefined {
  if (process.platform === "linux") {
    // /proc/<pid>/stat 第 22 个字段是自开机以来的时钟滴答数（comm 可能含空格，从最后一个右括号后数）
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[19]);
    const boot = Number(/^btime\s+(\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
    // 用户态时钟一般是 100Hz；拿不到 btime 或字段异常就当作探测失败
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : undefined;
  }
  const raw = process.platform === "win32"
    ? execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: "utf8", timeout: 5_000, windowsHide: true })
    : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 账本属主是否还是当初那个进程。旧记录没有启动时间、或系统探测不可用时退回只看存活
 * （宁可拦住一次并发写，也不凭猜测拆掉别人的执行权）。
 */
export function isSameProcess(pid: number, startedAt?: number): boolean {
  if (!isProcessAlive(pid)) return false;
  if (startedAt === undefined) return true;
  const probed = processStartedAt(pid);
  return probed === undefined || Math.abs(probed - startedAt) <= START_TOLERANCE_MS;
}
