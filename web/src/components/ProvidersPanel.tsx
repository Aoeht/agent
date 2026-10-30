import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import type { ProviderInfo } from "../lib/transport";
export function ProvidersPanel({ onClose }: { onClose: () => void }) {
  const { actions, state } = useStore();
  const [rows, setRows] = useState<ProviderInfo[]>([]);
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { void actions.listProviders().then(setRows).catch(e => setMessage(String(e))); }, []);
  const run = async (task: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await task(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const inputClass = "w-full rounded-lg border border-cream-300 bg-white p-2 text-sm";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="模型供应商">
    <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-2xl bg-cream-100 p-6 shadow-xl">
      <div className="mb-4 flex justify-between"><h2 className="font-semibold">模型供应商</h2><button onClick={onClose} disabled={busy}>关闭</button></div>
      <p className="mb-4 text-sm text-ink-600">支持 OpenAI 兼容的聊天 API。密钥仅保存在服务器本地配置文件中；模型 ID 请按供应商文档填写。</p>
      {rows.map(p => <div key={p.id} className="mb-3 rounded-lg border border-cream-300 p-3 text-sm">
        <strong>{p.name}</strong><p className="break-all">{p.baseURL}</p><p>{p.models.join("、")}</p>
        <button disabled={busy} onClick={() => void run(async () => { await actions.removeProvider(p.id); setRows(await actions.listProviders()); await actions.refreshModels(); })} className="mt-2 text-terra-500">删除供应商</button>
      </div>)}
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run(async () => {
        await actions.addProvider({ name, baseURL, apiKey, models: models.split(/[,，\n]/).map(m => m.trim()).filter(Boolean) });
        setKey(""); setName(""); setBaseURL(""); setModels("");
        setRows(await actions.listProviders()); await actions.refreshModels(); setMessage("已保存，可在模型下拉列表中选择。尚未发送探测请求。");
      }); }}>
        <label className="block text-sm">供应商名称<input className={inputClass} required value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的百炼" /></label>
        <label className="block text-sm">API 基础地址<input className={inputClass} required type="url" value={baseURL} onChange={e => setBaseURL(e.target.value)} placeholder="https://example.com/v1" /></label>
        <label className="block text-sm">API Key<input className={inputClass} required type="password" autoComplete="off" value={apiKey} onChange={e => setKey(e.target.value)} /></label>
        <label className="block text-sm">模型 ID<textarea className={inputClass} required value={models} onChange={e => setModels(e.target.value)} placeholder="多个模型用逗号或换行分隔" /></label>
        <button disabled={busy} className="rounded-lg bg-clay-500 px-4 py-2 text-white">添加供应商</button>
      </form>
      <div className="mt-5 border-t border-cream-300 pt-4">
        <button disabled={busy} className="rounded-lg border border-cream-300 px-4 py-2" onClick={() => void run(async () => { await actions.probeModels(); setMessage("探测完成"); })}>{busy ? "处理中…" : "手动探测模型可用性 / 额度"}</button>
        <p className="mt-2 text-xs text-ink-600">仅点击后发送少量推理请求，可能产生费用。成功表示可调用，不代表仍有免费额度。</p>
        {state.modelStatus.map(p => <p className="mt-2 break-all text-sm" key={p.model}>{rows.reduce((label, row) => label.replace(row.id + "::", row.name + " / "), p.model)}：{p.ok ? "可用" : p.kind === "quota" ? "额度耗尽" : p.kind === "unavailable" ? "不可用" : "探测异常"}{p.quota ? `（${p.quota}）` : ""}</p>)}
      </div>
      {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    </div>
  </div>;
}
