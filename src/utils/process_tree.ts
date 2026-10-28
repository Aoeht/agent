// src/utils/process_tree.ts
/**
 * 进程树终止：host 脚本常会再派生解释器或外部工具（python → ffmpeg、bash → 后台命令），
 * 只杀直接子进程会把孙进程留成孤儿，继续占端口、写文件、烧 CPU。
 *
 * - Windows：taskkill /T /F 按父子关系收整棵树（没有 Job Object 的硬边界：中间父进程先退出、
 *   孙进程被系统重挂后按当前树找不到，此时按单 pid 兜底）；
 * - POSIX：后台任务以 detached 启动、自成进程组，kill(-pgid) 一次收全组；不是组长时退回单进程。
 */
import { spawnSync, type ChildProcess } from "node:child_process";

/** 强制终止 pid 及其后代；进程已退出时静默返回 */
export function killPidTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status === 0) return;
    try {
      process.kill(pid);
    } catch {
      /* 已退出或权限不足 */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出或权限不足 */
    }
  }
}

/** 终止 spawn 出来的子进程整棵树；pid 缺失（启动失败）时退回 child.kill() */
export function killChildTree(child: ChildProcess): void {
  if (child.pid !== undefined) {
    killPidTree(child.pid);
    return;
  }
  try {
    child.kill();
  } catch {
    /* 进程已退出 */
  }
}
