// web/src/components/CheckpointsPanel.tsx
/**
 * 检查点面板：把聊天里的 /rewind 做成可视化操作。
 *
 * 列表来自 GET /sessions/:id/checkpoints（与 /rewind 的清单同源，最新在前），
 * 选中一项后按范围回滚——代码 / 对话 / 两者，三种语义与命令通道完全一致
 * （服务端复用 rewind_command 的同一段执行逻辑，这里只做展示与确认）。
 * 回合进行中不允许回滚（与 /rewind 同一把门），按钮置灰并提示原因。
 */
import { useCallback, useEffect, useState } from "react";
import type { CheckpointListDTO, RewindScope } from "@protocol";
import { useStore } from "../state/store";

const MAX_LABEL_CHARS = 80;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function formatLabel(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LABEL_CHARS ? `${collapsed.slice(0, MAX_LABEL_CHARS)}…` : collapsed || "（空输入）";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CheckpointsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, current, actions } = useStore();
  const sessionId = state.currentId;
  const [data, setData] = useState<CheckpointListDTO | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<RewindScope | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const next = await actions.listCheckpoints(sessionId);
      setData(next);
      setError(undefined);
      setSelectedSeq((prev) => (next.checkpoints.some((info) => info.seq === prev) ? prev : next.checkpoints[0]?.seq ?? null));
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [sessionId, actions]);

  // 打开时重置面板状态并拉最新清单；关掉就丢弃（清单不做全局缓存，打开即读磁盘）
  useEffect(() => {
    if (!open) return;
    setData(null);
    setSelectedSeq(null);
    setLines([]);
    setError(undefined);
    setPending(null);
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const running = current !== null && current.status !== "idle";
  const checkpoints = data?.checkpoints ?? [];
  const selected = checkpoints.find((info) => info.seq === selectedSeq) ?? null;
  const disabled = data !== null && !data.enabled;
  const canRewind = !running && !disabled && selected !== null && pending === null;

  const rewind = async (scope: RewindScope): Promise<void> => {
    if (selected === null) return;
    const scopeLabel =
      scope === "code" ? "只恢复代码（保留对话历史）"
        : scope === "chat" ? "只恢复对话（保留工作区文件）"
          : "同时恢复代码与对话";
    const consequence = scope === "code"
      ? "会用该时点的工作区快照覆盖文件，并删除之后新增的文件。"
      : scope === "chat"
        ? "会截断会话历史（下一轮生效），工作区文件不动。"
        : "会用该时点的工作区快照覆盖文件并删除之后新增的文件，同时截断会话历史（下一轮生效）。";
    if (!window.confirm(`回滚到检查点 #${selected.seq}：${scopeLabel}？\n\n${formatLabel(selected.input)}\n\n${consequence}`)) return;
    setPending(scope);
    setError(undefined);
    setLines([]);
    try {
      const result = await actions.rewindCheckpoint(selected.seq, scope);
      setLines(result.lines);
      await reload();
    } catch (rewindError) {
      setError(messageOf(rewindError));
    } finally {
      setPending(null);
    }
  };

  const scopeBtn =
    "rounded-full border border-cream-300 px-3 py-1 text-xs text-ink-600 transition hover:border-clay-500/60 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-label="检查点"
    >
      <div className="flex h-[min(82vh,760px)] w-[min(720px,96vw)] flex-col overflow-hidden rounded-2xl border border-cream-300 bg-cream-100 shadow-xl">
        <header className="flex items-center gap-3 border-b border-cream-300 bg-cream-50 px-4 py-3">
          <h2 className="text-sm font-semibold">⏪ 检查点</h2>
          <span className="text-xs text-ink-400">
            {disabled
              ? "检查点已关闭（AGENT_CHECKPOINTS=0）"
              : loading && data === null
                ? "读取中…"
                : `共 ${checkpoints.length} 个 · 回滚到某项 = 工作区/对话回到该轮开始之前`}
          </span>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-2 py-1 text-sm text-ink-600 transition hover:bg-cream-200"
            title="关闭（Esc）"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {disabled ? (
            <p className="px-2 py-4 text-xs leading-5 text-ink-400">
              服务端以 <span className="font-mono">AGENT_CHECKPOINTS=0</span> 关闭了回合级检查点，
              打开后下一轮对话起会重新拍快照。
            </p>
          ) : loading && data === null ? (
            <p className="px-2 py-4 text-xs text-ink-400">读取检查点…</p>
          ) : checkpoints.length === 0 ? (
            <p className="px-2 py-4 text-xs leading-5 text-ink-400">
              还没有检查点。跑完至少一轮对话后再来——每个回合开始前会自动拍一份工作区快照。
            </p>
          ) : (
            <ul className="space-y-1">
              {checkpoints.map((info) => {
                const active = info.seq === selectedSeq;
                return (
                  <li key={info.seq}>
                    <button
                      onClick={() => setSelectedSeq(info.seq)}
                      className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                        active
                          ? "border-clay-500/60 bg-cream-50 shadow-sm"
                          : "border-transparent hover:border-cream-300 hover:bg-cream-50/70"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded-full bg-cream-200 px-2 py-0.5 font-mono text-[11px] text-ink-600">
                          #{info.seq}
                        </span>
                        <span className="truncate text-xs text-ink-900">{formatLabel(info.input)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-400">
                        <span className="font-mono">{formatTime(info.time)}</span>
                        <span>· 会话记录 {info.records} 条</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="space-y-2 border-t border-cream-300 bg-cream-50 px-4 py-3">
          {error !== undefined && (
            <p className="rounded-lg bg-terra-100 px-3 py-2 text-xs text-terra-500">{error}</p>
          )}
          {lines.length > 0 && (
            <div className="rounded-lg bg-ink-900 px-3 py-2 font-mono text-[11px] leading-5 text-cream-100">
              {lines.map((line, index) => (
                <p key={index} className="whitespace-pre-wrap break-words">{line}</p>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-400">
              {running
                ? "回合进行中，结束后才能回滚"
                : selected === null
                  ? "先选一个检查点"
                  : `回滚到 #${selected.seq}`}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button className={scopeBtn} disabled={!canRewind} onClick={() => void rewind("code")}>
                {pending === "code" ? "回滚中…" : "只恢复代码"}
              </button>
              <button className={scopeBtn} disabled={!canRewind} onClick={() => void rewind("chat")}>
                {pending === "chat" ? "回滚中…" : "只恢复对话"}
              </button>
              <button
                className={`${scopeBtn} border-clay-500/60 text-clay-600`}
                disabled={!canRewind}
                onClick={() => void rewind("all")}
              >
                {pending === "all" ? "回滚中…" : "恢复代码 + 对话"}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
