import { test, expect } from "bun:test";
import { createProbeCache } from "../src/server/model_probe_cache";
import { candidateModels, classifyProbeError } from "../src/core/model_probe";

test("缓存合并并发刷新，完成后计时，过期重新加载", async () => {
  let calls = 0, time = 0;
  const load = createProbeCache(async () => ++calls, 60, () => time);
  const first = load(undefined);
  expect(load(undefined)).toBe(first);
  expect(await first).toBe(1);
  time = 59;
  expect(await load(undefined)).toBe(1);
  time = 60;
  const refresh = load(undefined);
  expect(load(undefined)).toBe(refresh);
  expect(await refresh).toBe(2);
});

test("失败清理进行中任务，允许重试", async () => {
  let calls = 0;
  const load = createProbeCache(async () => { if (++calls === 1) throw new Error("failed"); return calls; });
  await expect(load(undefined)).rejects.toThrow("failed");
  expect(await load(undefined)).toBe(2);
});

test("错误码优先于模糊 quota 文案", () => {
  for (const [code, status, kind] of [
    ["AllocationQuota.FreeTierOnly", 403, "quota"],
    ["AccessDenied.Unpurchased", 403, "unavailable"],
    ["Throttling.RateQuota", 429, "error"],
    ["Arrearage", 403, "unavailable"],
    ["insufficient_quota", 429, "quota"],
  ] as const) {
    expect(classifyProbeError(Object.assign(new Error("quota exceeded"), { status, error: { code } })).kind).toBe(kind);
  }
  expect(classifyProbeError(Object.assign(new Error("Forbidden"), { status: 403 })).kind).toBe("unavailable");
});

test("候选只来自显式配置并去重", () => {
  const old = process.env.AGENT_UI_MODELS;
  try {
    process.env.AGENT_UI_MODELS = " main, extra, extra ";
    expect(candidateModels({ model: "main", summaryModel: "summary" })).toEqual(["main", "summary", "extra"]);
  } finally {
    if (old === undefined) delete process.env.AGENT_UI_MODELS;
    else process.env.AGENT_UI_MODELS = old;
  }
});
