// web/src/App.tsx
import { useEffect, useState } from "react";
import { useStore, type RunStatus } from "./state/store";
import { Sidebar, sessionTitle } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { RightPanel } from "./components/RightPanel";
import { Composer } from "./components/Composer";
import { Welcome } from "./components/Welcome";
import { ApprovalModal, InputModal } from "./components/Modals";
import { useMediaQuery } from "./lib/useMediaQuery";

function StatusChip({ status }: { status: RunStatus }) {
  if (status === "idle") {
    return <span className="rounded-full bg-cream-200 px-2.5 py-0.5 text-xs text-ink-600">空闲</span>;
  }
  if (status === "running") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-clay-100 px-2.5 py-0.5 text-xs text-clay-600">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-clay-500" />
        运行中
      </span>
    );
  }
  return (
    <span className="rounded-full bg-terra-100 px-2.5 py-0.5 text-xs text-terra-500">
      {status === "awaiting_approval" ? "等待确认" : "等待输入"}
    </span>
  );
}

/** 断点规则：<1024px 会话栏变左侧抽屉，<1280px 右栏变右侧抽屉；≥断点的桌面布局与原先一致 */
export default function App() {
  const { state, current, actions } = useStore();
  const busy = current?.status === "running" || current?.status === "awaiting_approval";
  const headerTitle = current?.summary ? sessionTitle(current.summary) : "会话";
  const hasSidebar = useMediaQuery("(min-width: 1024px)");
  const hasPanel = useMediaQuery("(min-width: 1280px)");
  const [drawer, setDrawer] = useState<"sessions" | "panel" | null>(null);

  // 跨断点后抽屉入口随断点消失，残存的开启状态一并收起
  useEffect(() => {
    setDrawer((open) => ((open === "sessions" && hasSidebar) || (open === "panel" && hasPanel) ? null : open));
  }, [hasSidebar, hasPanel]);

  useEffect(() => {
    if (drawer === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const iconBtn = "shrink-0 rounded-lg p-1.5 text-base leading-none text-ink-600 transition hover:bg-cream-200";

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={state.sessions}
        currentId={state.currentId}
        kind={state.transportKind}
        drawer={!hasSidebar}
        drawerOpen={drawer === "sessions"}
        onSelect={(id) => {
          actions.selectSession(id);
          setDrawer(null);
        }}
        onNew={() => {
          actions.goWelcome();
          setDrawer(null);
        }}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-cream-300 bg-cream-200/40 px-6 py-3 max-lg:px-4">
          {!hasSidebar && (
            <button onClick={() => setDrawer("sessions")} title="会话列表" className={iconBtn}>
              ☰
            </button>
          )}
          <h2 className="truncate text-sm font-semibold">{current ? headerTitle : "新会话"}</h2>
          {current && <StatusChip status={current.status} />}
          {current && !hasPanel && (
            <button onClick={() => setDrawer("panel")} title="任务与运行环境" className={`${iconBtn} ml-auto`}>
              📋
            </button>
          )}
        </header>

        {current ? (
          <>
            <ChatPanel items={current.items} status={current.status} queue={current.queue} />

            <Composer
              sessionId={state.currentId}
              running={busy === true}
              disabled={false}
              models={state.models}
              config={{
                model: current.model ?? current.meta?.model,
                temperature: current.temperature,
                maxIterations: current.maxIterations,
              }}
              onSend={(text) => void actions.send(text)}
              onCancel={() => void actions.cancel()}
              onApplyConfig={actions.applySessionConfig}
            />
          </>
        ) : (
          // 欢迎界面：无当前会话时的新建窗口（首条消息发出才建会话）
          <Welcome />
        )}
      </main>

      {current && <RightPanel drawer={!hasPanel} drawerOpen={drawer === "panel"} />}

      {drawer !== null && (
        <div className="fixed inset-0 z-30 bg-ink-900/30" onClick={() => setDrawer(null)} aria-hidden="true" />
      )}

      <ApprovalModal />
      <InputModal />
    </div>
  );
}
