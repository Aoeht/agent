// web/src/App.tsx
import { useStore, type RunStatus } from "./state/store";
import { Sidebar, sessionTitle } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { RightPanel } from "./components/RightPanel";
import { Composer } from "./components/Composer";
import { ApprovalModal, InputModal } from "./components/Modals";

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

export default function App() {
  const { state, current, actions } = useStore();
  const busy = current?.status === "running" || current?.status === "awaiting_approval";
  const headerTitle = current?.summary ? sessionTitle(current.summary) : "会话";

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={state.sessions}
        currentId={state.currentId}
        kind={state.transportKind}
        onSelect={actions.selectSession}
        onNew={() => void actions.newSession()}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-cream-300 bg-cream-200/40 px-6 py-3">
          <h2 className="truncate text-sm font-semibold">{headerTitle}</h2>
          <StatusChip status={current?.status ?? "idle"} />
        </header>

        <ChatPanel items={current?.items ?? []} status={current?.status ?? "idle"} />

        <Composer
          sessionId={state.currentId}
          running={busy === true}
          disabled={!current}
          models={state.models}
          config={{
            model: current?.model ?? current?.meta?.model,
            temperature: current?.temperature,
            maxIterations: current?.maxIterations,
          }}
          onSend={(text) => void actions.send(text)}
          onCancel={() => void actions.cancel()}
          onApplyConfig={actions.applySessionConfig}
        />
      </main>

      <RightPanel />

      <ApprovalModal />
      <InputModal />
    </div>
  );
}
