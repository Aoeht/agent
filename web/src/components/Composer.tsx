// web/src/components/Composer.tsx
import { useEffect, useRef, useState } from "react";
import type { ModelProbeStatus, ThinkingEffort } from "@protocol";
import type { SessionConfigInput } from "../lib/transport";
import { firstAvailableModel, visibleModelOptions } from "../lib/modelOptions";
import { useMediaQuery } from "../lib/useMediaQuery";

export interface ComposerConfig {
  model?: string;
  /** 会话级摘要模型（历史压缩/长期摘要/会话命名/记忆提取共用），undefined = 跟随服务器默认 */
  summaryModel?: string;
  temperature?: number;
  maxIterations?: number;
  thinkingEffort?: ThinkingEffort;
}

/** 思考程度档位文案：default 不下发、跟随厂商默认 */
const THINKING_EFFORT_OPTIONS: ReadonlyArray<{ value: ThinkingEffort; label: string }> = [
  { value: "default", label: "默认（跟随厂商）" },
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

/** 探测结果的展示标记：ok 不加前缀（默认即正常），失败档位给前缀与 tooltip 说明 */
function modelOptionLabel(model: string, probe: ModelProbeStatus | undefined): string {
  if (!probe || probe.ok) return model;
  if (probe.kind === "quota") return `⛔ ${model}（配额耗尽）`;
  if (probe.kind === "unavailable") return `⚠️ ${model}（不可用）`;
  return `⚠️ ${model}（探测异常）`;
}

/** 可用模型的配额后缀（响应头限流字段，服务商返回才有） */
function modelOptionQuotaSuffix(probe: ModelProbeStatus | undefined): string {
  return probe?.ok && probe.quota ? `（${probe.quota}）` : "";
}

export function Composer({
  sessionId,
  running,
  disabled,
  models,
  modelStatus,
  accountQuota,
  config,
  onSend,
  onCancel,
  onApplyConfig,
  onDraftConfig,
}: {
  sessionId: string | null;
  running: boolean;
  disabled: boolean;
  models: string[];
  /** 模型可用性探测结果（对话开始时拉取）：探测失败的模型直接从下拉列表剔除 */
  modelStatus?: ModelProbeStatus[];
  /** 账户级配额/余额（服务商支持时才有） */
  accountQuota?: string;
  config: ComposerConfig;
  onSend: (text: string) => void;
  onCancel: () => void;
  onApplyConfig: (config: SessionConfigInput) => Promise<void>;
  /** 欢迎态（sessionId=null）专用：草稿一变就上报，由上层暂存、随首条消息经 createAndSend 落地 */
  onDraftConfig?: (config: SessionConfigInput) => void;
}) {
  const statusMap = new Map((modelStatus ?? []).map((probe) => [probe.model, probe]));
  const [text, setText] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [draft, setDraft] = useState<{
    model: string; summaryModel: string; temperature: string; maxIterations: string; thinkingEffort: string;
  }>({
    model: "",
    summaryModel: "",
    temperature: "",
    maxIterations: "",
    thinkingEffort: "default",
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const draftDirty = useRef(new Set<keyof ComposerConfig>());
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [applying, setApplying] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  // 窄屏输入框只剩一百来像素宽：占位文案换超短句，否则换行后被最小高度裁掉
  const narrow = useMediaQuery("(max-width: 639px)");

  useEffect(() => {
    setPanelOpen(false);
    setConfigError(null);
    setApplying(false);
    draftDirty.current.clear();
  }, [sessionId]);

  // 打开面板时用当前生效值填充草稿；摘要模型未知时落到第一个可用项（未动过就不会被应用）
  useEffect(() => {
    if (panelOpen) {
      setDraft(current => ({
        model: draftDirty.current.has("model") ? current.model : config.model ?? models[0] ?? "",
        summaryModel: draftDirty.current.has("summaryModel")
          ? current.summaryModel
          : config.summaryModel ?? firstAvailableModel(models, modelStatus) ?? "",
        temperature: draftDirty.current.has("temperature") ? current.temperature : String(config.temperature ?? 0.1),
        maxIterations: draftDirty.current.has("maxIterations")
          ? current.maxIterations
          : (config.maxIterations ?? 0) > 0 ? String(config.maxIterations) : "",
        thinkingEffort: draftDirty.current.has("thinkingEffort")
          ? current.thinkingEffort
          : config.thinkingEffort ?? "default",
      }));
    }
  }, [panelOpen, config.model, config.summaryModel, config.temperature, config.maxIterations, config.thinkingEffort, models, modelStatus]);

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

  // 欢迎态（sessionId=null）没有会话可应用配置：只上报草稿，跳过未动过的字段
  const reportDraftConfig = (next: typeof draft) => {
    if (sessionId !== null || !onDraftConfig) return;
    const payload: SessionConfigInput = {};
    if (draftDirty.current.has("model") && next.model) payload.model = next.model;
    if (draftDirty.current.has("summaryModel") && next.summaryModel) payload.summaryModel = next.summaryModel;
    const temperature = Number.parseFloat(next.temperature);
    if (draftDirty.current.has("temperature") && Number.isFinite(temperature)) payload.temperature = temperature;
    const maxIterations = next.maxIterations.trim() === "" ? Number.NaN : Number.parseInt(next.maxIterations, 10);
    if (draftDirty.current.has("maxIterations") && Number.isInteger(maxIterations) && maxIterations >= 0) {
      payload.maxIterations = maxIterations;
    }
    if (draftDirty.current.has("thinkingEffort") &&
        THINKING_EFFORT_OPTIONS.some((option) => option.value === next.thinkingEffort)) {
      payload.thinkingEffort = next.thinkingEffort as ThinkingEffort;
    }
    onDraftConfig(payload);
  };

  const applyConfig = async () => {
    if (applying) return;
    if (sessionId === null) {
      // 欢迎态：配置随首条消息由 createAndSend 应用，这里只需收起面板
      setPanelOpen(false);
      return;
    }
    const requestedSession = sessionId;
    const payload: SessionConfigInput = {};
    if (draftDirty.current.has("model") && draft.model && draft.model !== config.model) payload.model = draft.model;
    if (draftDirty.current.has("summaryModel") && draft.summaryModel &&
        draft.summaryModel !== (config.summaryModel ?? "")) {
      payload.summaryModel = draft.summaryModel;
    }
    const temperature = Number.parseFloat(draft.temperature);
    if (draftDirty.current.has("temperature") && Number.isFinite(temperature) && temperature !== (config.temperature ?? 0.1)) {
      payload.temperature = temperature;
    }
    const maxIterations = draft.maxIterations.trim() === "" ? 0 : Number.parseInt(draft.maxIterations, 10);
    if (draftDirty.current.has("maxIterations") && Number.isInteger(maxIterations) && maxIterations >= 0 &&
        maxIterations !== (config.maxIterations ?? 0)) {
      payload.maxIterations = maxIterations;
    }
    if (draftDirty.current.has("thinkingEffort") &&
        draft.thinkingEffort !== (config.thinkingEffort ?? "default") &&
        THINKING_EFFORT_OPTIONS.some((option) => option.value === draft.thinkingEffort)) {
      payload.thinkingEffort = draft.thinkingEffort as ThinkingEffort;
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

  // 思考程度在输入框右下角即时生效：会话态直接下发（失败回显并回退显示），欢迎态进草稿
  const changeEffort = (value: string) => {
    const next = { ...draft, thinkingEffort: value };
    draftDirty.current.add("thinkingEffort");
    setDraft(next);
    if (sessionId === null) {
      reportDraftConfig(next);
      return;
    }
    void (async () => {
      setApplying(true);
      setConfigError(null);
      try {
        await onApplyConfig({ thinkingEffort: value as ThinkingEffort });
        draftDirty.current.delete("thinkingEffort"); // 成功后回读 config 值，草稿不再钉住
      } catch (error) {
        draftDirty.current.delete("thinkingEffort");
        setConfigError(`思考程度切换失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setApplying(false);
      }
    })();
  };
  // 展示值：改过未应用成功时钉在草稿值，否则跟会话生效值走
  const effortValue = draftDirty.current.has("thinkingEffort")
    ? draft.thinkingEffort
    : config.thinkingEffort ?? "default";

  return (
    <div className="border-t border-cream-300 bg-cream-200/40 px-6 py-4 max-lg:px-3 max-lg:pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="relative mx-auto max-w-3xl">
        {/* 模型/参数弹层 */}
        {panelOpen && (
          <div
            ref={panelRef}
            className="absolute bottom-full left-0 z-20 mb-2 max-h-[60vh] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl border border-cream-300 bg-cream-50 p-4 shadow-xl"
          >
            <h3 className="mb-3 text-sm font-semibold">模型与参数</h3>
            {accountQuota && <p className="mb-2 text-xs text-ink-400">💰 {accountQuota}</p>}
            <label className="block">
              <span className="text-xs text-ink-600">模型</span>
              <select
                value={draft.model}
                disabled={applying}
                onChange={(e) => {
                  draftDirty.current.add("model");
                  const next = { ...draft, model: e.target.value };
                  setDraft(next);
                  reportDraftConfig(next);
                }}
                className="mt-1 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 font-mono text-xs outline-none focus:border-clay-500"
              >
                {visibleModelOptions(models, modelStatus, draft.model).map((model) => {
                  const probe = statusMap.get(model);
                  return (
                    <option key={model} value={model} title={probe && !probe.ok ? probe.detail : undefined}>
                      {modelOptionLabel(model, probe) + modelOptionQuotaSuffix(probe)}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="mt-3 block">
              <span className="text-xs text-ink-600">摘要模型（历史压缩 / 长期记忆）</span>
              <select
                value={draft.summaryModel}
                disabled={applying}
                onChange={(e) => {
                  draftDirty.current.add("summaryModel");
                  const next = { ...draft, summaryModel: e.target.value };
                  setDraft(next);
                  reportDraftConfig(next);
                }}
                className="mt-1 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 font-mono text-xs outline-none focus:border-clay-500"
              >
                {visibleModelOptions(models, modelStatus, draft.summaryModel || config.summaryModel).map((model) => {
                  const probe = statusMap.get(model);
                  return (
                    <option key={model} value={model} title={probe && !probe.ok ? probe.detail : undefined}>
                      {modelOptionLabel(model, probe) + modelOptionQuotaSuffix(probe)}
                    </option>
                  );
                })}
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
                  onChange={(e) => {
                    draftDirty.current.add("temperature");
                    const next = { ...draft, temperature: e.target.value };
                    setDraft(next);
                    reportDraftConfig(next);
                  }}
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
                  onChange={(e) => {
                    draftDirty.current.add("maxIterations");
                    const next = { ...draft, maxIterations: e.target.value };
                    setDraft(next);
                    reportDraftConfig(next);
                  }}
                  className="mt-1 w-full rounded-xl border border-cream-300 bg-white/70 px-3 py-2 text-sm outline-none focus:border-clay-500"
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-ink-400">
              模型与摘要模型的切换会随会话保存；温度、迭代上限仅当前运行有效。迭代上限留空表示不限，由 token / 工具次数预算兜底。
              摘要模型用于历史压缩、跨会话长期记忆、会话命名与记忆提取，换小模型可省成本。
              思考程度在输入框右下角，按当前模型映射厂商参数，无法生效的组合自动跳过。
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
            className="max-w-32 shrink-0 truncate rounded-full bg-cream-200 px-3 py-2 text-xs font-medium text-ink-600 transition hover:bg-cream-300 disabled:opacity-40"
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
            placeholder={
              disabled
                ? "先选择一个会话"
                : narrow
                  ? "派个任务…"
                  : sessionId === null
                    ? "给 Agent 派个任务…"
                    : "给 Agent 派个任务…（Enter 发送，Shift+Enter 换行）"
            }
            disabled={disabled}
            className="max-h-40 min-h-[42px] flex-1 resize-none bg-transparent px-2.5 py-2 text-[15px] max-lg:text-base leading-6 outline-none placeholder:text-ink-400 disabled:opacity-50"
          />
          {/* 思考程度：输入框右下角的即时档位（会话态改完即下发，欢迎态进随发草稿） */}
          <select
            value={effortValue}
            disabled={disabled || running || applying}
            onChange={(e) => changeEffort(e.target.value)}
            title="思考程度：按当前模型映射厂商参数（qwen=enable_thinking+预算、glm=思考开关、deepseek=思考开关+effort），无法生效的组合自动跳过"
            className="max-w-24 shrink-0 truncate rounded-full bg-cream-200 px-2 py-2 text-xs font-medium text-ink-600 outline-none transition hover:bg-cream-300 disabled:opacity-40"
          >
            {THINKING_EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
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
