import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderStore, createModelClient } from "../src/core/providers";

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
