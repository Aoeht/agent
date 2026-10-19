// src/tools/sandbox_docker.ts
/**
 * run_script 的 docker 执行后端（一期）：宿主进程只负责拼 argv 与守边界（路径守卫、
 * 人工确认仍在宿主侧），脚本本体跑在一次性容器里，隔离从「进程级」升级到「系统级」——
 * 默认断网、rootfs 只读、去能力 + 禁提权、CPU/内存（含 swap）/pids/句柄/单文件体积
 * 硬顶、init 收割僵尸、宿主环境变量一个不传。
 *
 * 两条硬规则：
 * - docker 不可用绝不静默降级：auto 模式回退 host 时带原因交启动日志显式说明；
 *   AGENT_SANDBOX=docker 是强承诺，不可用直接抛错终止启动（宁可不可用也不静默放宽）。
 * - 超时/中止时杀 docker CLI 只是断开连接，容器还在跑 —— 必须补 docker rm -f <名字>；
 *   容器名因此固定可预测（newContainerName），正常退出靠 --rm 零残留。
 *
 * buildDockerRunArgs 是纯函数：docker run 参数表可离线单测，不用起真容器。
 */
import { spawn } from "node:child_process";

/** 容器网络档位：none = 断网（默认，防「读到数据后外传」）；bridge = 显式放开（确认提示会注明） */
export type SandboxNetwork = "none" | "bridge";

export interface DockerSandboxOptions {
  image: string;
  network: SandboxNetwork;
}

/** 输出截断上限：与 MCP adapter 的 maxResultChars 同量级（run_script 复用同一口径） */
export const MAX_STREAM_CHARS = 10_000;
/** shell 惯例：124 = 超时终止 */
export const EXIT_TIMED_OUT = 124;

/** 资源与安全硬顶写死在代码里而不做成配置：防止配置漂移悄悄放松隔离 */
const CONTAINER_CPUS = "1";
const CONTAINER_MEMORY = "512m";
/** memory-swap 是 memory + swap 的总闸：与 --memory 相等即禁用 swap（不设则默认还能再用等量 swap，内存放大面 2x） */
const CONTAINER_MEMORY_SWAP = "512m";
const CONTAINER_PIDS_LIMIT = "64";
/** 单进程文件句柄上限（软/硬一致）：防句柄耗尽拖垮宿主侧文件共享通道 */
const ULIMIT_NOFILE = "256:256";
/** 单文件体积上限（bytes，1 GiB）：防把宿主盘写爆；目录级总量配额在 bind mount 上做不到（已知盲区，靠断网+人工确认兜底） */
const ULIMIT_FSIZE_BYTES = "1073741824";
/** 容器内工作区挂载点：host 侧沙箱根目录只挂这一个位置，脚本路径统一翻译到它下面 */
export const CONTAINER_WORKSPACE = "/workspace";

/** 探测/清理用的轻量 docker 子进程：输出量小，超时直接杀；docker 不在 PATH 时按 127 报告 */
function runDockerQuick(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** docker CLI + 守护进程都可用才算可用：--format 只有连得上 daemon 时才有输出 */
export async function dockerDaemonAvailable(): Promise<boolean> {
  const probe = await runDockerQuick(["version", "--format", "{{.Server.Version}}"], 15_000);
  return probe.code === 0 && probe.stdout.trim() !== "";
}

export async function sandboxImagePresent(image: string): Promise<boolean> {
  return (await runDockerQuick(["image", "inspect", image], 15_000)).code === 0;
}

/** 可预测的容器名：超时/中止后按名字 rm -f 收尸；进程号 + 时间戳避免并行/重跑撞名 */
export function newContainerName(): string {
  return `ai-agent-run-${process.pid}-${Date.now()}`;
}

export interface DockerRunSpec {
  containerName: string;
  image: string;
  network: SandboxNetwork;
  /** 宿主侧沙箱根目录（绝对路径），挂为容器内 /workspace（读写：脚本的产物要落回工作区） */
  workspaceHostPath: string;
  /** 容器内 argv：解释器 + 脚本（/workspace 下 POSIX 路径）+ 参数，逐个传递不经 shell */
  argv: string[];
}

/**
 * 纯函数：docker run 的完整 argv。安全基线逐条列出，缺一条都是降级：
 * - --network none（默认）：断网是防外传的主闸，bridge 档位须显式指定才放开；
 * - CPU/内存（含 swap）/pids/句柄/单文件体积硬顶：即使 agent 崩溃留下孤儿容器，
 *   也吃不满宿主、写不爆盘（swap 总闸与 --memory 等值，不给 2x 放大面）；
 * - --init：PID 1 由 docker-init 充当，收割 fork 后不 wait 的僵尸进程，
 *   否则僵尸吃满 pids-limit 配额，64 个之后新进程全失败；
 * - 去 + 禁提权 + rootfs 只读：容器内可写面压缩到挂载的工作区与 tmpfs（nosuid,nodev）；
 * - 不传任何 -e：宿主环境变量零透传（修掉 host 后端 ...process.env 的全量泄漏面）；
 * - 不分配 stdin：脚本不该读宿主的输入流。
 */
export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  return [
    "run",
    "--rm",
    "--name",
    spec.containerName,
    "--network",
    spec.network,
    "--cpus",
    CONTAINER_CPUS,
    "--memory",
    CONTAINER_MEMORY,
    "--memory-swap",
    CONTAINER_MEMORY_SWAP,
    "--pids-limit",
    CONTAINER_PIDS_LIMIT,
    // 句柄与单文件体积：防耗尽 / 防写爆（fsize 是目录配额的次优替代，见常量注释）
    "--ulimit",
    `nofile=${ULIMIT_NOFILE}`,
    "--ulimit",
    `fsize=${ULIMIT_FSIZE_BYTES}:${ULIMIT_FSIZE_BYTES}`,
    // PID 1 收割僵尸进程：见函数 doc 注释
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    // 只读 rootfs 下 python/bun 的缓存与临时文件写不进系统目录，指到 tmpfs：
    // /tmp 通用；$HOME 兜底（解释器偶尔仍会往用户目录写配置）。
    // nosuid,nodev：tmpfs 用不上 setuid 与设备节点，顺手关掉；
    // noexec 特意不加——部分 wheel/运行时会从临时目录 mmap+dlopen，noexec 会误伤
    "--tmpfs",
    "/tmp:rw,size=64m,nosuid,nodev",
    "--tmpfs",
    "/home/sandbox:rw,uid=1000,gid=1000,size=64m,nosuid,nodev",
    "-u",
    "1000:1000",
    "-v",
    `${spec.workspaceHostPath}:${CONTAINER_WORKSPACE}`,
    "-w",
    CONTAINER_WORKSPACE,
    spec.image,
    ...spec.argv,
  ];
}

