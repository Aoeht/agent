// web/src/components/Sidebar.tsx
import type { SessionSummaryDTO } from "@protocol";
import type { Transport } from "../lib/transport";

/** 会话标题：生成过的会话名优先，否则用首条消息预览，最后才是文件名 */
export function sessionTitle(s: SessionSummaryDTO): string {
  if (s.name !== undefined) return s.name;
  const preview = s.firstUserText.trim();
  if (preview !== "") return preview.length > 20 ? `${preview.slice(0, 20)}…` : preview;
  return s.sessionId;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function Sidebar({
  sessions,
  currentId,
  kind,
  onSelect,
  onNew,
  drawer = false,
  drawerOpen = false,
}: {
  sessions: SessionSummaryDTO[];
  currentId: string | null;
  kind: Transport["kind"];
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 窄屏抽屉模式：fixed 滑入滑出，不占布局；桌面保持静态 w-72 */
  drawer?: boolean;
  drawerOpen?: boolean;
}) {
  return (
    <aside
      className={[
        "flex w-72 flex-col gap-3 border-r border-cream-300 p-4",
        // 抽屉浮在主界面上方：必须用不透明底色，否则透出下层内容
        drawer
          ? `fixed inset-y-0 left-0 z-40 shrink-0 bg-cream-100 shadow-xl transition-transform duration-200 ${
              drawerOpen ? "translate-x-0" : "invisible -translate-x-full"
            }`
          : "shrink-0 bg-cream-200/40",
      ].join(" ")}
    >
      <div className="px-1">
        <h1 className="text-lg font-semibold tracking-tight">Agent 工作台</h1>
        <p className="mt-0.5 text-xs text-ink-400">
          本地智能体 · {kind === "mock" ? "演示数据" : "已连接后端"}
        </p>
      </div>

      <button
        onClick={onNew}
        className="rounded-xl bg-clay-600 px-4 py-2.5 text-sm font-medium text-cream-50 shadow-sm transition hover:bg-clay-500"
      >
        ＋ 新会话
      </button>

      <nav className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1">
        {sessions.map((s) => {
          const active = s.sessionId === currentId;
          return (
            <button
              key={s.sessionId}
              onClick={() => onSelect(s.sessionId)}
              className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                active
                  ? "border-clay-500/40 bg-clay-100"
                  : "border-transparent hover:bg-cream-200"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">{sessionTitle(s)}</span>
                <span className="shrink-0 text-[11px] text-ink-400">{formatTime(s.lastUpdated)}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-ink-400">{s.firstUserText || "（还没有消息）"}</p>
            </button>
          );
        })}
      </nav>

      <p className="text-center text-[11px] text-ink-400">前端 v0.1 · 协议 v1</p>
    </aside>
  );
}
