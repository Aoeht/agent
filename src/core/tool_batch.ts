// src/core/tool_batch.ts
/**
 * 同批 tool_calls 的调度原语（现代Agent知识框架 4.3）：
 * - 分区：parallelSafe 的进并发道，其余进串行道——混合批次不再"一个不安全整批串行"；
 * - 并发池：信号量式上限，防一批十几个只读调用同时打满外部 API；
 * - 超时：per-tool 死线竞速，挂死的工具不再拖住整个 run。
 *
 * 语义契约（进系统提示，模型可见）：同批调用**可能并发**，互相看不到中间结果；
 * 有依赖的调用必须分轮发出。串行道保证副作用按模型声明顺序发生（不安全工具互不重叠），
 * 但与非安全工具的相对顺序不保证——这是厂商"同批默认并发"语义的延续，不是回归。
 */

export interface ToolCallLike {
  id: string;
  function: { name: string; arguments: string };
}

export interface ToolBatchPartition<T extends ToolCallLike> {
  /** parallelSafe 子集：并发池执行，上限 toolConcurrencyLimit */
  parallel: T[];
  /** 其余子集：按原声明顺序逐个执行，副作用顺序确定 */
  serial: T[];
}

/** 保序分区：每条道内部保持原 tool_calls 顺序（结果装配仍按整批原序，见 agent.ts） */
export function partitionToolCalls<T extends ToolCallLike>(
  calls: T[],
  isSafe: (name: string) => boolean
): ToolBatchPartition<T> {
  const parallel: T[] = [];
  const serial: T[] = [];
  for (const call of calls) (isSafe(call.function.name) ? parallel : serial).push(call);
  return { parallel, serial };
}

/**
 * 上限并发地跑完全部条目，结果按输入下标对齐；单条失败不拖垮其余（allSettled 语义）。
 * 空闲即补位：某条慢不占着坑空等，池始终维持 ≤ limit 个在飞。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** 超时终态：调用方据此转成 error observation（而不是把 run 打死） */
export class ToolTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;
  constructor(toolName: string, timeoutMs: number) {
    super(`工具 ${toolName} 执行超时（>${Math.round(timeoutMs / 1000)}s），本次调用已中止`);
    this.name = "ToolTimeoutError";
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 带死线地跑一次工具执行。派生 per-call AbortSignal：run 级取消与超时都会触发它，
 * 尊重信号的工具能真正停下来。竞速三方：正常完成 / 超时 / 外层取消——
 * 外层取消即使工具无视信号也立刻收敛成 rejected（挂死的工具不能把取消也挂住）。
 *
 * 输掉竞速的执行体继续在后台跑，但其 rejection 一律吞掉（挂 no-op catch）：
 * 超时路径上 registry 随后会把它转成 error JSON，没人再等它——不吞就是 unhandled rejection。
 */
export async function raceWithToolTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  options: { toolName: string; timeoutMs: number; outer?: AbortSignal }
): Promise<T> {
  const { toolName, timeoutMs, outer } = options;
  const controller = new AbortController();
  if (outer?.aborted) {
    controller.abort(outer.reason);
    // 外层已取消：直接收敛，不依赖执行体是否尊重信号
    throw outer.reason instanceof Error ? outer.reason : new Error(String(outer.reason));
  }

  let lose!: (reason: unknown) => void;
  const loser = new Promise<never>((_, reject) => { lose = reject; });
  const timer = setTimeout(() => {
    controller.abort(new ToolTimeoutError(toolName, timeoutMs));
    lose(new ToolTimeoutError(toolName, timeoutMs));
  }, timeoutMs);

  const onOuterAbort = () => {
    controller.abort(outer!.reason);
    lose(outer!.reason);
  };
  if (outer) {
    if (!outer.aborted) outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  const execution = start(controller.signal);
  // 被遗弃路径的 rejection 静默：胜负已定后它的结局与本调用无关
  execution.catch(() => {});
  try {
    return await Promise.race([execution, loser]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