export interface DockerRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 跑一次性容器并捕获输出。与宿主 spawnCapture 的关键差异在收尾：
 * 杀 docker CLI 不会停容器，超时/中止必须再补 docker rm -f；rm -f 对运行中的
 * 容器等价 kill + remove，--rm 只负责正常退出时的自清理。
 */
export function runInDocker(spec: DockerRunSpec, timeoutMs: number, signal?: AbortSignal): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", buildDockerRunArgs(spec), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let terminated = false;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_STREAM_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STREAM_CHARS) stderr += chunk;
    });
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      try {
        child.kill();
      } catch {
        /* 进程已退出 */
      }
      // 容器清理与主结果无关：失败（如 docker 突然不可用）静默，别盖掉真实退出信息
      const rm = spawn("docker", ["rm", "-f", spec.containerName], { windowsHide: true, stdio: "ignore" });
      rm.on("error", () => {});
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener("abort", () => terminate(), { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n[sandbox_docker] 启动失败：${error.message}`.trim(), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? EXIT_TIMED_OUT : (code ?? 1),
        stdout,
        // 超时前缀把「沙箱超时」与「脚本自己 exit 124」区分开，审计时不再二义
        stderr: timedOut ? `[sandbox_docker] 超时强制终止，容器已 rm -f；以下为超时前输出：\n${stderr}` : stderr,
        timedOut,
      });
    });
  });
}

export type ScriptSandboxResolution =
  | { backend: "docker"; image: string; network: SandboxNetwork }
  | { backend: "host"; reason: string };

/**
 * 把 AGENT_SANDBOX 模式解析成实际后端。
 * - host：直接宿主机进程（现状行为）；
 * - docker：强承诺，daemon/镜像不可用直接抛错，绝不降级；
 * - auto（默认）：daemon 与镜像都就绪才用容器，否则回退 host 并给出原因与补救命令。
 */
export async function resolveScriptSandbox(
  mode: "host" | "docker" | "auto",
  options: DockerSandboxOptions
): Promise<ScriptSandboxResolution> {
  if (mode === "host") return { backend: "host", reason: "AGENT_SANDBOX=host" };
  if (!(await dockerDaemonAvailable())) {
    if (mode === "docker") {
      throw new Error("AGENT_SANDBOX=docker 但 docker 守护进程不可用：请启动 Docker Desktop，或改用 AGENT_SANDBOX=auto / host");
    }
    return { backend: "host", reason: "docker 不可用，回退宿主机进程执行" };
  }
  if (!(await sandboxImagePresent(options.image))) {
    const buildCmd = `docker build -t ${options.image} tools/sandbox/`;
    if (mode === "docker") {
      throw new Error(`AGENT_SANDBOX=docker 但沙箱镜像不存在：先执行 ${buildCmd}`);
    }
    return {
      backend: "host",
      reason: `沙箱镜像 ${options.image} 不存在，回退宿主机进程执行（构建后自动启用容器隔离：${buildCmd}）`,
    };
  }
  return { backend: "docker", image: options.image, network: options.network };
}
