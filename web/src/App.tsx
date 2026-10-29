// web/src/App.tsx
import { useEffect, useState } from "react";
import { useStore, type RunStatus } from "./state/store";
import { Sidebar, sessionTitle } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { RightPanel } from "./components/RightPanel";
import { Composer } from "./components/Composer";
import { Welcome } from "./components/Welcome";
import { ApprovalModal, InputModal } from "./components/Modals";
import { JobsPanel } from "./components/JobsPanel";
import { CheckpointsPanel } from "./components/CheckpointsPanel";
import { McpPanel } from "./components/McpPanel";
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
  // 后台任务面板是独立覆盖层：全局（不属于某个会话），入口在页头
  const [jobsOpen, setJobsOpen] = useState(false);
  // 检查点面板：会话级（入口只在选中会话时出现）
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  // MCP 目录面板：会话级（注入/载入都要发到当前会话的命令通道）
  const [mcpOpen, setMcpOpen] = useState(false);
  const runningJobs = state.jobs.filter((job) => job.status === "running").length;

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
          <div className="ml-auto flex items-center gap-1">
            {current && (
              <button
                onClick={() => setCheckpointsOpen(true)}
                title="检查点（回滚工作区/对话到某轮开始之前）"
                className={iconBtn}
              >
                ⏪
              </button>
            )}
            {current && (
              <button
                onClick={() => setMcpOpen(true)}
                title="MCP 目录（资源 / 提示模板）"
                className={iconBtn}
              >
                🧩
              </button>
            )}
            <button
              onClick={() => setJobsOpen(true)}
              title={runningJobs > 0 ? `后台任务（${runningJobs} 个运行中）` : "后台任务"}
              className={`relative ${iconBtn}`}
            >
              🖥️
              {runningJobs > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-clay-600 px-1 text-[9px] font-semibold leading-none text-cream-50">
                  {runningJobs}
                </span>
              )}
            </button>
            {current && !hasPanel && (
              <button onClick={() => setDrawer("panel")} title="任务与运行环境" className={iconBtn}>
                📋
              </button>
            )}
          </div>
        </header>

        {current ? (
          <>
            <ChatPanel items={current.items} status={current.status} queue={current.queue} />

            <Composer
              sessionId={state.currentId}
              running={busy === true}
              disabled={false}
              models={state.models}
              modelStatus={state.modelStatus}
              accountQuota={state.modelAccountQuota}
              config={{
                model: current.model ?? current.meta?.model,
                summaryModel: current.summaryModel ?? current.meta?.summaryModel,
                // 窗口与覆盖以 store 的最新事件值为准：hello 快照（meta）可能是建会话后、
                // 首次配置落地前的旧值，回退到它会复活已经清空的覆盖
                contextWindow: current.contextWindow,
                contextWindowOverride: current.contextWindowOverride,
                temperature: current.temperature,
                maxIterations: current.maxIterations,
                thinkingEffort: current.thinkingEffort,
              }}
              visionCapable={current.visionCapable}
              onSend={(text, images) => void actions.send(text, images)}
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
      <JobsPanel open={jobsOpen} onClose={() => setJobsOpen(false)} />
      <CheckpointsPanel open={checkpointsOpen} onClose={() => setCheckpointsOpen(false)} />
      <McpPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
    </div>
  );
}
