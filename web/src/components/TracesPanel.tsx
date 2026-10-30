// web/src/components/TracesPanel.tsx
/**
 * 运行轨迹面板（🕘）：把 .traces/<sessionId>-*.jsonl 变成可读的时间轴。
 *
 * - 列表来自 GET /sessions/:id/traces（同一会话跨服务器重启会有多个文件，最新在前）；
 * - 正文按字节偏移续读（GET /sessions/:id/traces/:file?after=），打开期间每 2s 追一次，
 *   长回合跑到一半也能看到最新事件；服务端已按事件截断超长字段；
 * - 只读：这里不触发任何回合，也不改工作区。
 * 默认隐藏 tool_progress 心跳（一秒一条，会把时间轴冲垮），可一键显示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TraceEventDTO, TraceFileSummaryDTO } from "@protocol";
import { useStore } from "../state/store";

const POLL_MS = 2_000;
const LIST_POLL_MS = 5_000;
/** 客户端最多保留的事件条数：超长轨迹只留最近一段，避免 DOM 无限增长 */
const MAX_KEPT_EVENTS = 5_000;
const SUMMARY_CLIP = 120;

type Tone = "run" | "tool" | "step" | "warn" | "plan" | "misc";

const TONE_CLASS: Record<Tone, string> = {
  run: "bg-clay-100 text-clay-600",
  tool: "bg-sage-100 text-sage-500",
  step: "bg-cream-200 text-ink-600",
  warn: "bg-terra-100 text-terra-500",
  plan: "bg-cream-200 text-ink-600",
  misc: "bg-cream-200 text-ink-400",
};

const TYPE_LABEL: Record<string, string> = {
  run_start: "开始",
  run_end: "结束",
  step: "步骤",
  tool_start: "工具",
  tool_end: "工具",
  tool_progress: "心跳",
  compact: "压缩",
  retry: "重试",
  plan_update: "计划",
  oversize: "跳过",
};

