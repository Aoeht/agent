// src/core/job_store.ts
/**
 * 后台脚本任务的登记簿：run_script 的 background 分支把输出重定向到日志文件后立刻返回，
 * 元数据（pid / 状态 / 截止时间 / 日志路径）落成 JSON，job_output 工具据此轮询。
 *
 * 状态在**读取时**校正，而不是只依赖进程内回调：
 * - 到截止时间仍在跑 → 杀进程并标 timed_out；
 * - 进程已不在、也没收到 close（登记它的 agent 进程重启过）→ 标 exited 且标注 reconciled，
 *   此时拿不到真实退出码，宁可说"不知道"也不编一个。
 * 这样即使登记者没了，留下的任务记录仍然可读、可清理。
 *
 * kill 的粒度与同步路径保持一致：host 后端杀直接子进程（不连带孙进程，见 src/tools/run_script.ts
 * 顶部注释的已知边界）；docker 后端杀 docker CLI 之后必须补 docker rm -f 收容器。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

export type JobStatus = "running" | "exited" | "timed_out" | "killed";

export interface JobRecord {
  id: string;
  /** 工作区相对路径（脚本路径，回车确认里展示的那一个） */
  script: string;
  args: string[];
  backend: "host" | "docker";
  /** 直接子进程：host 是解释器，docker 是 docker CLI */
  pid: number;
  /** docker 后端才有的容器名，超时要补 rm -f */
  container?: string;
  status: JobStatus;
  exitCode?: number;
  startedAt: number;
  deadlineAt: number;
  endedAt?: number;
  /** 状态是读取时按 pid 存活校正出来的（真实退出码不可知） */
  reconciled?: boolean;
}

