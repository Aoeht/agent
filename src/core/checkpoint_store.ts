// src/core/checkpoint_store.ts
/**
 * 回合级检查点（Claude Code 式 /rewind 的本地实现）：
 * 每轮对话开始前把工作区（MCP_SANDBOX_DIR）状态快照进一个与项目 .git 完全隔离的影子 git 仓库；
 * /rewind 可把工作区文件和/或会话对话回滚到任意检查点。
 *
 * 为什么底层是 git：内容寻址 blob 天然去重——每次快照的成本只与"改了什么"成正比，与工作区
 * 大小无关；SHA-1 完整性免费；恢复就是把某棵 tree 写回工作区。
 *
 * 影子仓库的隔离是硬约束（社区有过 checkpoint commits 漏进用户 git 历史的事故）：
 * - git-dir 固定在 <sessionDir>/checkpoints/<sessionId>/.git（.agent-sessions 已在 .gitignore），
 *   与用户仓库、工作区完全无交集；
 * - 每条 git 命令显式带 --git-dir/--work-tree，子进程环境里的所有 GIT_* 变量一律清空，
 *   杜绝任何一次操作漏进用户仓库；
 * - 每个检查点是一棵独立根提交（commit-tree 不带 -p）+ 独立 ref（refs/checkpoints/<seq>），
 *   不构成提交链：裁剪旧检查点 = 删 ref，不影响其它检查点（空间由 git gc 在宽限期后回收）。
 *
 * 语义与边界（与 Claude Code 同口径）：
 * - 只保护本 agent 自己写入工作区的文件（filesystem MCP / run_script / load_skill 物化）；
 *   run_script 宿主机后端跑出的脚本若逃出沙箱改了外部文件，不在保护范围；
 * - 快照时机在 agent.run 的 onTurnStart 钩子：历史 compact 与后台长期摘要落盘之后、
 *   本轮 user 消息落盘之前 —— 因此「会话恢复到第 N 轮之前」就是把会话文件截断到
 *   第 N 个检查点记录的条数，无歧义、无需捞回；
 * - add -A --force：工作区里 agent 自己写的 .gitignore 不影响快照范围（快照 = 工作区全部），
 *   恢复时的反向删除才能严格对称；
 * - 快照失败只告警不阻塞回合——检查点是安全网，不能变成新的故障面。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** 单个检查点的元信息（随快照写进 commit message，与文件状态原子一致） */
export interface CheckpointInfo {
  /** 序号（同会话内单调递增，6 位零填充作为 ref 名，字典序 = 数值序） */
  seq: number;
  ref: string;
  time: Date;
  /** 触发本轮的用户输入（截断存储，仅作列表展示） */
  input: string;
  /** 快照时会话文件的记录条数（会话回滚 = truncateTo 该值） */
  records: number;
}

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_CAP = 200_000;
const DEFAULT_MAX_CHECKPOINTS = 100;
const REF_PREFIX = "refs/checkpoints/";
const MAX_INPUT_CHARS = 300;

export class CheckpointStore {
  private readonly gitDir: string;
  private readonly maxCheckpoints: number;
  private repoReady = false;

  constructor(options: {
    /** 影子仓库根目录（.git 建在它下面）；建议 <sessionDir>/checkpoints/<sessionId> */
    shadowRoot: string;
    /** 被快照的工作区（MCP_SANDBOX_DIR） */
    sandboxRoot: string;
    /** 快照时读取会话文件记录条数的回调（会话回滚的边界） */
    sessionRecordCount: () => Promise<number>;
    maxCheckpoints?: number;
  }) {
    this.gitDir = path.join(path.resolve(options.shadowRoot), ".git");
    this.sandboxRoot = path.resolve(options.sandboxRoot);
    this.sessionRecordCount = options.sessionRecordCount;
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
  }

  private readonly sandboxRoot: string;
  private readonly sessionRecordCount: () => Promise<number>;

