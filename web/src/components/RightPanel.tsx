// web/src/components/RightPanel.tsx
import { useState } from "react";
import { useStore, type SessionUIState } from "../state/store";
import { PlanPanel } from "./PlanPanel";
import { SandboxModal } from "./Modals";
import { STOP_REASON_LABELS } from "../../../src/core/run_outcome";
import { TASK_STATE_LABELS } from "../../../src/core/task_types";

/** 工具开关面板：折叠框，勾选 = 启用；下一轮迭代立即生效 */
function ToolToggles({ session }: { session: SessionUIState | null }) {
  const { actions } = useStore();
  const [open, setOpen] = useState(false);
  const tools = session?.tools ?? [];
  const disabled = new Set(session?.disabledTools ?? []);
  const running = session?.status === "running" || session?.status === "awaiting_approval";

  if (tools.length === 0) {
    return <p className="text-xs leading-5 text-ink-400">工具清单加载中…</p>;
  }
  const enabledCount = tools.length - disabled.size;
  const builtin = tools.filter((tool) => !tool.name.includes("__"));
  const mcp = tools.filter((tool) => tool.name.includes("__"));

  const renderGroup = (title: string, group: Array<{ name: string; description: string }>) =>
    group.length === 0 ? null : (
      <div>
        <p className="mb-1 px-1 text-[11px] font-medium tracking-wide text-ink-400">{title}</p>
        {group.map((tool) => {
          const enabled = !disabled.has(tool.name);
          return (
            <label
              key={tool.name}
              title={tool.description}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-cream-200/60"
            >
              <input
                type="checkbox"
                checked={enabled}
                disabled={running}
                onChange={(e) => void actions.toggleTool(tool.name, e.target.checked)}
                className="h-3.5 w-3.5 accent-[#c2703e]"
              />
              <span
                className={`truncate font-mono text-xs ${enabled ? "text-ink-900" : "text-ink-400 line-through"}`}
              >
                {tool.name}
              </span>
            </label>
          );
        })}
      </div>
    );

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-4 text-ink-400">
        关闭的工具从模型的工具列表移除，下一轮立即生效（仅当前会话）。
      </p>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={running}
        className="flex w-full items-center justify-between rounded-xl border border-cream-300 px-3 py-2 text-xs text-ink-600 transition hover:border-clay-500/50 hover:text-ink-900 disabled:opacity-50"
      >
        <span>
          {tools.length} 个工具 · 已启用 {enabledCount}
        </span>
        <span>{open ? "▴ 收起" : "▾ 展开"}</span>
      </button>
      {open && (
        <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-cream-300/70 bg-cream-100/60 p-2.5">
          {renderGroup("内置工具", builtin)}
          {renderGroup("MCP 工具", mcp)}
        </div>
      )}
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-cream-300 bg-cream-50 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 上下文占用：最近一次 step 的 promptTokens ≈ 发送时的上下文长度 */
function ContextUsage({ session }: { session: SessionUIState }) {
  const { lastPromptTokens, contextWindow } = session;
  if (contextWindow === undefined || lastPromptTokens === undefined || lastPromptTokens <= 0) {
    return <p className="text-xs leading-5 text-ink-400">回合运行后这里显示上下文占用（按最近一轮的 prompt 估算）。</p>;
  }
  const percent = Math.min(100, Math.round((lastPromptTokens / contextWindow) * 100));
  const tone = percent >= 85 ? "bg-terra-500" : percent >= 60 ? "bg-clay-500" : "bg-sage-500";
  return (
    <div className="space-y-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-cream-200">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-400">上下文占用</span>
        <span className="font-mono text-xs">
          ~{lastPromptTokens.toLocaleString()} / {contextWindow.toLocaleString()}（{percent}%）
        </span>
      </div>
    </div>
  );
}

function Stats({ session }: { session: SessionUIState }) {
  const rows: Array<[string, string]> = [];
  if (session.stats) {
    rows.push(["Token", session.stats.totalTokens.toLocaleString()]);
    rows.push(["工具调用", `${session.stats.toolCallsCount} 次`]);
    rows.push(["迭代", `${session.stats.iterations} 轮`]);
  }
  if ((session.accumulatedTokens ?? 0) > 0) {
    rows.push(["本次累计", session.accumulatedTokens!.toLocaleString()]);
  }
  return (
    <div className="space-y-2">
      {session.stats && (
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              session.stats.success ? "bg-sage-100 text-sage-500" : "bg-terra-100 text-terra-500"
            }`}
          >
            {session.stats.stopReason ? STOP_REASON_LABELS[session.stats.stopReason] : session.stats.success ? "已回答" : "未完成"}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-xs leading-5 text-ink-400">回合结束后这里展示 token 消耗、工具调用与迭代数。</p>
      ) : (
        rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between text-sm">
            <span className="text-ink-400">{label}</span>
            <span className="font-medium">{value}</span>
          </div>
        ))
      )}
      <ContextUsage session={session} />
    </div>
  );
}

function Env({ session, sandboxRoot, onChangeSandbox }: { session: SessionUIState | null; sandboxRoot?: string; onChangeSandbox: () => void }) {
  const meta = session?.meta;
  if (!meta) return <p className="text-xs text-ink-400">等待连接…</p>;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ink-400">模型</span>
        <span className="font-mono text-xs">{session?.model ?? meta.model}</span>
      </div>
      {meta.summaryModel && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ink-400">摘要模型</span>
          <span className="font-mono text-xs">{meta.summaryModel}</span>
        </div>
      )}
      {(session?.temperature !== undefined || meta.temperature !== undefined) && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ink-400">温度 / 迭代</span>
          <span className="font-mono text-xs">
            {session?.temperature ?? meta.temperature} · {session?.maxIterations ?? meta.maxIterations} 轮
          </span>
        </div>
      )}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-ink-400">脚本沙箱</span>
        <span className="text-right text-xs leading-5">{meta.sandbox}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-ink-400">沙箱目录</span>
        <span className="truncate font-mono text-[11px]" title={sandboxRoot}>
          {sandboxRoot ?? "—"}
        </span>
      </div>
      <button
        onClick={onChangeSandbox}
        className="w-full rounded-xl border border-cream-300 px-3 py-1.5 text-xs text-ink-600 transition hover:border-clay-500/50 hover:text-ink-900"
      >
        更改沙箱目录…
      </button>
      {meta.mcpServers && meta.mcpServers.length > 0 && (
        <div>
          <p className="mb-1 text-ink-400">MCP 服务</p>
          <div className="flex flex-wrap gap-1.5">
            {meta.mcpServers.map((server) => (
              <span
                key={server.id}
                className={`rounded-full px-2.5 py-0.5 text-xs ${
                  server.ok ? "bg-sage-100 text-sage-500" : "bg-terra-100 text-terra-500"
                }`}
              >
                {server.ok ? "●" : "○"} {server.id}
                {server.tools !== undefined ? ` · ${server.tools}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}
      {meta.skills && meta.skills.length > 0 && (
        <div>
          <p className="mb-1 text-ink-400">技能（{meta.skills.length}）</p>
          <p className="font-mono text-[11px] leading-5 text-ink-600">{meta.skills.join(" · ")}</p>
        </div>
      )}
      {meta.promptHash && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ink-400">提示词指纹</span>
          <span className="font-mono text-[11px]">{meta.promptHash}</span>
        </div>
      )}
    </div>
  );
}

