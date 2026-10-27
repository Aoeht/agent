// web/src/components/JobsPanel.tsx
/**
 * 后台任务面板：run_script(background:true) 起的脚本在这里看，不用回对话里轮询 job_output。
 *
 * 实时输出靠字节偏移续拉（GET /jobs/:id/log?after=）：运行中每 900ms 取一次增量，
 * 判断"是否结束"以服务端列表为准——结束后再补拉一次收尾，随后停止轮询。
 * 日志只保留最近 MAX_LOG_CHARS 字符，长时间跑批也不会把页面拖垮。
 */
import { useEffect, useRef, useState } from "react";
import type { JobSummaryDTO } from "@protocol";
import { useStore } from "../state/store";

const MAX_LOG_CHARS = 160_000;
const POLL_MS = 900;

const STATUS_LABELS: Record<JobSummaryDTO["status"], string> = {
  running: "运行中",
  exited: "已退出",
  timed_out: "超时终止",
  killed: "已终止",
};

function statusTone(status: JobSummaryDTO["status"]): string {
  if (status === "running") return "bg-clay-100 text-clay-600";
  if (status === "exited") return "bg-sage-100 text-sage-500";
  return "bg-terra-100 text-terra-500";
}

function statusDot(status: JobSummaryDTO["status"]): string {
  if (status === "running") return "bg-clay-500 animate-pulse";
  if (status === "exited") return "bg-sage-500";
  return "bg-terra-500";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m${pad(seconds)}s`;
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`;
}

function elapsedOf(job: JobSummaryDTO, now: number): number {
  return (job.endedAt ?? now) - job.startedAt;
}

