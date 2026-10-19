// web/src/components/Modals.tsx
import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../state/store";

function ModalShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-cream-300 bg-cream-50 p-6 shadow-xl">
        {children}
      </div>
    </div>
  );
}

export function ApprovalModal() {
  const { current, actions } = useStore();
  const pending = current?.pendingApproval;
  const [values, setValues] = useState<Record<string, string>>({});

  const pendingId = pending?.id;
  useEffect(() => {
    if (!pendingId) return;
    const init: Record<string, string> = {};
    for (const [key, field] of Object.entries(current?.pendingApproval?.requestedSchema ?? {})) {
      init[key] = field.default !== undefined ? String(field.default) : "";
    }
    setValues(init);
    // eslint 不在构建链里：依赖只挂 pendingId，表单随请求切换重置
  }, [pendingId]);

  if (!pending) return null;
  const fields = Object.entries(pending.requestedSchema ?? {});

  return (
    <ModalShell>
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-full bg-clay-100 px-2.5 py-0.5 text-xs font-medium text-clay-600">
          {pending.toolName ?? "工具"}
        </span>
        {pending.source && <span className="text-xs text-ink-400">来源：{pending.source}</span>}
      </div>
      <h2 className="text-base font-semibold">需要人工确认</h2>
      <p className="mt-2 text-sm leading-6 text-ink-600">{pending.message}</p>

      {fields.length > 0 && (
        <div className="mt-4 space-y-3">
          {fields.map(([key, field]) => (
            <label key={key} className="block">
              <span className="text-sm font-medium">{field.title ?? key}</span>
              {field.description && (
                <span className="ml-2 text-xs text-ink-400">{field.description}</span>
              )}
              <input
                value={values[key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                className="mt-1.5 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 text-sm outline-none transition focus:border-clay-500"
              />
            </label>
          ))}
        </div>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <button
          onClick={() => void actions.resolveApproval({ action: "decline" })}
          className="rounded-full border border-cream-300 px-5 py-2 text-sm font-medium transition hover:bg-cream-200"
        >
          拒绝
        </button>
        <button
          onClick={() => void actions.resolveApproval({ action: "accept", content: values })}
          className="rounded-full bg-clay-600 px-5 py-2 text-sm font-medium text-cream-50 transition hover:bg-clay-500"
        >
          允许执行
        </button>
      </div>
    </ModalShell>
  );
}

export function InputModal() {
  const { current, actions } = useStore();
  const pending = current?.pendingInput;
  const [text, setText] = useState("");

  useEffect(() => {
    setText("");
  }, [pending?.id]);

  if (!pending) return null;

  return (
    <ModalShell>
      <h2 className="text-base font-semibold">Agent 需要你的输入</h2>
      <p className="mt-2 text-sm leading-6 text-ink-600">{pending.prompt}</p>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void actions.resolveInput(text);
        }}
        className="mt-4 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 text-sm outline-none transition focus:border-clay-500"
      />
      <div className="mt-6 flex justify-end">
        <button
          onClick={() => void actions.resolveInput(text)}
          className="rounded-full bg-clay-600 px-5 py-2 text-sm font-medium text-cream-50 transition hover:bg-clay-500"
        >
          提交
        </button>
      </div>
    </ModalShell>
  );
}

/** 沙箱目录切换：服务器整栈重建（MCP 重新挂载），有在飞回合时会被拒绝 */
export function SandboxModal({
  current,
  onClose,
  onApply,
}: {
  current?: string;
  onClose: () => void;
  onApply: (dir: string) => Promise<void>;
}) {
  const [dir, setDir] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const submit = async () => {
    const trimmed = dir.trim();
    if (trimmed === "" || applying) return;
    setApplying(true);
    setError(null);
    try {
      await onApply(trimmed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setApplying(false);
    }
  };

  return (
    <ModalShell>
      <h2 className="text-base font-semibold">更改沙箱目录</h2>
      <p className="mt-2 text-sm leading-6 text-ink-600">
        Agent 的文件读写与脚本执行都限定在这个目录内。切换会重建运行环境（MCP 重新挂载），
        目录不存在会自动创建；有回合在跑时无法切换。
      </p>
      <input
        autoFocus
        value={dir}
        onChange={(e) => setDir(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
        }}
        placeholder="例如 A:\\projects\\demo（绝对路径或相对路径）"
        className="mt-4 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 font-mono text-xs outline-none transition focus:border-clay-500"
      />
      {error && <p className="mt-2 text-xs text-terra-500">{error}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-full border border-cream-300 px-5 py-2 text-sm font-medium transition hover:bg-cream-200"
        >
          取消
        </button>
        <button
          onClick={() => void submit()}
          disabled={dir.trim() === "" || applying}
          className="rounded-full bg-clay-600 px-5 py-2 text-sm font-medium text-cream-50 transition hover:bg-clay-500 disabled:opacity-40"
        >
          {applying ? "切换中…" : "切换"}
        </button>
      </div>
    </ModalShell>
  );
}
