// src/core/trace.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentEventBus, AgentEventMap, AgentEventName } from "./events";

const TRACED_EVENTS = ["run_start", "step", "plan_update", "compact", "retry", "run_end"] as const;

/** 提示词指纹：把"这一版规则"变成一个可记进 trace 的稳定标识（sha256 前 12 位） */
export function systemPromptFingerprint(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

/**
 * 运行轨迹落盘：每个事件一行 JSON 追加进 .traces/<label>-<时间>.jsonl。
 * 逐事件 append（而非 run 结束一次性写），进程被杀也不丢已发生的事件；
 * 事后可用于复盘 agent 的每步决策与消耗。
 * token 增量事件不落盘——每个流式 delta 一行会让文件膨胀而信息密度极低，
 * 最终文本已在 step 事件的 llmContent 里。
 */
export class TraceRecorder {
  readonly filePath: string;

  constructor(dir: string, label: string) {
    fs.mkdirSync(dir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_") || "trace";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(dir, `${safeLabel}-${stamp}.jsonl`);
  }

  /** 订阅事件总线；之后所有 run 的事件都写入本记录器的文件 */
  attach(bus: AgentEventBus): void {
    for (const name of TRACED_EVENTS) {
      bus.on(name, (payload) => this.write(name, payload));
    }
  }

  private write<E extends AgentEventName>(type: E, payload: AgentEventMap[E]): void {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload });
      fs.appendFileSync(this.filePath, `${line}\n`, "utf-8");
    } catch (error) {
      console.warn("[Trace] 写入失败:", error instanceof Error ? error.message : error);
    }
  }
}
