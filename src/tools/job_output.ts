// src/tools/job_output.ts
/**
 * 后台任务的查看面：run_script 的 background 分支返回 job_id 后，模型（或用户让模型）
 * 用这个工具轮询状态与日志尾部。只读：不改任务、不发新命令。
 *
 * 唯一的副作用是到点回收——读取时若发现已过截止时间仍在跑，JobStore 会杀掉它并标
 * timed_out。这是后台任务自己的超时语义，不是对用户世界的额外改动，所以
 * needsReconciliation 保持 false，不打扰人工核对。
 */
import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";
import type { JobRecord, JobStore } from "../core/job_store";
import { MAX_STREAM_CHARS } from "./sandbox_docker";

const DEFAULT_TAIL_CHARS = 4_000;

function summarize(record: JobRecord, now: number) {
  return {
    job_id: record.id,
    status: record.status,
    script: record.script,
    backend: record.backend,
    elapsed_ms: Math.max(0, (record.endedAt ?? now) - record.startedAt),
    ...(record.exitCode !== undefined ? { exit_code: record.exitCode } : {}),
    started_at: new Date(record.startedAt).toISOString(),
    ...(record.reconciled === true
      ? { note: "登记它的 agent 进程已退出，进程状态按 pid 存活校正；真实退出码不可知" }
      : {}),
  };
}

export function createJobOutputTool(jobs: JobStore): ToolDefinition {
  return defineTool({
    name: "job_output",
    description:
      "查看 run_script 后台任务（background:true）的进度。" +
      "不给 job_id 时列出最近的后台任务；给了 job_id 时返回状态、退出码、已运行时长与 stdout/stderr 的尾部。" +
      "日志只返回尾部若干字符；完整内容按返回的日志路径用 filesystem 读取。仍在运行就稍后再查一次。",
    schema: z.object({
      job_id: z.string().trim().min(1).optional().describe("run_script 返回的 job_id；省略时列出最近的后台任务"),
      tail: z
        .number()
        .int()
        .min(200)
        .max(MAX_STREAM_CHARS)
        .optional()
        .describe(`stdout/stderr 各自返回的尾部字符数（默认 ${DEFAULT_TAIL_CHARS}，上限 ${MAX_STREAM_CHARS}）`),
    }),
    parallelSafe: true,
    needsReconciliation: false,
    execute: async (params) => {
      const now = Date.now();
      if (params.job_id === undefined) {
        const records = await jobs.list(20);
        return {
          job_dir: jobs.dir,
          jobs: records.map((record) => summarize(record, now)),
          ...(records.length === 0 ? { hint: "还没有后台任务：用 run_script 的 background:true 启动一个" } : {}),
        };
      }
      const record = await jobs.get(params.job_id);
      if (record === undefined) {
        throw new Error(`未找到后台任务 ${params.job_id}：省略 job_id 可列出最近的任务`);
      }
      const tailChars = params.tail ?? DEFAULT_TAIL_CHARS;
      const logs = await jobs.logs(record.id, tailChars);
      const paths = jobs.paths(record.id);
      return {
        ...summarize(record, now),
        ...(record.args.length > 0 ? { args: record.args } : {}),
        timeout_ms: record.deadlineAt - record.startedAt,
        stdout_tail: logs.stdout,
        stderr_tail: logs.stderr,
        stdout_bytes: logs.stdoutBytes,
        stderr_bytes: logs.stderrBytes,
        stdout_log: paths.stdout,
        stderr_log: paths.stderr,
        ...(record.status === "running"
          ? { hint: "仍在运行：稍后再查一次；到超时时间会被强制终止并标记 timed_out" }
          : {}),
      };
    },
  });
}
