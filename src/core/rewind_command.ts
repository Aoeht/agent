// src/core/rewind_command.ts
/**
 * /rewind 命令：把工作区文件和/或会话对话回滚到某个回合级检查点。
 * 纯 REPL 交互（需要 ask 通道），放在独立模块与 /model、/prompt 命令同一模式；
 * 真正的快照/恢复逻辑在 checkpoint_store.ts，这里只做列表展示与选择。
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
  ask: (prompt: string) => Promise<string | null>;
  /** 恢复对话前调用的收尾钩子：等在途的后台长期摘要 fold 落盘，
   *  否则它会随后把"被撤销轮次"的摘要追加进截断后的会话文件 */
  settlePending?: () => Promise<void>;
}

export function isRewindCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "/rewind" || normalized === "/回滚";
}

function formatTime(time: Date): string {
  return time.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatLabel(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS)}…` : collapsed || "（空输入）";
}

/** 处理 /rewind；返回是否消费了该输入（调用方据此 continue 主循环） */
export async function handleRewindCommand(input: string, deps: RewindDeps): Promise<boolean> {
  if (!isRewindCommand(input)) return false;

  if (deps.checkpoints === undefined) {
    console.log("⚠️ 检查点未启用（AGENT_CHECKPOINTS=0 关闭了它），/rewind 不可用。");
    return true;
  }

  let checkpoints: Awaited<ReturnType<CheckpointStore["list"]>>;
  try {
    checkpoints = await deps.checkpoints.list();
  } catch (error) {
    console.log(`⚠️ 读取检查点失败: ${error instanceof Error ? error.message : error}`);
    return true;
  }
  if (checkpoints.length === 0) {
    console.log("（还没有检查点：跑完至少一轮对话后再来）");
    return true;
  }

  const shown = checkpoints.slice(0, LIST_LIMIT);
  console.log(`⏪ 检查点（最新在前，共 ${checkpoints.length} 个）——回滚到某项 = 让工作区/对话回到"该轮开始之前"：`);
  shown.forEach((info, index) => {
    console.log(`  ${index + 1}. [${info.seq}] ${formatTime(info.time)}  ${formatLabel(info.input)}`);
  });
  if (checkpoints.length > shown.length) console.log(`  …（其余 ${checkpoints.length - shown.length} 个未显示）`);

  const answer = await deps.ask("回滚到哪个检查点？输入编号（回车取消）：");
  const index = answer ? Number.parseInt(answer.trim(), 10) : Number.NaN;
  const picked = Number.isInteger(index) ? shown[index - 1] : undefined;
  if (!picked) {
    console.log("已取消。");
    return true;
  }

  const scope = ((await deps.ask("恢复范围：c=只恢复代码 / t=只恢复对话 / a=代码+对话（回车默认 a）：")) ?? "a").trim().toLowerCase() || "a";
  if (!["a", "c", "t"].includes(scope)) {
    console.log("未知的恢复范围，已取消。");
    return true;
  }

  try {
    if (deps.settlePending) await deps.settlePending().catch(() => undefined);
    if (scope === "a" || scope === "c") {
      const result = await deps.checkpoints.restore(picked.ref);
      console.log(`⏪ 已恢复工作区：写回 ${result.restored} 个文件，删除 ${result.deleted} 个该时点之后新增的文件。`);
    }
    if (scope === "a" || scope === "t") {
      await deps.sessionStore.truncateTo(picked.records);
      console.log(`⏪ 已恢复对话：会话历史截断到第 ${picked.seq} 号检查点的边界（${picked.records} 条记录），下轮生效。`);
    }
  } catch (error) {
    console.log(`❌ 回滚失败: ${error instanceof Error ? error.message : error}`);
  }
  return true;
}