  /**
   * 跑一条影子仓库的 git 命令：显式 --git-dir/--work-tree（不依赖 cwd），子进程环境清空所有
   * GIT_* 变量——这是"绝不碰用户仓库"的硬防线；core.autocrlf=false 保证快照字节与磁盘一致。
   */
  private git(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value;
      }
      const child = spawn(
        "git",
        [
          "--git-dir", this.gitDir,
          "--work-tree", this.sandboxRoot,
          "-c", "core.autocrlf=false",
          "-c", "core.filemode=false",
          "-c", "core.quotepath=off",
          "-c", "commit.gpgsign=false",
          // 裁剪产生的不可达对象交给手动 gc；自动 gc 在回合路径上不可控
          "-c", "gc.auto=0",
          ...args,
        ],
        { env, windowsHide: true }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < GIT_OUTPUT_CAP) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < GIT_OUTPUT_CAP) stderr += chunk;
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  private async ensureRepo(): Promise<void> {
    if (this.repoReady) return;
    await fs.mkdir(path.dirname(this.gitDir), { recursive: true });
    await fs.mkdir(this.sandboxRoot, { recursive: true });
    // git init 幂等：已存在的仓库只是重新初始化提示，不影响对象
    const init = await this.git(["init", "-q"], 15_000);
    if (init.code !== 0) throw new Error(`初始化影子仓库失败: ${init.stderr.trim()}`);
    this.repoReady = true;
  }

  /** 下一个检查点序号：现有 ref 的最大序号 + 1（零填充 6 位，字典序即数值序） */
  private async nextSeq(): Promise<number> {
    const refs = await this.listRefs();
    let max = 0;
    for (const ref of refs) {
      const value = Number.parseInt(ref.slice(REF_PREFIX.length), 10);
      if (Number.isFinite(value) && value > max) max = value;
    }
    return max + 1;
  }

  private async listRefs(): Promise<string[]> {
    const listed = await this.git(["for-each-ref", `--format=%(refname)`, REF_PREFIX]);
    if (listed.code !== 0) throw new Error(`列出检查点失败: ${listed.stderr.trim()}`);
    return listed.stdout.split("\n").filter(Boolean);
  }

  /**
   * 回合开始快照。永不静默失败——错误抛给调用方（agent 的 onTurnStart 包装层负责告警并放行回合）。
   * 文件没变也照常记录：会话回滚需要每个回合都有自己的锚点。
   */
  async snapshot(userInput: string): Promise<void> {
    await this.ensureRepo();
    const add = await this.git(["add", "-A", "--force"], GIT_TIMEOUT_MS);
    if (add.code !== 0) throw new Error(`快照暂存失败: ${add.stderr.trim()}`);
    const tree = await this.git(["write-tree"], 15_000);
    if (tree.code !== 0) throw new Error(`快照建树失败: ${tree.stderr.trim()}`);
    const message = JSON.stringify({ input: userInput.slice(0, MAX_INPUT_CHARS), records: await this.sessionRecordCount() });
    // 独立根提交：不带 -p，每个检查点自成一棵完整树，互不依赖
    const commit = await this.git(
      ["-c", "user.name=agent-checkpoint", "-c", "user.email=checkpoint@localhost", "commit-tree", tree.stdout.trim(), "-m", message],
      15_000
    );
    if (commit.code !== 0) throw new Error(`快照提交失败: ${commit.stderr.trim()}`);
    const seq = await this.nextSeq();
    const ref = `${REF_PREFIX}${String(seq).padStart(6, "0")}`;
    const updated = await this.git(["update-ref", ref, commit.stdout.trim()], 15_000);
    if (updated.code !== 0) throw new Error(`快照登记失败: ${updated.stderr.trim()}`);
    await this.prune().catch((error) => {
      // 裁剪失败不影响本快照的有效性
      console.warn(`⚠️ [检查点] 裁剪旧检查点失败: ${error instanceof Error ? error.message : error}`);
    });
  }

  /** 超过上限时删最老的 ref；ref 删除即检查点消失（对象在宽限期后由 gc 回收） */
  private async prune(): Promise<void> {
    const refs = (await this.listRefs()).sort();
    for (const ref of refs.slice(0, Math.max(0, refs.length - this.maxCheckpoints))) {
      await this.git(["update-ref", "-d", ref], 15_000);
    }
  }

  /** 检查点列表，最新在前；会话从未拍过快照时返回空列表（影子仓库还没建，不算错误） */
  async list(): Promise<CheckpointInfo[]> {
    if (!this.repoReady) return [];
    const listed = await this.git(
      ["for-each-ref", "--format=%(refname)%00%(creatordate:iso-strict)%00%(subject)", REF_PREFIX]
    );
    if (listed.code !== 0) throw new Error(`列出检查点失败: ${listed.stderr.trim()}`);
    const infos: CheckpointInfo[] = [];
    for (const line of listed.stdout.split("\n")) {
      if (!line) continue;
      const [refname, time, subject] = line.split("\0");
      if (!refname?.startsWith(REF_PREFIX)) continue;
      const seq = Number.parseInt(refname.slice(REF_PREFIX.length), 10);
      let meta: { input?: string; records?: number } = {};
      try {
        meta = JSON.parse(subject ?? "{}") as { input?: string; records?: number };
      } catch {
        // 旧格式/手改过的 subject：降级为空展示，快照照常可恢复
      }
      infos.push({
        seq,
        ref: refname,
        time: new Date(time ?? Date.now()),
        input: meta.input ?? "（无输入记录）",
        records: typeof meta.records === "number" ? meta.records : 0,
      });
    }
    return infos.sort((a, b) => b.seq - a.seq);
  }

  /**
   * 把工作区恢复到某个检查点：checkout 目标树的全部文件 + 删除目标树里不存在的多余文件
   * （含清掉随之变空的目录）。symlink 一律按普通文件读内容，不特殊处理。
   */
  async restore(ref: string): Promise<{ restored: number; deleted: number }> {
    if (!this.repoReady) throw new Error("还没有任何检查点可恢复");
    if (!ref.startsWith(REF_PREFIX)) throw new Error(`非法检查点引用: ${ref}`);
    const target = await this.git(["ls-tree", "-r", "--name-only", "-z", ref], 30_000);
    if (target.code !== 0) throw new Error(`读取检查点失败: ${target.stderr.trim()}`);
    // ls-tree 输出与 walkFiles 都用 POSIX 风格相对路径，直接比对；
    // 千万别把任何一边转成 path.sep（Windows 反斜杠），否则子目录文件永远对不上，
    // 恢复时会把自己刚写回的文件当"多余文件"删掉
    const wanted = new Set(target.stdout.split("\0").filter(Boolean));

    // index 先指向目标树，checkout-index 才有东西可写；此后 index = 上次恢复的快照，
    // 下一次快照的 add -A 以它为基线增量比对，语义自洽
    const read = await this.git(["read-tree", ref], 30_000);
    if (read.code !== 0) throw new Error(`恢复暂存失败: ${read.stderr.trim()}`);
    const checkout = await this.git(["checkout-index", "-a", "-f", "--"], 120_000);
    if (checkout.code !== 0) throw new Error(`恢复写回失败: ${checkout.stderr.trim()}`);

    const current = await this.walkFiles(this.sandboxRoot);
    let deleted = 0;
    for (const rel of current) {
      if (wanted.has(rel)) continue;
      await fs.rm(path.join(this.sandboxRoot, rel), { force: true });
      deleted++;
    }
    await this.removeEmptyDirs();

    // checkout-index 写回了目标树全部文件；restored 用树内文件数表达"工作区回到该状态"
    return { restored: wanted.size, deleted };
  }

  /** 递归列出工作区全部文件的 POSIX 相对路径（跳过工作区里万一存在的 .git） */
  private async walkFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const visit = async (rel: string): Promise<void> => {
      const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === ".git") continue;
          await visit(childRel);
        } else if (entry.isFile()) {
          files.push(childRel);
        }
      }
    };
    await visit("");
    return files;
  }

  /** 自底向上删空目录：恢复删除文件后可能留下空壳。rmdir 只删得动空目录，
   *  还有文件的目录自然抛 ENOTEMPTY 被忽略；遍历顺序是父先于子，reverse 后即先子后父 */
  private async removeEmptyDirs(): Promise<void> {
    const dirs: string[] = [];
    const visit = async (rel: string): Promise<void> => {
      const entries = await fs.readdir(path.join(this.sandboxRoot, rel), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".git") continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        dirs.push(childRel);
        await visit(childRel);
      }
    };
    await visit("");
    for (const dir of dirs.reverse()) {
      await fs.rmdir(path.join(this.sandboxRoot, dir)).catch(() => undefined);
    }
  }
}

/**
 * onTurnStart 快照钩子工厂：CLI 与 Web 服务器共用同一份接线（历史 compact 与
 * 后台长期摘要落盘之后、本轮 user 消息落盘之前拍快照）。快照失败只告警不阻塞
 * 回合——检查点是安全网，不能变成新的故障面。
 */
export function createCheckpointSnapshotHook(
  checkpoints: CheckpointStore,
  warn: (message: string) => void = (message) => console.warn(message)
): (userMessage: string) => Promise<void> {
  return async (userMessage: string) => {
    try {
      await checkpoints.snapshot(userMessage);
    } catch (error) {
      warn(`⚠️ [检查点] 快照失败（不影响本回合）: ${error instanceof Error ? error.message : error}`);
    }
  };
}
