// web/src/components/ChatPanel.tsx
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore, type ChatItem, type RunStatus } from "../state/store";

/** 工具名 → 中文说明（未收录的回退原名） */
const TOOL_NAMES: Record<string, string> = {
  git_tree: "仓库结构",
  rag_search: "知识库检索",
  run_script: "脚本执行",
  tavily_search: "网页搜索",
  update_plan: "更新计划",
  load_skill: "读取技能",
  inspect_link: "链接检查",
  ingest_findings: "沉淀发现",
};

function StatusDot({ status }: { status: "running" | "done" | "error" }) {
  const color =
    status === "running" ? "bg-clay-500 animate-pulse" : status === "done" ? "bg-sage-500" : "bg-terra-500";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(true);
  const wasRunning = useRef(item.status === "running");
  useEffect(() => {
    // 执行结束后自动收起；用户仍可手动展开
    if (wasRunning.current && item.status !== "running") setOpen(false);
    wasRunning.current = item.status === "running";
  }, [item.status]);

  let argsPretty = item.args;
  try {
    argsPretty = JSON.stringify(JSON.parse(item.args), null, 2);
  } catch {
    // 参数不是合法 JSON 就原样展示
  }

  return (
    <div className="max-w-[85%] self-start overflow-hidden rounded-xl border border-cream-300 bg-cream-50 shadow-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <StatusDot status={item.status} />
        <span className="text-sm font-medium">{TOOL_NAMES[item.name] ?? item.name}</span>
        <span className="truncate font-mono text-xs text-ink-400">{item.name}</span>
        <span className="ml-auto shrink-0 text-xs text-ink-400">{open ? "收起 ▴" : "展开 ▾"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-cream-300/70 px-3.5 py-3">
          <div>
            <p className="mb-1 text-[11px] font-medium tracking-wide text-ink-400">参数</p>
            <pre className="max-h-32 overflow-auto rounded-lg bg-cream-100 p-2.5 font-mono text-xs leading-5 text-ink-600">
              {argsPretty}
            </pre>
          </div>
          {item.status === "running" && <p className="text-xs text-ink-400">执行中…</p>}
          {item.result !== undefined && item.status !== "running" && (
            <div>
              <p className="mb-1 text-[11px] font-medium tracking-wide text-ink-400">
                {item.status === "error" ? "错误" : "结果"}
              </p>
              <pre
                className={`max-h-48 overflow-auto rounded-lg p-2.5 font-mono text-xs leading-5 ${
                  item.status === "error" ? "bg-terra-100 text-terra-500" : "bg-cream-100 text-ink-600"
                }`}
              >
                {item.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-clay-100 px-4 py-2.5 text-[15px] leading-7">
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-[85%] self-start break-words rounded-2xl rounded-bl-md border border-cream-300 bg-cream-50 px-4 py-2.5 shadow-sm">
          <div className="md">
            <Markdown remarkPlugins={[remarkGfm]}>{item.text || "…"}</Markdown>
          </div>
          {item.citations && item.citations.length > 0 && (
            <div className="mt-2.5 border-t border-cream-300/70 pt-2">
              <p className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-400">引用来源</p>
              <div className="flex flex-wrap gap-1.5">
                {item.citations.map((c) => {
                  const badge = (
                    <>
                      <span className="font-mono text-[11px] font-semibold text-clay-600">[{c.index}]</span>
                      <span className="truncate">{c.title}</span>
                    </>
                  );
                  return c.url ? (
                    <a
                      key={c.index}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      title={c.snippet ?? c.url}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-cream-300 bg-cream-100 px-2.5 py-1 text-xs text-ink-600 transition hover:border-clay-500/60 hover:text-ink-900"
                    >
                      {badge}
                    </a>
                  ) : (
                    <span
                      key={c.index}
                      title={c.snippet}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-cream-300 bg-cream-100 px-2.5 py-1 text-xs text-ink-600"
                    >
                      {badge}
                      <span className="font-mono text-[10px] text-ink-400">{c.tool}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {item.streaming && (
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-clay-500 align-middle" />
          )}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "notice":
      return (
        <div
          className={`self-center rounded-full px-3.5 py-1 text-xs ${
            item.tone === "error"
              ? "bg-terra-100 text-terra-500"
              : item.tone === "warn"
                ? "bg-clay-100 text-clay-600"
                : "bg-cream-200 text-ink-600"
          }`}
        >
          {item.text}
        </div>
      );
  }
}

function EmptyState() {
  const { actions, state } = useStore();
  const suggestions = [
    "帮我梳理这个仓库的结构，说说各目录是干嘛的",
    "检索一下知识库里关于混合检索权重的结论",
    "写个脚本统计 src 下各模块的代码行数",
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-clay-100 text-4xl">🌾</div>
      <div>
        <h2 className="text-lg font-semibold">给 Agent 派个任务吧</h2>
        <p className="mt-1 text-sm text-ink-400">
          {state.transportKind === "mock"
            ? "当前是演示数据：流式回复、工具卡、任务计划、人工审批整条链路都会走一遍"
            : "已连接后端，输入任务即可开始；工具调用与审批都会实时展示"}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => void actions.send(s)}
            className="rounded-full border border-cream-300 bg-cream-50 px-5 py-2.5 text-sm text-ink-600 shadow-sm transition hover:border-clay-500/50 hover:text-ink-900"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 排队中的消息芯片：当前回合结束后按序执行；✕ 撤单（不影响正在跑的回合） */
function QueueChips({ queue }: { queue: Array<{ id: string; text: string }> }) {
  const { actions } = useStore();
  if (queue.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {queue.map((item, index) => (
        <div
          key={item.id}
          className="flex max-w-[80%] items-center gap-2 rounded-2xl rounded-br-md border border-dashed border-clay-400/60 bg-clay-50/70 px-3.5 py-2"
        >
          <span className="shrink-0 text-xs text-clay-500">
            {index === 0 ? "⏳ 下一个执行" : `⏳ 排队中（第 ${index + 1} 位）`}
          </span>
          <span className="truncate text-sm text-ink-600" title={item.text}>
            {item.text}
          </span>
          <button
            onClick={() => void actions.removeQueued(item.id)}
            title="撤销这条排队消息"
            className="shrink-0 rounded-full px-1.5 text-sm text-ink-400 transition hover:bg-cream-200 hover:text-terra-500"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function ChatPanel({
  items,
  status,
  queue,
}: {
  items: ChatItem[];
  status: RunStatus;
  queue?: Array<{ id: string; text: string }>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const last = items[items.length - 1];
  const showWaiting = status === "running" && !(last?.kind === "assistant" && last.streaming);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 py-5 max-lg:px-3">
      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {items.map((item) => (
            <ChatItemView key={item.id} item={item} />
          ))}
          {(queue?.length ?? 0) > 0 && <QueueChips queue={queue!} />}
          {showWaiting && (
            <div className="flex items-center gap-1.5 self-start rounded-full bg-cream-200 px-3.5 py-1.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
