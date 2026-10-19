// src/server/run_context.ts
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 运行期会话上下文：SessionManager 在每次 agent.run 外面包一层 ALS 作用域，
 * run 内的一切（工具执行、run_script 的 requestHuman 确认）都能拿到自己属于哪个会话。
 *
 * 为什么不用"当前活动会话"单槽位：多会话并行后多个 run 交错挂起，全局槽位必然串话；
 * ALS 跟随异步调用链，天然按 run 隔离。
 *
 * 边界：MCP elicitation 的回调跑在传输层事件循环里、不在 run 的异步链上，ALS 会丢——
 * 那条路由走 UiBridge 的「server 在飞调用 → 会话」映射兜底（见 bridge.ts）。
 */
export const runSessionStore = new AsyncLocalStorage<{ sessionId: string }>();

/** 在指定会话的运行上下文里执行回调（测试与 SessionManager 共用） */
export function inRunSession<T>(sessionId: string, fn: () => T): T {
  return runSessionStore.run({ sessionId }, fn);
}