function JobRow({
  job,
  selected,
  now,
  onSelect,
}: {
  job: JobSummaryDTO;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2 text-left transition ${
        selected
          ? "border-clay-500/60 bg-cream-50 shadow-sm"
          : "border-transparent hover:border-cream-300 hover:bg-cream-50/70"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot(job.status)}`} />
        <span className="truncate font-mono text-xs text-ink-900">{job.script}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-400">
        <span className="truncate">
          {STATUS_LABELS[job.status]}
          {job.exitCode !== undefined ? ` · 退出码 ${job.exitCode}` : ""}
        </span>
        <span className="shrink-0 font-mono">{formatDuration(elapsedOf(job, now))}</span>
      </div>
    </button>
  );
}

export function JobsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useStore();
  const jobs = state.jobs;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const [log, setLog] = useState("");
  const [follow, setFollow] = useState(true);
  const [logError, setLogError] = useState<string | undefined>(undefined);
  const [killError, setKillError] = useState<string | undefined>(undefined);
  const offsetRef = useRef<number | undefined>(undefined);
  const preRef = useRef<HTMLPreElement | null>(null);

  const selected = jobs.find((job) => job.id === selectedId) ?? null;
  const running = selected?.status === "running";
  const now = Date.now();

  // 打开期间高频刷新列表（状态、退出码、耗时都靠它）；关闭后由 store 的 5s 轮询兜底
  useEffect(() => {
    if (!open) return;
    void actions.refreshJobs().catch(() => {});
    const timer = setInterval(() => {
      void actions.refreshJobs().catch(() => {});
    }, 1_500);
    return () => clearInterval(timer);
  }, [open, actions]);

  // 选中项失效（任务被清理/首次打开）时退到运行中的任务，其次最新的
  useEffect(() => {
    if (!open) return;
    setSelectedId((current) => {
      if (current !== null && jobs.some((job) => job.id === current)) return current;
      return jobs.find((job) => job.status === "running")?.id ?? jobs[0]?.id ?? null;
    });
  }, [open, jobs]);

  // 换任务/换流：清空并从尾部快照开始
  useEffect(() => {
    offsetRef.current = undefined;
    setLog("");
    setFollow(true);
    setLogError(undefined);
    setKillError(undefined);
  }, [open, selectedId, stream]);

  // 增量续拉：运行中按 POLL_MS 轮询，结束后（running→false 再触发一次）收尾即停
  useEffect(() => {
    if (!open || selectedId === null) return;
    let alive = true;
    let busy = false;
    const pull = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const chunk = await actions.readJobLog(selectedId, stream, offsetRef.current);
        if (!alive) return;
        offsetRef.current = chunk.offset;
        setLog((prev) => {
          const next = chunk.reset ? chunk.text : prev + chunk.text;
          return next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next;
        });
        setLogError(undefined);
      } catch (error) {
        if (alive) setLogError(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
      }
    };
    void pull();
    if (!running) return () => { alive = false; };
    const timer = setInterval(() => {
      void pull();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, selectedId, stream, running, actions]);

  // 跟随最新：贴底时输出增长自动滚到底；用户往上翻就暂停跟随
  useEffect(() => {
    const element = preRef.current;
    if (element !== null && follow) element.scrollTop = element.scrollHeight;
  }, [log, follow]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const runningCount = jobs.filter((job) => job.status === "running").length;

  const handleScroll = (): void => {
    const element = preRef.current;
    if (element === null) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    setFollow(atBottom);
  };

  const handleKill = (): void => {
    if (selected === null) return;
    if (!window.confirm(`终止 ${selected.script}？后台进程会被杀掉（docker 后端同时回收容器）。`)) return;
    setKillError(undefined);
    void actions.killJob(selected.id).catch((error) => {
      setKillError(error instanceof Error ? error.message : String(error));
    });
  };

  const tabClass = (active: boolean): string =>
    `rounded-full px-3 py-1 text-xs font-medium transition ${
      active ? "bg-ink-900 text-cream-50" : "text-ink-600 hover:bg-cream-200"
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-label="后台任务"
    >
      <div className="flex h-[min(88vh,900px)] w-[min(1150px,96vw)] flex-col overflow-hidden rounded-2xl border border-cream-300 bg-cream-100 shadow-xl">
        <header className="flex items-center gap-3 border-b border-cream-300 bg-cream-50 px-4 py-3">
          <h2 className="text-sm font-semibold">后台任务</h2>
          <span className="text-xs text-ink-400">
            {runningCount > 0 ? `${runningCount} 个运行中 · 共 ${jobs.length} 个` : `共 ${jobs.length} 个`}
          </span>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-2 py-1 text-sm text-ink-600 transition hover:bg-cream-200"
            title="关闭（Esc）"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-72 shrink-0 space-y-1 overflow-y-auto border-r border-cream-300 bg-cream-200/30 p-2">
            {jobs.length === 0 ? (
              <p className="px-2 py-4 text-xs leading-5 text-ink-400">
                还没有后台任务。让 agent 用 <span className="font-mono">run_script</span>（
                <span className="font-mono">background: true</span>）跑长命令，这里会实时显示输出。
              </p>
            ) : (
              jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  selected={job.id === selectedId}
                  now={now}
                  onSelect={() => setSelectedId(job.id)}
                />
              ))
            )}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            {selected === null ? (
              <p className="text-xs leading-5 text-ink-400">选择左侧任务查看输出。</p>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium">{selected.script}</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusTone(selected.status)}`}>
                      {STATUS_LABELS[selected.status]}
                    </span>
                    {selected.exitCode !== undefined && selected.status !== "running" && (
                      <span className="rounded-full bg-cream-200 px-2.5 py-0.5 text-xs text-ink-600">
                        退出码 {selected.exitCode}
                      </span>
                    )}
                    {selected.reconciled === true && (
                      <span className="text-[11px] text-ink-400">（进程已不在，退出码不可知）</span>
                    )}
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-ink-400" title={selected.id}>
                    {selected.id} · {selected.backend === "docker" ? `docker · ${selected.container ?? "容器"}` : "宿主机"}
                    {selected.args.length > 0 ? ` · 参数 ${selected.args.join(" ")}` : ""} · 开始{" "}
                    {formatClock(selected.startedAt)} · 已运行 {formatDuration(elapsedOf(selected, now))}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-full border border-cream-300 bg-cream-50 p-0.5">
                    <button className={tabClass(stream === "stdout")} onClick={() => setStream("stdout")}>
                      stdout
                    </button>
                    <button className={tabClass(stream === "stderr")} onClick={() => setStream("stderr")}>
                      stderr
                    </button>
                  </div>
                  <button
                    onClick={() => setFollow((value) => !value)}
                    className="rounded-full border border-cream-300 px-3 py-1 text-xs text-ink-600 transition hover:border-clay-500/50 hover:text-ink-900"
                  >
                    {follow ? "● 跟随中" : "暂停跟随 · 跳到最新"}
                  </button>
                  <span className="text-[11px] text-ink-400">
                    {running ? `每 ${POLL_MS}ms 追加新输出` : "输出已结束"}
                  </span>
                  {running && (
                    <button
                      onClick={handleKill}
                      className="ml-auto rounded-full border border-terra-500/40 px-3 py-1 text-xs text-terra-500 transition hover:bg-terra-100"
                    >
                      终止任务
                    </button>
                  )}
                </div>

                {(logError !== undefined || killError !== undefined) && (
                  <p className="rounded-lg bg-terra-100 px-3 py-2 text-xs text-terra-500">
                    {logError ?? killError}
                  </p>
                )}

                <pre
                  ref={preRef}
                  onScroll={handleScroll}
                  className="min-h-0 flex-1 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-xl bg-ink-900 p-3 font-mono text-xs leading-5 text-cream-100"
                >
                  {log !== "" ? log : running ? "等待输出…" : "（无输出）"}
                </pre>
                <p className="text-right text-[11px] text-ink-400">
                  已加载 {log.length.toLocaleString()} 字符（只保留最近 {MAX_LOG_CHARS.toLocaleString()}）
                </p>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
