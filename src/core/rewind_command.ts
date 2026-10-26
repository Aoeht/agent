// src/core/rewind_command.ts
/**
 * /rewind 命令：把工作区文件和/或会话对话回滚到某个回合级检查点。
 * 放在独立模块与 /model、/prompt 命令同一模式；真正的快照/恢复逻辑在
 * checkpoint_store.ts，这里只做列表展示、选择与执行。
 *
 * 两种形态（REPL 与 Web 共享同一条语义）：
 * - 序号式 `/rewind <编号> [c|t|a]`：非交互，一步执行，命令通道两端通用；
 * - 裸 `/rewind`：有 ask 通道（REPL）走两步交互问答；没有（Web/管道）只列
 *   清单并提示序号式用法——命令输出是一次性 UI 态，不适合在聊天里挂起等待。
 *
 * 恢复语义与 Claude Code 对齐：
 * - 只恢复代码：checkout 该检查点的工作区快照，会话历史不动（下轮模型带着"改完又手动还原"的记忆继续）；
 * - 只恢复对话：会话文件截断到该检查点记录的条数（即本轮 user 消息落盘之前的边界），工作区不动；
 * - 都恢复（默认）：两者同时执行，等价于"这一轮从未发生过"。
 */
import { CheckpointStore } from "./checkpoint_store";
import { SessionStore } from "./session_store";

const LIST_LIMIT = 15;
const MAX_LABEL_CHARS = 40;

export interface RewindDeps {
  /** 检查点未启用（AGENT_CHECKPOINTS=0 或快照层初始化失败）时为 undefined */
  checkpoints?: CheckpointStore | undefined;
  sessionStore: SessionStore;
  /** REPL 交互通道；缺省（Web/管道）时裸 /rewind 只列清单并提示序号式用法 */
  ask?: (prompt: string) => Promise<string | null>;
  /** 恢复对话前调用的收尾钩子：等在途的后台长期摘要 fold 落盘，
   *  否则它会随后把"被撤销轮次"的摘要追加进截断后的会话文件 */
  settlePending?: () => Promise<void>;
  /** 输出通道；缺省 console.log（保留旧调用方行为） */
  out?: (line: string) => void;
}

export interface RewindCommandResult {
  /** 输入是否被 /rewind 认领（调用方据此 continue 主循环） */
  consumed: boolean;
  /** 是否真的执行了回滚（调用方据此刷新历史显示等） */
  executed?: boolean;
}

export function isRewindCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return (
    normalized === "/rewind" ||
    normalized.startsWith("/rewind ") ||
    normalized === "/回滚" ||
    normalized.startsWith("/回滚 ")
  );
}

function formatTime(time: Date): string {
  return time.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatLabel(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS)}…` : collapsed || "（空输入）";
}

/** 处理 /rewind；返回 consumed 与是否执行了回滚 */
export async function handleRewindCommand(input: string, deps: RewindDeps): Promise<RewindCommandResult> {
  if (!isRewindCommand(input)) return { consumed: false };
  const out = deps.out ?? ((line: string) => console.log(line));

  if (deps.checkpoints === undefined) {
    out("⚠️ 检查点未启用（AGENT_CHECKPOINTS=0 关闭了它），/rewind 不可用。");
    return { consumed: true };
  }

  let checkpoints: Awaited<ReturnType<CheckpointStore["list"]>>;
  try {
    checkpoints = await deps.checkpoints.list();
  } catch (error) {
    out(`⚠️ 读取检查点失败: ${error instanceof Error ? error.message : error}`);
    return { consumed: true };
  }
  if (checkpoints.length === 0) {
    out("（还没有检查点：跑完至少一轮对话后再来）");
    return { consumed: true };
  }

  const shown = checkpoints.slice(0, LIST_LIMIT);
  printCheckpointList(out, shown, checkpoints.length);

  // 序号式参数：/rewind <编号> [c|t|a] —— 非交互一步执行
  const rest = input.trim().toLowerCase().replace(/^\/(rewind|回滚)\s*/, "").trim();
  const argsMatch = /^(\d+)(?:\s+([act]))?$/.exec(rest);
  if (argsMatch) {
    const picked = shown[Number.parseInt(argsMatch[1] ?? "", 10) - 1];
    if (!picked) {
      out(`❌ 编号超出范围（1-${shown.length}），未执行。`);
      return { consumed: true };
    }
    const scope = argsMatch[2] ?? "a";
    const executed = await executeRewind(picked, scope, deps, out);
    return { consumed: true, ...(executed ? { executed: true } : {}) };
  }
  if (rest !== "") {
    out(`❌ 用法: /rewind <编号> [c|t|a]（c=只代码 t=只对话 a=全部，缺省 a）`);
    return { consumed: true };
  }

  // 裸 /rewind：有 ask 通道走两步交互；没有则提示序号式用法
  if (deps.ask === undefined) {
    out(`提示: 输入 /rewind <编号> [c|t|a] 执行回滚（c=只代码 t=只对话 a=全部，缺省 a）。`);
    return { consumed: true };
  }

  const answer = await deps.ask("回滚到哪个检查点？输入编号（回车取消）：");
  const index = answer ? Number.parseInt(answer.trim(), 10) : Number.NaN;
  const picked = Number.isInteger(index) ? shown[index - 1] : undefined;
  if (!picked) {
    out("已取消。");
    return { consumed: true };
  }

  const scopeAnswer = ((await deps.ask("恢复范围：c=只恢复代码 / t=只恢复对话 / a=代码+对话（回车默认 a）：")) ?? "a").trim().toLowerCase() || "a";
  if (!["a", "c", "t"].includes(scopeAnswer)) {
    out("未知的恢复范围，已取消。");
    return { consumed: true };
  }
  const executed = await executeRewind(picked, scopeAnswer, deps, out);
  return { consumed: true, ...(executed ? { executed: true } : {}) };
}

function printCheckpointList(
  out: (line: string) => void,
  shown: Awaited<ReturnType<CheckpointStore["list"]>>,
  total: number
): void {
  out(`⏪ 检查点（最新在前，共 ${total} 个）——回滚到某项 = 让工作区/对话回到"该轮开始之前"：`);
  shown.forEach((info, index) => {
    out(`  ${index + 1}. [${info.seq}] ${formatTime(info.time)}  ${formatLabel(info.input)}`);
  });
  if (total > shown.length) out(`  …（其余 ${total - shown.length} 个未显示）`);
}

/** 执行恢复；成功返回 true（调用方据此决定是否刷新历史显示） */
async function executeRewind(
  picked: Awaited<ReturnType<CheckpointStore["list"]>>[number],
  scope: string,
  deps: RewindDeps,
  out: (line: string) => void
): Promise<boolean> {
  const checkpoints = deps.checkpoints;
  if (checkpoints === undefined) return false;
  try {
    if (deps.settlePending) await deps.settlePending().catch(() => undefined);
    if (scope === "a" || scope === "c") {
      const result = await checkpoints.restore(picked.ref);
      out(`⏪ 已恢复工作区：写回 ${result.restored} 个文件，删除 ${result.deleted} 个该时点之后新增的文件。`);
    }
    if (scope === "a" || scope === "t") {
      await deps.sessionStore.truncateTo(picked.records);
      out(`⏪ 已恢复对话：会话历史截断到第 ${picked.seq} 号检查点的边界（${picked.records} 条记录），下轮生效。`);
    }
    return true;
  } catch (error) {
    out(`❌ 回滚失败: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
