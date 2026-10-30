import OpenAI from "openai";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
export interface ProviderInput { name: string; baseURL: string; apiKey: string; models: string[] }
export interface ProviderModel { id: string; enabled: boolean }
export interface ProviderInfo { id: string; name: string; baseURL: string; models: ProviderModel[]; hasKey: boolean }
type SavedProvider = { id: string; name: string; baseURL: string; apiKey: string; models: string[]; hidden?: string[] };
/** 对外脱敏展示：密钥换成 hasKey，隐藏集合展开成每个模型的开关状态。 */
function toInfo(p: SavedProvider): ProviderInfo {
  const hidden = p.hidden ?? [];
  return { id: p.id, name: p.name, baseURL: p.baseURL, models: p.models.map(id => ({ id, enabled: !hidden.includes(id) })), hasKey: !!p.apiKey };
}
export class ProviderStore {
  constructor(private file = path.resolve(".agent-data/providers.json")) {}
  private read(): SavedProvider[] { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : []; }
  list(): ProviderInfo[] { return this.read().map(toInfo); }
  private save(rows: SavedProvider[]) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(rows, null, 2), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
  }
  add(input: ProviderInput): ProviderInfo {
    if (typeof input.name !== "string" || !input.name.trim() || typeof input.apiKey !== "string" || !input.apiKey.trim()) throw new Error("请填写供应商名称和 API Key");
    const url = new URL(input.baseURL);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("API 地址须为 HTTP(S) 基础地址，不含账号、查询参数或锚点");
    if (!Array.isArray(input.models) || !input.models.length || input.models.some(m => typeof m !== "string" || !m.trim() || m.includes("::"))) throw new Error("请至少填写一个有效模型 ID");
    const rows = this.read();
    const p: SavedProvider = { id: `${input.name.trim().replace(/[^\p{L}\p{N}_-]/gu, "_")}-${crypto.randomUUID().slice(0, 8)}`, name: input.name.trim(), baseURL: url.toString().replace(/\/$/, ""), apiKey: input.apiKey.trim(), models: [...new Set(input.models.map(m => m.trim()))] };
    rows.push(p); this.save(rows);
    return toInfo(p);
  }
  remove(id: string) { this.save(this.read().filter(p => p.id !== id)); }
  /** 只决定"哪些模型出现在下拉里"；resolve 不看开关，已选中的会话不会因隐藏而失效。 */
  setEnabledModels(id: string, enabledModels: string[]): ProviderInfo {
    if (!Array.isArray(enabledModels) || enabledModels.some(m => typeof m !== "string")) throw new Error("enabledModels 必须是模型 ID 数组");
    const rows = this.read();
    const p = rows.find(row => row.id === id);
    if (!p) throw new Error("供应商不存在");
    const enabled = new Set(enabledModels);
    if ([...enabled].some(m => !p.models.includes(m))) throw new Error("要显示的模型不在该供应商的清单里");
    p.hidden = p.models.filter(m => !enabled.has(m));
    this.save(rows);
    return toInfo(p);
  }
  models(): string[] {
    return this.read().flatMap(p => {
      const hidden = p.hidden ?? [];
      return p.models.filter(m => !hidden.includes(m)).map(m => `${p.id}::${m}`);
    });
  }
  resolve(model: string) {
    const split = model.indexOf("::");
    if (split < 0) return undefined;
    const p = this.read().find(p => p.id === model.slice(0, split));
    const actual = model.slice(split + 2);
    if (!p || !p.models.includes(actual)) throw new Error("供应商或模型已删除，请重新选择模型");
    return { ...p, model: actual };
  }
}
export const providers = new ProviderStore();
/** 同一客户端按每次请求的模型路由，摘要和流式请求同样适用。 */
export function createModelClient(options: { maxRetries?: number; timeout?: number } = {}, store = providers, fetcher: typeof fetch = fetch): OpenAI {
  return new OpenAI({ ...options, apiKey: process.env.OPENAI_API_KEY || "unconfigured", fetch: async (input, init) => {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body);
      const p = typeof body.model === "string" ? store.resolve(body.model) : undefined;
      if (p) {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${p.apiKey}`);
        headers.delete("openai-organization"); headers.delete("openai-project");
        body.model = p.model;
        return fetcher(`${p.baseURL}/chat/completions`, { ...init, headers, body: JSON.stringify(body), redirect: "error" });
      }
    }
    return fetcher(input, init);
  }});
}
