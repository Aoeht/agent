// web/src/components/Composer.tsx
import { useEffect, useRef, useState } from "react";
import type { SessionConfigInput } from "../lib/transport";

export interface ComposerConfig {
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

export function Composer({
  sessionId,
  running,
  disabled,
  models,
  config,
  onSend,
  onCancel,
  onApplyConfig,
}: {
  sessionId: string | null;
  running: boolean;
  disabled: boolean;
  models: string[];
  config: ComposerConfig;
  onSend: (text: string) => void;
  onCancel: () => void;
  onApplyConfig: (config: SessionConfigInput) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<{ model: string; temperature: string; maxIterations: string }>({
    model: "",
    temperature: "",
    maxIterations: "",
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const draftDirty = useRef(new Set<keyof ComposerConfig>());
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [applying, setApplying] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    setPanelOpen(false);
    setConfigError(null);
    setApplying(false);
    draftDirty.current.clear();
  }, [sessionId]);

  // 打开面板时用当前生效值填充草稿
  useEffect(() => {
    if (panelOpen) {
      setDraft(current => ({
        model: draftDirty.current.has("model") ? current.model : config.model ?? models[0] ?? "",
        temperature: draftDirty.current.has("temperature") ? current.temperature : String(config.temperature ?? 0.1),
        maxIterations: draftDirty.current.has("maxIterations")
          ? current.maxIterations
          : (config.maxIterations ?? 0) > 0 ? String(config.maxIterations) : "",
      }));
    }
  }, [panelOpen, config.model, config.temperature, config.maxIterations, models]);

  // 点击面板外部关闭
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setPanelOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [panelOpen]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const autoGrow = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  };

  const applyConfig = async () => {
    if (applying) return;
    const requestedSession = sessionId;
    const payload: SessionConfigInput = {};
    if (draftDirty.current.has("model") && draft.model && draft.model !== config.model) payload.model = draft.model;
    const temperature = Number.parseFloat(draft.temperature);
    if (draftDirty.current.has("temperature") && Number.isFinite(temperature) && temperature !== (config.temperature ?? 0.1)) {
      payload.temperature = temperature;
    }
    const maxIterations = draft.maxIterations.trim() === "" ? 0 : Number.parseInt(draft.maxIterations, 10);
    if (draftDirty.current.has("maxIterations") && Number.isInteger(maxIterations) && maxIterations >= 0 &&
        maxIterations !== (config.maxIterations ?? 0)) {
      payload.maxIterations = maxIterations;
    }
    setApplying(true);
    setConfigError(null);
    try {
      if (Object.keys(payload).length > 0) await onApplyConfig(payload);
      if (activeSession.current === requestedSession) setPanelOpen(false);
    } catch (error) {
      if (activeSession.current === requestedSession) {
        setConfigError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (activeSession.current === requestedSession) setApplying(false);
    }
  };

  return (
    <div className="border-t border-cream-300 bg-cream-200/40 px-6 py-4">
      <div className="relative mx-auto max-w-3xl">
        {/* 模型/参数弹层 */}
        {panelOpen && (
          <div
            ref={panelRef}
            className="absolute bottom-full left-0 z-20 mb-2 w-80 rounded-2xl border border-cream-300 bg-cream-50 p-4 shadow-xl"
          >
            <h3 className="mb-3 text-sm font-semibold">模型与参数</h3>
            <label className="block">
              <span className="text-xs text-ink-600">模型</span>
              <select
                value={draft.model}
                disabled={applying}
                onChange={(e) => { draftDirty.current.add("model"); setDraft((d) => ({ ...d, model: e.target.value })); }}
                className="mt-1 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 font-mono text-xs outline-none focus:border-clay-500"
              >
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-ink-600">温度 (0–2)</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={draft.temperature}
                  disabled={applying}
                  onChange={(e) => { draftDirty.current.add("temperature"); setDraft((d) => ({ ...d, temperature: e.target.value })); }}
                  className="mt-1 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 text-sm outline-none focus:border-clay-500"
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-600">迭代上限（留空=不限）</span>
                <input
                  type="number"
                  min="0"
                  placeholder="不限"
                  value={draft.maxIterations}
                  disabled={applying}
                  onChange={(e) => { draftDirty.current.add("maxIterations"); setDraft((d) => ({ ...d, maxIterations: e.target.value })); }}
                  className="mt-1 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 text-sm outline-none focus:border-clay-500"
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-ink-400">
              模型切换会随会话保存；温度与迭代上限仅当前运行有效。迭代上限留空表示不限，由 token / 工具次数预算兜底。
            </p>
            {configError && <p role="alert" className="mt-2 text-xs text-terra-500">{configError}</p>}
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => void applyConfig()}
                disabled={running || applying}
                className="rounded-full bg-clay-600 px-4 py-1.5 text-xs font-medium text-cream-50 transition hover:bg-clay-500 disabled:opacity-40"
              >
                {applying ? "应用中…" : "应用"}
              </button>
            </div>
          </div>
        )}

        <div className="flex items-end gap-2 rounded-2xl border border-cream-300 bg-cream-50 p-2 shadow-sm transition focus-within:border-clay-500/50">
          <button
            onClick={() => {
              if (!panelOpen) { draftDirty.current.clear(); setConfigError(null); }
              setPanelOpen((open) => !open);
            }}
            disabled={disabled || !config.model || applying}
            title="模型与参数"
            className="shrink-0 rounded-full bg-cream-200 px-3 py-2 text-xs font-medium text-ink-600 transition hover:bg-cream-300 disabled:opacity-40"
          >
            ⚙ {(config.model ?? models[0] ?? "模型").split("/").pop()}
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={(e) => {
              // 中文输入法组词中的 Enter 不应发送
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={disabled ? "先选择一个会话" : "给 Agent 派个任务…（Enter 发送，Shift+Enter 换行；运行中发送会自动排队）"}
            disabled={disabled}
            className="max-h-40 min-h-[42px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[15px] leading-6 outline-none placeholder:text-ink-400 disabled:opacity-50"
          />
          {running ? (
            <button
              onClick={onCancel}
              className="shrink-0 rounded-full bg-terra-500 px-4 py-2 text-sm font-medium text-cream-50 transition hover:opacity-90"
            >
              停止
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={disabled || !text.trim()}
              className="shrink-0 rounded-full bg-clay-600 px-5 py-2 text-sm font-medium text-cream-50 transition hover:bg-clay-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
