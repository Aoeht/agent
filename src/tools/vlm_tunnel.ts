// vLLM 专用判定的 SSH 隧道自动管理：服务只绑定服务器回环，本地经 ssh -N -L 转发。
// 配置 AGENT_VLLM_SSH_HOST（~/.ssh/config 的 Host 别名）即自动起隧道；不配置则保持手动模式。
// 本地端口从 providers.json 的 baseURL 推导，远端端口缺省与本地相同（AGENT_VLLM_REMOTE_PORT 可覆盖）。
// 进程级单例：端口已通直接复用（兼容手动隧道）；ssh 子进程随本进程退出回收。
import net from "node:net";
import { spawn } from "node:child_process";
import { providers, type ProviderStore } from "../core/providers";

export interface TunnelConfig {
  host: string;
  localPort: number;
  remotePort: number;
}

function invalidPort(name: string, value: number): never {
  throw new Error(`${name} 无效：${value}（需要 1–65535 的端口号）。`);
}

/** 未配置 AGENT_VLLM_SSH_HOST 返回 null（手动隧道模式）；配置了则从 baseURL 推导本地端口 */
export function resolveTunnelConfig(
  model: string,
  env: NodeJS.ProcessEnv,
  store: ProviderStore = providers,
): TunnelConfig | null {
  const host = env.AGENT_VLLM_SSH_HOST?.trim();
  if (!host) return null;
  let resolved: ReturnType<ProviderStore["resolve"]>;
  try {
    resolved = store.resolve(model);
  } catch {
    resolved = undefined;
  }
  if (!resolved) throw new Error(`SSH 隧道配置失败：模型引用 ${model} 在 providers.json 中不存在。`);
  const url = new URL(resolved.baseURL);
  const localPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) invalidPort("providers.json baseURL 的端口", localPort);
  const remoteRaw = env.AGENT_VLLM_REMOTE_PORT?.trim();
  let remotePort = localPort;
  if (remoteRaw) {
    remotePort = Number(remoteRaw);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) invalidPort("AGENT_VLLM_REMOTE_PORT", remotePort);
  }
  return { host, localPort, remotePort };
}

/** ssh 子进程的最小结构面：真实 ChildProcess 与测试替身都满足 */
export interface SshChild {
  stderr: NodeJS.ReadableStream | null;
  kill(): boolean;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface TunnelDeps {
  spawnSsh?: (args: string[]) => SshChild;
  portOpen?: (port: number) => Promise<boolean>;
  pollMs?: number;
  waitMs?: number;
}

function probePort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export class VlmTunnelManager {
  private child: SshChild | null = null;
  private exitError: Error | null = null;
  private ensuring: Promise<void> | null = null;
  private exitHooked = false;
  private readonly spawnSsh: (args: string[]) => SshChild;
  private readonly portOpen: (port: number) => Promise<boolean>;
  private readonly pollMs: number;
  private readonly waitMs: number;

  constructor(deps: TunnelDeps = {}) {
    this.spawnSsh = deps.spawnSsh ?? (args => spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    this.portOpen = deps.portOpen ?? probePort;
    this.pollMs = deps.pollMs ?? 250;
    this.waitMs = deps.waitMs ?? 15_000;
  }

  /** 幂等：端口已通（手动隧道或本进程已起）直接返回；否则起 ssh 并等到端口可用 */
  ensure(config: TunnelConfig): Promise<void> {
    this.ensuring ??= this.start(config).finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private killChild(): void {
    if (!this.child) return;
    try { this.child.kill(); } catch { /* 已退出 */ }
    this.child = null;
    this.exitError = null;
  }

  private async start(config: TunnelConfig): Promise<void> {
    if (await this.portOpen(config.localPort)) return;
    this.killChild();
    const args = [
      "-N",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-L", `${config.localPort}:127.0.0.1:${config.remotePort}`,
      config.host,
    ];
    let child: SshChild;
    try {
      child = this.spawnSsh(args);
    } catch (error) {
      throw new Error(`SSH 隧道启动失败：无法执行 ssh（${error instanceof Error ? error.message : String(error)}）。请确认本机已安装 OpenSSH 客户端。`);
    }
    this.child = child;
    let stderrTail = "";
    child.stderr?.on("data", chunk => { stderrTail = (stderrTail + String(chunk)).slice(-2000); });
    // 用标志位而非 reject 的 Promise：隧道建成后子进程仍长期存活，避免退出时产生未处理 rejection
    child.once("exit", (code, signal) => {
      this.exitError = new Error(`SSH 隧道进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）${stderrTail ? `：${stderrTail.trim()}` : ""}`);
    });
    child.once("error", error => {
      const hint = (error as NodeJS.ErrnoException).code === "ENOENT" ? "找不到 ssh 命令，请确认本机已安装 OpenSSH 客户端。" : "";
      this.exitError = new Error(`SSH 隧道启动失败：${error.message}。${hint}`);
    });
    if (!this.exitHooked) {
      this.exitHooked = true;
      process.once("exit", () => this.killChild());
    }
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      if (this.exitError) {
        const error = this.exitError;
        this.killChild();
        throw new Error(`SSH 隧道建立失败（${config.host} → 127.0.0.1:${config.localPort}）：${error.message} 请检查 ~/.ssh/config 的 Host 别名与免密密钥。`);
      }
      if (await this.portOpen(config.localPort)) return;
      if (Date.now() >= deadline) {
        this.killChild();
        throw new Error(`SSH 隧道建立超时（${this.waitMs}ms 内 127.0.0.1:${config.localPort} 仍不可达，host=${config.host}）。请检查服务器地址、密钥登录与远端 vLLM 端口 ${config.remotePort}。`);
      }
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
  }
}

/** 进程级单例：同一进程内多次挂载 scanner 注册表共用一条隧道 */
export const vlmTunnel = new VlmTunnelManager();