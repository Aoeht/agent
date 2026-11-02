import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderStore, createModelClient, providersFile, resolveAuxEndpoint } from "../src/core/providers";

test("供应商持久化、脱敏、同名模型隔离及请求路由", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-test-"));
  try {
    const file = path.join(dir, "providers.json");
    const store = new ProviderStore(file);
    const a = store.add({ name: "A", baseURL: "https://a.example/v1", apiKey: "secret-a", models: ["same"] });
    const b = store.add({ name: "B", baseURL: "https://b.example/v1/", apiKey: "secret-b", models: ["same"] });
    expect(JSON.stringify(store.list())).not.toContain("secret-");
    expect(new ProviderStore(file).models()).toEqual([`${a.id}::same`, `${b.id}::same`]);
    const seen: Array<{ url: string; key: string | null; model: string; stream: boolean }> = [];
    const client = createModelClient({ maxRetries: 0 }, store, (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(url), key: new Headers(init?.headers).get("authorization"), model: body.model, stream: body.stream ?? false });
      return new Response(JSON.stringify({ id: "test", choices: [], usage: {} }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    for (const id of [a.id, b.id]) await client.chat.completions.create({ model: `${id}::same`, messages: [{ role: "user", content: "test" }] });
    expect(seen.map(s => s.url)).toEqual(["https://a.example/v1/chat/completions", "https://b.example/v1/chat/completions"]);
    expect(seen.map(s => s.key)).toEqual(["Bearer secret-a", "Bearer secret-b"]);
    expect(seen.every(s => s.model === "same")).toBe(true);
    store.remove(a.id);
    expect(() => store.resolve(`${a.id}::same`)).toThrow("已删除");
    expect(store.resolve("default-model")).toBeUndefined();
    expect(() => store.add({ name: "bad", baseURL: "file:///tmp", apiKey: "k", models: ["m"] })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("辅助通道端点：模型前缀 > 主供应商兜底 > OPENAI_*", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-aux-"));
  const prevBase = process.env.OPENAI_BASE_URL;
  const prevKey = process.env.OPENAI_API_KEY;
  try {
    const store = new ProviderStore(path.join(dir, "providers.json"));
    const main = store.add({ name: "main", baseURL: "https://main.example/v1", apiKey: "main-key", models: ["chat"] });
    const aux = store.add({ name: "aux", baseURL: "https://aux.example/v1", apiKey: "aux-key", models: ["embed"] });
    process.env.OPENAI_BASE_URL = "https://env.example/v1";
    process.env.OPENAI_API_KEY = "env-key";

    // 辅助模型自带前缀：用它的供应商，并把前缀从请求模型名里剥掉
    expect(resolveAuxEndpoint({ model: `${aux.id}::embed`, mainModel: `${main.id}::chat` }, store))
      .toEqual({ model: "embed", baseURL: "https://aux.example/v1", apiKey: "aux-key" });
    // 没前缀：复用主模型供应商的地址/Key，辅助模型名保持原样
    expect(resolveAuxEndpoint({ model: "embedding-x", mainModel: `${main.id}::chat` }, store))
      .toEqual({ model: "embedding-x", baseURL: "https://main.example/v1", apiKey: "main-key" });
    // 专用变量优先于前缀与主供应商
    expect(resolveAuxEndpoint({ model: `${aux.id}::embed`, baseURL: "https://explicit/v1", apiKey: "explicit-key" }, store))
      .toEqual({ model: "embed", baseURL: "https://explicit/v1", apiKey: "explicit-key" });
    // 都没有才回退 OPENAI_*
    expect(resolveAuxEndpoint({ model: "embedding-x", mainModel: "plain-model" }, store))
      .toEqual({ model: "embedding-x", baseURL: "https://env.example/v1", apiKey: "env-key" });
    expect(() => resolveAuxEndpoint({ model: "gone::embed" }, store)).toThrow("已删除");
  } finally {
    if (prevBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模型显示开关：只从清单剔除，已选用模型仍可路由", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-toggle-"));
  try {
    const file = path.join(dir, "providers.json");
    const store = new ProviderStore(file);
    const p = store.add({ name: "C", baseURL: "https://c.example/v1", apiKey: "k", models: ["alpha", "beta"] });
    expect(store.models()).toEqual([`${p.id}::alpha`, `${p.id}::beta`]);
    expect(store.setEnabledModels(p.id, ["beta"]).models).toEqual([{ id: "alpha", enabled: false }, { id: "beta", enabled: true }]);
    // 落盘后重开仍然生效（老文件没有 hidden 字段 = 全部显示）
    expect(new ProviderStore(file).models()).toEqual([`${p.id}::beta`]);
    expect(new ProviderStore(file).list()[0]?.models).toEqual([{ id: "alpha", enabled: false }, { id: "beta", enabled: true }]);
    // 已选中的会话不会被开关踢掉
    expect(store.resolve(`${p.id}::alpha`)?.model).toBe("alpha");
    expect(() => store.setEnabledModels(p.id, ["alpha", "gamma"])).toThrow("不在该供应商");
    expect(() => store.setEnabledModels("missing", [])).toThrow("供应商不存在");
    expect(store.setEnabledModels(p.id, ["alpha", "beta"]).models.every(m => m.enabled)).toBe(true);
    expect(store.models()).toEqual([`${p.id}::alpha`, `${p.id}::beta`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("默认真实路径不跟进程 cwd 走，AGENT_DATA_DIR 可覆盖", () => {
  const elsewhere = mkdtempSync(path.join(tmpdir(), "provider-cwd-"));
  const prev = process.env.AGENT_DATA_DIR;
  try {
    process.env.AGENT_DATA_DIR = path.join(elsewhere, "override-data");
    expect(new ProviderStore().file).toBe(path.join(process.env.AGENT_DATA_DIR, "providers.json"));
    delete process.env.AGENT_DATA_DIR;
    // 换一个完全无关的 cwd 起子进程：同一个路径 = 锚在代码目录，而不是 process.cwd()
    const mod = path.resolve(import.meta.dir, "..", "src", "core", "providers.ts").split(path.sep).join("/");
    const probe = path.join(elsewhere, "probe.ts");
    writeFileSync(probe, `import { providersFile } from ${JSON.stringify(mod)}; console.log(providersFile());`);
    const out = Bun.spawnSync(["bun", "run", probe], { cwd: elsewhere }).stdout.toString().trim();
    expect(out).toBe(providersFile());
    expect(out).not.toContain(elsewhere);
    expect(path.basename(path.dirname(out))).toBe(".agent-data");
  } finally {
    if (prev === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = prev;
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("配置带 BOM 仍能读；坏 JSON 报错点名文件，启动自检不抛", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "provider-corrupt-"));
  const file = path.join(dir, "providers.json");
  try {
    // Windows 记事本"另存为 UTF-8"会在开头塞 BOM：合法 JSON 照样要能读出来
    writeFileSync(file, "\uFEFF" + JSON.stringify([{ id: "x", name: "x", baseURL: "https://x.example/v1", apiKey: "k", models: ["m"] }]));
    expect(new ProviderStore(file).models()).toEqual(["x::m"]);
    writeFileSync(file, "{ not json");
    expect(() => new ProviderStore(file).list()).toThrow(file);
    expect(() => new ProviderStore(file).models()).toThrow("再重启服务");
    // describe 是启动日志用的，读不动也不能抛
    expect(new ProviderStore(file).describe()).toContain("读取失败");
    expect(new ProviderStore(path.join(dir, "missing.json")).describe()).toContain("还没有添加供应商");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