export interface JobLogs {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export type JobStream = "stdout" | "stderr";

/** 增量日志块：after 偏移语义，前端按 offset 续拉就是 tail -f */
export interface JobLogChunk {
  stream: JobStream;
  /** 本次新增的文本；reset=true 时是尾部窗口的完整快照（前端应清空重放） */
  text: string;
  /** 下次请求的 after 偏移（字节） */
  offset: number;
  /** 文件当前字节数 */
  size: number;
  reset: boolean;
}

/** 单次增量读取的字节上限：UI 掉线一段时间后不该一次拉回整份日志 */
const MAX_CHUNK_BYTES = 32_768;

const ID_PATTERN = /^job-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

/** shell 惯例：124 = 超时终止；与 tools/sandbox_docker.ts 的 EXIT_TIMED_OUT 同口径 */
const EXIT_TIMED_OUT = 124;

/** pid 是否还活着：ESRCH 才是"不存在"，EPERM 说明进程在但没有权限探测 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isJobRecord(value: unknown): value is JobRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Partial<JobRecord>;
  return (
    typeof rec.id === "string" &&
    ID_PATTERN.test(rec.id) &&
    typeof rec.script === "string" &&
    Array.isArray(rec.args) &&
    (rec.backend === "host" || rec.backend === "docker") &&
    typeof rec.pid === "number" &&
    typeof rec.startedAt === "number" &&
    typeof rec.deadlineAt === "number" &&
    (rec.status === "running" || rec.status === "exited" || rec.status === "timed_out" || rec.status === "killed")
  );
}

/** 读文件尾部 chars 个字符：多读 4 倍字节再按字符截，避免把多字节字符切一半后花屏 */
async function readTail(file: string, chars: number): Promise<{ text: string; bytes: number }> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - chars * 4);
    const buffer = Buffer.alloc(size - start);
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf-8");
    return { text: text.length > chars ? text.slice(text.length - chars) : text, bytes: size };
  } catch {
    return { text: "", bytes: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 增量读取按字节切窗，多字节字符可能被切一半：把末尾不完整的序列留到下一次。
 * 返回可以安全解码的字节数（不含被截断的尾部）。
 */
function cutIncompleteUtf8(buf: Buffer): number {
  let index = buf.length - 1;
  let continuation = 0;
  while (index >= 0 && (buf[index]! & 0xc0) === 0x80 && continuation < 3) {
    index--;
    continuation++;
  }
  if (index < 0) return buf.length;
  const lead = buf[index]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return continuation + 1 < need ? index : buf.length;
}

export class JobStore {
  /** 本进程登记过的子进程：close 只在这个进程活着时才收得到 */
  private readonly tracked = new Map<string, { child: ChildProcess; timer: NodeJS.Timeout }>();

  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  newId(): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    const now = new Date();
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    return `job-${stamp}-${rand}`;
  }

  paths(id: string): { meta: string; stdout: string; stderr: string } {
    return {
      meta: path.join(this.dir, `${id}.json`),
      stdout: path.join(this.dir, `${id}.out.log`),
      stderr: path.join(this.dir, `${id}.err.log`),
    };
  }

  /** 组装一条初始记录（status=running）；pid 由调用方 spawn 之后填入 */
  record(input: {
    id: string;
    script: string;
    args: string[];
    backend: "host" | "docker";
    pid: number;
    container?: string;
    timeoutMs: number;
  }): JobRecord {
    const startedAt = Date.now();
    return {
      id: input.id,
      script: input.script,
      args: input.args,
      backend: input.backend,
      pid: input.pid,
      ...(input.container !== undefined ? { container: input.container } : {}),
      status: "running",
      startedAt,
      deadlineAt: startedAt + input.timeoutMs,
    };
  }

  async save(record: JobRecord): Promise<void> {
    const target = this.paths(record.id).meta;
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(record), "utf-8");
    await fs.rename(tmp, target);
  }

  async read(id: string): Promise<JobRecord | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.paths(id).meta, "utf-8"));
      return isJobRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** 读取并校正状态（到点回收 / 进程不在但没收到 close） */
  async get(id: string): Promise<JobRecord | undefined> {
    const record = await this.read(id);
    return record === undefined ? undefined : this.reconcile(record);
  }

  /** 最近的任务，按开始时间倒序；上限用于列表接口，校正对每条都做 */
  async list(limit = 20): Promise<JobRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const records: JobRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await this.read(name.slice(0, -".json".length));
      if (record !== undefined) records.push(await this.reconcile(record));
    }
    records.sort((a, b) => b.startedAt - a.startedAt);
    return Number.isFinite(limit) ? records.slice(0, limit) : records;
  }

  async logs(id: string, chars: number): Promise<JobLogs> {
    const paths = this.paths(id);
    const [stdout, stderr] = await Promise.all([readTail(paths.stdout, chars), readTail(paths.stderr, chars)]);
    return { stdout: stdout.text, stderr: stderr.text, stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes };
  }

  /**
   * 日志窗口读取：
   * - 不传 after → 返回尾部快照（reset=true），用于打开面板时的首屏；
   * - 传 after → 返回 [after, after+chunk) 的增量（reset=false）；
   * - after 超出文件大小（日志被清空/换了一份）→ 同样回尾部快照重来。
   */
  async readLog(
    id: string,
    stream: JobStream,
    options: { after?: number; maxChars?: number } = {}
  ): Promise<JobLogChunk> {
    const maxChars = Math.min(40_000, Math.max(200, options.maxChars ?? 8_000));
    const { after } = options;
    const file = this.paths(id)[stream];
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(file, "r");
      const { size } = await handle.stat();
      const tail = async (): Promise<JobLogChunk> => {
        const start = Math.max(0, size - maxChars * 4);
        const buffer = Buffer.alloc(size - start);
        if (buffer.length > 0) await handle!.read(buffer, 0, buffer.length, start);
        let text = buffer.toString("utf-8");
        if (text.length > maxChars) text = text.slice(text.length - maxChars);
        return { stream, text, offset: size, size, reset: true };
      };
      if (after === undefined || after > size) return await tail();
      const end = Math.min(size, after + MAX_CHUNK_BYTES);
      if (end <= after) return { stream, text: "", offset: after, size, reset: false };
      const buffer = Buffer.alloc(end - after);
      await handle.read(buffer, 0, buffer.length, after);
      const consumed = cutIncompleteUtf8(buffer);
      return {
        stream,
        text: buffer.subarray(0, consumed).toString("utf-8"),
        offset: after + consumed,
        size,
        reset: false,
      };
    } catch {
      return { stream, text: "", offset: after ?? 0, size: 0, reset: after === undefined };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** 面板上的「终止」：与到点回收同一套 kill 粒度；已结束的任务原样返回 */
  async kill(id: string): Promise<JobRecord | undefined> {
    const record = await this.read(id);
    if (record === undefined) return undefined;
    if (record.status !== "running") return record;
    await this.terminate(record);
    const killed: JobRecord = { ...record, status: "killed", endedAt: Date.now() };
    await this.save(killed);
    return killed;
  }

  /**
   * 接管子进程的收尾：close 时把退出码写回记录，并按 deadline 挂一个超时定时器。
   * 定时器 unref：后台任务不该拖着 agent 进程不退出。
   */
  track(record: JobRecord, child: ChildProcess): void {
    const timer = setTimeout(() => {
      void this.expire(record.id);
    }, Math.max(0, record.deadlineAt - Date.now()));
    timer.unref?.();
    this.tracked.set(record.id, { child, timer });

    const finish = async (code: number | null): Promise<void> => {
      clearTimeout(timer);
      this.tracked.delete(record.id);
      const current = (await this.read(record.id)) ?? record;
      if (current.status !== "running") {
        // 已被 expire/kill 定过状态：只补退出码与结束时间，不覆盖原因
        const exitCode =
          current.exitCode ??
          (current.status === "timed_out" ? EXIT_TIMED_OUT : code ?? 1);
        await this.save({ ...current, endedAt: current.endedAt ?? Date.now(), exitCode });
        return;
      }
      await this.save({ ...current, status: "exited", endedAt: Date.now(), exitCode: code ?? 1 });
    };
    // 极短脚本可能在登记（写 JSON 是异步的）期间就退出，close 已经错过：
    // 先看退出码，别让这种任务永远停在 running
    if (child.exitCode !== null) {
      void finish(child.exitCode);
      return;
    }
    child.on("close", (code) => {
      void finish(code);
    });
    child.on("error", (error) => {
      void (async () => {
        const current = await this.read(record.id);
        if (current !== undefined && current.status === "running") {
          await this.save({ ...current, status: "exited", exitCode: 127, endedAt: Date.now() });
        }
        await fs
          .appendFile(this.paths(record.id).stderr, `\n[job] 启动失败：${error.message}\n`, "utf-8")
          .catch(() => {});
      })();
    });
  }

  /** 到点回收：杀掉仍在跑的任务并标 timed_out（幂等，重复调用只生效一次） */
  async expire(id: string): Promise<void> {
    const record = await this.read(id);
    if (record === undefined || record.status !== "running") return;
    await this.terminate(record);
    // 退出码当场落定：close 回填是异步的，轮询可能在它之前就读到 timed_out
    await this.save({ ...record, status: "timed_out", endedAt: Date.now(), exitCode: EXIT_TIMED_OUT });
  }

  /** 关停时统一收口：把本目录下所有仍在跑的后台任务杀掉，不留孤儿 */
  async killAll(): Promise<number> {
    let killed = 0;
    for (const record of await this.list(Number.MAX_SAFE_INTEGER)) {
      if (record.status !== "running") continue;
      await this.terminate(record);
      await this.save({ ...record, status: "killed", endedAt: Date.now() });
      killed++;
    }
    return killed;
  }

  private async reconcile(record: JobRecord): Promise<JobRecord> {
    if (record.status !== "running") return record;
    if (Date.now() >= record.deadlineAt) {
      await this.expire(record.id);
      return (await this.read(record.id)) ?? record;
    }
    // 本进程没登记过它、pid 也不在：登记它的进程已经退出，真实退出码不可知
    if (!this.tracked.has(record.id) && !processAlive(record.pid)) {
      const exited: JobRecord = { ...record, status: "exited", endedAt: Date.now(), reconciled: true };
      await this.save(exited);
      return exited;
    }
    return record;
  }

  private async terminate(record: JobRecord): Promise<void> {
    const tracked = this.tracked.get(record.id);
    if (tracked !== undefined) {
      try {
        tracked.child.kill();
      } catch {
        /* 进程已退出 */
      }
    } else if (processAlive(record.pid)) {
      try {
        process.kill(record.pid);
      } catch {
        /* 进程已退出或权限不足 */
      }
    }
    if (record.container !== undefined) {
      // 杀 docker CLI 只是断开连接，容器还在跑：必须按可预测的名字收尸
      const rm = spawn("docker", ["rm", "-f", record.container], { windowsHide: true, stdio: "ignore" });
      rm.on("error", () => {});
    }
  }
}