function toneOf(type: string): Tone {
  if (type === "run_start" || type === "run_end") return "run";
  if (type === "tool_start" || type === "tool_end" || type === "tool_progress") return "tool";
  if (type === "step") return "step";
  if (type === "compact" || type === "retry" || type === "oversize") return "warn";
  if (type === "plan_update") return "plan";
  return "misc";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clip(value: string, max = SUMMARY_CLIP): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatFileTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${pad(Math.floor(seconds % 60))}s`;
}

function formatDelta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** 一行摘要：只读展示，不参与逻辑；未知类型退化为 JSON 片段 */
function summarize(event: TraceEventDTO): string {
  const data = event.data;
  switch (event.type) {
    case "run_start": {
      const hash = textOf(data["promptHash"]);
      const input = textOf(data["userMessage"]) ?? "";
      return `${clip(input) || "（空输入）"}${hash !== undefined ? ` · 提示词 ${hash}` : ""}`;
    }
    case "step": {
      const step = asRecord(data["step"]);
      const tokens = asRecord(step?.["tokens"]);
      const calls = Array.isArray(step?.["toolCalls"]) ? step["toolCalls"] : [];
      const names = calls
        .map((call) => textOf(asRecord(call)?.["name"]))
        .filter((name): name is string => name !== undefined)
        .join(", ");
      const prompt = numberOf(tokens?.["promptTokens"]) ?? 0;
      const completion = numberOf(tokens?.["completionTokens"]) ?? 0;
      return `第 ${numberOf(step?.["iteration"]) ?? "?"} 步 · prompt ${prompt} / 输出 ${completion} tokens${names !== "" ? ` · ${names}` : ""}`;
    }
    case "tool_start": {
      const args = textOf(data["arguments"]);
      return `${textOf(data["name"]) ?? "工具"}${args !== undefined && args.trim() !== "" ? ` · ${clip(args, 80)}` : ""}`;
    }
    case "tool_progress": {
      const elapsed = numberOf(data["elapsedMs"]) ?? 0;
      return `${textOf(data["name"]) ?? "工具"} · 已运行 ${(elapsed / 1000).toFixed(1)}s`;
    }
    case "tool_end": {
      const duration = numberOf(data["durationMs"]) ?? 0;
      return `${textOf(data["name"]) ?? "工具"} · ${(duration / 1000).toFixed(1)}s · ${data["ok"] === true ? "成功" : "失败"}`;
    }
    case "compact": {
      const tokens = numberOf(data["tokens"]);
      const detail = textOf(data["detail"]);
      const messages = numberOf(data["messages"]);
      return [
        textOf(data["action"]) ?? "压缩",
        tokens !== undefined ? `省 ~${tokens} tokens` : undefined,
        messages !== undefined ? `${messages} 条消息` : undefined,
        detail !== undefined ? clip(detail, 80) : undefined,
      ].filter((part): part is string => part !== undefined).join(" · ");
    }
    case "retry": {
      const delay = numberOf(data["delayMs"]) ?? 0;
      return `第 ${numberOf(data["attempt"]) ?? "?"} 次重试（${delay}ms 后）· ${textOf(data["reason"]) ?? ""}`;
    }
    case "plan_update": {
      const steps = Array.isArray(data["steps"]) ? data["steps"] : [];
      const done = steps.filter((step) => asRecord(step)?.["status"] === "completed").length;
      return `${steps.length} 步 · ${done} 步已完成`;
    }
    case "run_end": {
      const success = data["success"] === true;
      const stop = textOf(data["stopReason"]);
      const iterations = numberOf(data["iterations"]) ?? 0;
      const tools = numberOf(data["toolCallsCount"]) ?? 0;
      const tokens = numberOf(data["totalTokens"]) ?? 0;
      return `${success ? "✓ 完成" : `✗ ${stop ?? "未完成"}`} · ${iterations} 次迭代 · ${tools} 次工具调用 · ${tokens} tokens`;
    }
    default: {
      const json = JSON.stringify(data);
      return clip(json === "{}" ? "（无载荷）" : json);
    }
  }
}

export function TracesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, actions } = useStore();
  const sessionId = state.currentId;
  const [files, setFiles] = useState<TraceFileSummaryDTO[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEventDTO[]>([]);
  const [size, setSize] = useState(0);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showHeartbeats, setShowHeartbeats] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>());
  // 字节偏移与请求序号都放 ref：轮询/切文件时不能因闭包拿到旧值
  const offsetRef = useRef(0);
  const seqRef = useRef(0);
  const tailingRef = useRef(false);
  /** 整篇读取进行中：续拉要等它读完，否则两边各读一段会重复追加 */
  const loadingRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const reloadFiles = useCallback(
    async (selectLatest: boolean): Promise<void> => {
      if (!sessionId) return;
      try {
        const list = await actions.listTraces(sessionId);
        setFiles(list.traces);
        setError(undefined);
        setSelected((prev) => {
          if (selectLatest || prev === null) return list.traces[0]?.file ?? null;
          return list.traces.some((item) => item.file === prev) ? prev : list.traces[0]?.file ?? null;
        });
      } catch (loadError) {
        setError(messageOf(loadError));
      }
    },
    [sessionId, actions]
  );

  // 打开（或切会话）时重置本地状态并拉清单，默认选最新的一份
  useEffect(() => {
    if (!open) return;
    setFiles(null);
    setSelected(null);
    setEvents([]);
    setSize(0);
    setLoadedBytes(0);
    setError(undefined);
    setExpanded(new Set());
    setFollow(true);
    setShowHeartbeats(false);
    offsetRef.current = 0;
    seqRef.current += 1; // 作废在途请求
    loadingRef.current = false;
    void reloadFiles(true);
  }, [open, sessionId, reloadFiles]);

  // 选中文件变化：整篇读完（服务端分块，循环拉到文件尾）
  useEffect(() => {
    if (!open || sessionId === null || selected === null) return;
    const seq = ++seqRef.current;
    offsetRef.current = 0;
    setEvents([]);
    setExpanded(new Set<number>());
    setError(undefined);
    setLoading(true);
    loadingRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        for (let guard = 0; guard < 400; guard++) {
          const chunk = await actions.readTrace(sessionId, selected, offsetRef.current);
          if (cancelled || seq !== seqRef.current) return;
          const before = offsetRef.current;
          offsetRef.current = chunk.offset;
          setSize(chunk.size);
          setLoadedBytes(chunk.offset);
          if (chunk.events.length > 0) {
            setEvents((prev) => {
              const next = [...prev, ...chunk.events];
              return next.length > MAX_KEPT_EVENTS ? next.slice(next.length - MAX_KEPT_EVENTS) : next;
            });
          }
          if (chunk.offset <= before || chunk.offset >= chunk.size) break;
        }
      } catch (readError) {
        if (!cancelled && seq === seqRef.current) setError(messageOf(readError));
      } finally {
        if (!cancelled && seq === seqRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, selected, actions]);

  // 打开期间：清单 5s 刷一次（新回合/重启会落新文件），当前文件 2s 续拉一次
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void reloadFiles(false), LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [open, reloadFiles]);

  useEffect(() => {
    if (!open || sessionId === null || selected === null) return;
    let alive = true;
    const timer = setInterval(() => {
      if (tailingRef.current || loadingRef.current) return;
      tailingRef.current = true;
      const seq = seqRef.current;
      void actions
        .readTrace(sessionId, selected, offsetRef.current)
        .then((chunk) => {
          if (!alive || seq !== seqRef.current) return;
          offsetRef.current = chunk.offset;
          setSize(chunk.size);
          setLoadedBytes(chunk.offset);
          if (chunk.events.length > 0) {
            setEvents((prev) => {
              const next = chunk.reset ? chunk.events : [...prev, ...chunk.events];
              return next.length > MAX_KEPT_EVENTS ? next.slice(next.length - MAX_KEPT_EVENTS) : next;
            });
          }
        })
        .catch((readError) => {
          if (alive && seq === seqRef.current) setError(messageOf(readError));
        })
        .finally(() => {
          tailingRef.current = false;
        });
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, sessionId, selected, actions]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const visible = useMemo(
    () => (showHeartbeats ? events : events.filter((event) => event.type !== "tool_progress")),
    [events, showHeartbeats]
  );

  const stats = useMemo(() => {
    let runs = 0;
    let tools = 0;
    let tokens = 0;
    let heartbeats = 0;
    for (const event of events) {
      if (event.type === "run_start") runs++;
      else if (event.type === "tool_start") tools++;
      else if (event.type === "tool_progress") heartbeats++;
      else if (event.type === "run_end") tokens += numberOf(event.data["totalTokens"]) ?? 0;
    }
    const first = events[0]?.ts;
    const last = events[events.length - 1]?.ts;
    const span = first !== undefined && last !== undefined ? Date.parse(last) - Date.parse(first) : 0;
    return { runs, tools, tokens, heartbeats, span };
  }, [events]);

  // 跟随最新：贴底时新事件自动滚到底；用户往上翻就暂停跟随
  useEffect(() => {
    const element = listRef.current;
    if (element !== null && follow) element.scrollTop = element.scrollHeight;
  }, [visible.length, follow, selected]);

  if (!open) return null;

  const list = files ?? [];
  const picked = list.find((item) => item.file === selected) ?? null;
  const busy = currentBusy(state.byId[sessionId ?? ""]?.status);

  const toggleExpanded = (index: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleScroll = (): void => {
    const element = listRef.current;
    if (element === null) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 24);
  };

  const actionBtn =
    "rounded-full border border-cream-300 px-3 py-1 text-xs text-ink-600 transition hover:border-clay-500/60 hover:text-ink-900";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-label="运行轨迹"
    >
      <div className="flex h-[min(88vh,900px)] w-[min(1150px,96vw)] flex-col overflow-hidden rounded-2xl border border-cream-300 bg-cream-100 shadow-xl">
        <header className="flex items-center gap-3 border-b border-cream-300 bg-cream-50 px-4 py-3">
          <h2 className="text-sm font-semibold">🕘 运行轨迹</h2>
          <span className="text-xs text-ink-400">
            {sessionId === null
              ? "先选一个会话"
              : files === null
                ? "读取中…"
                : `共 ${list.length} 个轨迹文件${busy ? " · 回合进行中（每 2s 续拉）" : ""}`}
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
            {files !== null && list.length === 0 ? (
              <p className="px-2 py-4 text-xs leading-5 text-ink-400">
                这个会话还没有轨迹。跑一轮对话后会生成{" "}
                <span className="font-mono">.traces/&lt;会话&gt;-&lt;时间&gt;.jsonl</span>。
              </p>
            ) : (
              list.map((item) => {
                const active = item.file === selected;
                return (
                  <button
                    key={item.file}
                    onClick={() => setSelected(item.file)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                      active
                        ? "border-clay-500/60 bg-cream-50 shadow-sm"
                        : "border-transparent hover:border-cream-300 hover:bg-cream-50/70"
                    }`}
                  >
                    <div className="truncate text-xs text-ink-900">{item.label ?? item.file}</div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-400">
                      <span className="truncate font-mono">{formatFileTime(item.modified)}</span>
                      <span className="shrink-0 font-mono">{formatBytes(item.sizeBytes)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </aside>

          <main className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            {picked === null ? (
              <p className="text-xs leading-5 text-ink-400">选择左侧轨迹文件查看时间轴。</p>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-xs font-medium text-ink-900">{picked.label ?? "轨迹"}</span>
                    <span className="rounded-full bg-cream-200 px-2.5 py-0.5 font-mono text-[11px] text-ink-600">
                      {stats.runs} 回合 · {stats.tools} 工具调用 · {formatSpan(stats.span)}
                    </span>
                    {stats.tokens > 0 && (
                      <span className="rounded-full bg-cream-200 px-2.5 py-0.5 font-mono text-[11px] text-ink-600">
                        {stats.tokens.toLocaleString()} tokens
                      </span>
                    )}
                    {loading && <span className="text-[11px] text-ink-400">读取中…</span>}
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-ink-400" title={picked.file}>
                    {picked.file} · {visible.length} 条事件
                    {events.length > visible.length ? `（隐藏 ${events.length - visible.length} 条心跳）` : ""} · 已读{" "}
                    {formatBytes(loadedBytes)} / {formatBytes(size)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => setFollow((value) => !value)} className={actionBtn}>
                    {follow ? "● 跟随中" : "暂停跟随 · 跳到最新"}
                  </button>
                  <button onClick={() => setShowHeartbeats((value) => !value)} className={actionBtn}>
                    {showHeartbeats ? "隐藏心跳" : `显示心跳（${stats.heartbeats}）`}
                  </button>
                  <button onClick={() => void reloadFiles(false)} className={actionBtn}>
                    刷新文件
                  </button>
                  <span className="text-[11px] text-ink-400">每 {POLL_MS}ms 追加新事件</span>
                </div>

                {error !== undefined && (
                  <p className="rounded-lg bg-terra-100 px-3 py-2 text-xs text-terra-500">{error}</p>
                )}

                <div
                  ref={listRef}
                  onScroll={handleScroll}
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-cream-300 bg-cream-50 p-1"
                >
                  {visible.length === 0 ? (
                    <p className="px-3 py-6 text-xs leading-5 text-ink-400">
                      {loading ? "读取轨迹…" : events.length > 0 ? "只隐藏了心跳：需要的话点上方「显示心跳」。" : "这个文件还没有事件。"}
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {visible.map((event, index) => {
                        const previous = index > 0 ? visible[index - 1] : undefined;
                        const delta = previous !== undefined ? Date.parse(event.ts) - Date.parse(previous.ts) : Number.NaN;
                        const open = expanded.has(index);
                        const tone = toneOf(event.type);
                        return (
                          <li key={index}>
                            <button
                              onClick={() => toggleExpanded(index)}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition hover:bg-cream-200/70"
                            >
                              <span className="shrink-0 font-mono text-[10px] text-ink-400">{formatClock(event.ts)}</span>
                              <span className="w-12 shrink-0 text-right font-mono text-[10px] text-ink-400">
                                {formatDelta(delta)}
                              </span>
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ${TONE_CLASS[tone]}`}
                              >
                                {TYPE_LABEL[event.type] ?? event.type}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-xs text-ink-900">{summarize(event)}</span>
                              {event.truncated === true && (
                                <span className="shrink-0 rounded-full bg-cream-200 px-2 py-0.5 text-[10px] text-ink-400">
                                  已截断
                                </span>
                              )}
                            </button>
                            {open && (
                              <pre className="mx-2 mb-1 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-ink-900 px-3 py-2 font-mono text-[11px] leading-5 text-cream-100">
                                {JSON.stringify({ ts: event.ts, type: event.type, ...event.data }, null, 2)}
                              </pre>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </main>
        </div>

        <footer className="space-y-1 border-t border-cream-300 bg-cream-50 px-4 py-3">
          <p className="text-[11px] text-ink-400">
            轨迹是每事件一行的 JSONL（run/step/工具/压缩/重试），不记录 token 增量；超长字段（工具输出、方案快照）已截断显示，
            完整内容在 <span className="font-mono">.traces/</span> 里。
          </p>
          <p className="text-[11px] text-ink-400">
            只含本会话主 Agent 的轨迹；委派（<span className="font-mono">.agent-sessions/delegates</span>）与团队
            （<span className="font-mono">teams/&lt;runId&gt;/traces</span>）的子 Agent 轨迹各自落盘。
          </p>
        </footer>
      </div>
    </div>
  );
}

/** 回合进行中（含排队/等待审批）：只用于头部提示，不影响读取 */
function currentBusy(status: string | undefined): boolean {
  return status !== undefined && status !== "idle";
}
