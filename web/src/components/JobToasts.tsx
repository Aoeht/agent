// web/src/components/JobToasts.tsx
/**
 * 后台任务完成通知：job_finished 由服务器**广播**到所有已连接的会话——
 * 任务在 A 会话起、人正待在 B 会话时也能收到这张卡片，点"去会话"跳回发起它的对话。
 * 12s 自动消失；"查看任务"直接打开 🖥️ 后台任务面板。
 */
import { useEffect } from "react";
import type { JobSummaryDTO } from "@protocol";

const AUTO_DISMISS_MS = 12_000;

function statusText(job: JobSummaryDTO): string {
  if (job.status === "exited") {
    return job.exitCode === undefined || job.exitCode === 0 ? "已完成" : `失败（退出码 ${job.exitCode}）`;
  }
  if (job.status === "timed_out") return "已超时终止";
  if (job.status === "killed") return "已终止";
  return "运行中";
}

function successOf(job: JobSummaryDTO): boolean {
  return job.status === "exited" && (job.exitCode === undefined || job.exitCode === 0);
}

function dotClass(job: JobSummaryDTO): string {
  if (job.status === "running") return "bg-clay-500 animate-pulse";
  return successOf(job) ? "bg-sage-500" : "bg-terra-500";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${pad(seconds)}s`;
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`;
}

function Toast({
  job,
  sessionLabel,
  onDismiss,
  onOpenJobs,
  onOpenSession,
}: {
  job: JobSummaryDTO;
  sessionLabel?: string | undefined;
  onDismiss: () => void;
  onOpenJobs: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  // 只按通知 id 起计时：onDismiss 每次渲染都是新闭包，放进依赖会让自动消失被无限推迟
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [job.id]);

  const elapsed = (job.endedAt ?? job.startedAt) - job.startedAt;
  const origin = job.sessionId !== undefined && sessionLabel !== undefined ? ` · ${sessionLabel}` : "";
  const args = job.args.length > 0 ? ` ${job.args.join(" ")}` : "";

  return (
    <div
      role="status"
      className="pointer-events-auto rounded-xl border border-cream-300 bg-cream-50 p-3 shadow-lg"
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClass(job)}`} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink-900">后台任务{statusText(job)}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-600" title={`${job.script}${args}`}>
            {job.script}
            {args}
          </p>
          <p className="mt-1 text-[11px] text-ink-400">
            {formatDuration(elapsed)} · {job.backend === "docker" ? "容器" : "宿主机"}
            {origin}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => {
                onOpenJobs();
                onDismiss();
              }}
              className="rounded-lg bg-ink-900 px-2 py-1 text-[11px] text-cream-50 transition hover:bg-ink-800"
            >
              查看任务
            </button>
            {job.sessionId !== undefined && (
              <button
                onClick={() => {
                  onOpenSession(job.sessionId!);
                  onDismiss();
                }}
                className="rounded-lg border border-cream-300 px-2 py-1 text-[11px] text-ink-600 transition hover:bg-cream-200"
              >
                去会话
              </button>
            )}
            <button
              onClick={onDismiss}
              title="关闭通知"
              className="ml-auto rounded px-1 text-xs text-ink-400 transition hover:text-ink-600"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function JobToasts({
  notices,
  sessionLabel,
  onDismiss,
  onOpenJobs,
  onOpenSession,
}: {
  notices: JobSummaryDTO[];
  sessionLabel?: (sessionId: string) => string | undefined;
  onDismiss: (id: string) => void;
  onOpenJobs: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {notices.map((job) => (
        <Toast
          key={job.id}
          job={job}
          sessionLabel={job.sessionId === undefined ? undefined : sessionLabel?.(job.sessionId)}
          onDismiss={() => onDismiss(job.id)}
          onOpenJobs={onOpenJobs}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}