export function RightPanel() {
  const { state, current, actions } = useStore();
  const [sandboxModalOpen, setSandboxModalOpen] = useState(false);
  return (
    <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-cream-300 bg-cream-200/40 p-4 xl:flex">
      <Card title="任务计划">
        {current?.task && (
          <div className="mb-3 space-y-2 text-xs leading-5 text-ink-600">
            <p className="font-medium">{TASK_STATE_LABELS[current.task.state]}</p>
            <p>{current.task.goal}</p>
            <p className="text-ink-400">已保存 · {current.task.runs.length} 次运行 · {current.task.actions.length} 次工具操作</p>
            {current.task.criteria.length > 0 && (
              <p className={current.task.criteriaSource === "host" ? "text-ink-400" : "text-terra-500"}>
                验收条件来源：{current.task.criteriaSource === "host" ? "宿主设定" : "模型自设（标准由模型提出）"}
              </p>
            )}
            {current.task.criteria.map((criterion, index) => (
              <p key={index}>验收：{criterion.description}（{criterion.path}）</p>
            ))}
            {current.task.verification.checks.map((check, index) => (
              <p key={index} className={check.passed ? "text-sage-500" : "text-terra-500"}>
                {check.passed ? "✓" : "!"} {check.description}：{check.detail}
              </p>
            ))}
            {current.task.actions.filter(action => action.state === "unknown").map(action => (
              <div key={action.id} className="break-all rounded border border-cream-300 p-2">
                <p>待核对：{action.tool}</p>
                <p>{action.arguments}</p>
                <p>核对后在聊天中输入：/task resolve {action.id} applied 核对说明</p>
                <p>若确认未执行，将 applied 换成 not_applied。待核对较多时可用 /task resolve all applied 核对说明 一次记录。</p>
              </div>
            ))}
            <p className="text-ink-400">继续发送消息会接续未完成任务。切换目标：/task new 新任务目标</p>
          </div>
        )}
        <PlanPanel plan={current?.plan ?? []} />
      </Card>
      <Card
        title="工具开关"
        action={
          current?.tools ? (
            <span className="text-[11px] text-ink-400">
              {current.tools.length - (current.disabledTools?.length ?? 0)}/{current.tools.length}
            </span>
          ) : undefined
        }
      >
        <ToolToggles session={current} />
      </Card>
      <Card title="上次运行">{current ? <Stats session={current} /> : null}</Card>
      <Card title="运行环境">
        <Env
          session={current}
          sandboxRoot={state.appSettings.sandboxRoot}
          onChangeSandbox={() => setSandboxModalOpen(true)}
        />
      </Card>
      {sandboxModalOpen && <SandboxModal onClose={() => setSandboxModalOpen(false)} onApply={actions.setSandboxRoot} />}
    </aside>
  );
}
