// tests/model_probe.test.ts
// 运行: bun test ./tests/model_probe.test.ts
import { test, expect, describe } from "bun:test";
import OpenAI from "openai";
import { classifyProbeError, formatModelProbeLine, probeModels } from "../src/core/model_probe";

/** 按模型名返回预设结果的假客户端：ok 名单里的成功，其余按 errorMap 分类 */
function fakeClient(ok: string[], errorMap: Record<string, { status?: number; message: string }>): OpenAI {
  return {
    chat: {
      completions: {
        create: async ({ model }: { model: string }) => {
          if (ok.includes(model)) {
            return { choices: [{ message: { content: "OK" } }] };
          }
          const preset = errorMap[model];
          if (!preset) throw new Error(`unexpected model ${model}`);
          throw Object.assign(new Error(preset.message), { status: preset.status });
        },
      },
    },
  } as unknown as OpenAI;
}

describe("probeModels", () => {
  test("按错误分类：可用 / 配额耗尽 / 模型不可用 / 其它异常", async () => {
    const results = await probeModels({
      client: fakeClient(["model-ok"], {
        "model-quota": { status: 403, message: "403 Free quota exhausted." },
        "model-404": { status: 404, message: "404 The model `x` does not exist." },
        "model-500": { status: 500, message: "500 Internal Server Error" },
      }),
      models: ["model-ok", "model-quota", "model-404", "model-500"],
      timeoutMs: 5_000,
    });
    const byModel = new Map(results.map((r) => [r.model, r]));
    expect(byModel.get("model-ok")).toMatchObject({ ok: true, kind: "ok" });
    expect(byModel.get("model-quota")).toMatchObject({ ok: false, kind: "quota" });
    expect(byModel.get("model-404")).toMatchObject({ ok: false, kind: "unavailable" });
    expect(byModel.get("model-500")).toMatchObject({ ok: false, kind: "error" });
  });

  test("无 status 的配额文案也归为 quota；重复模型去重", async () => {
    const results = await probeModels({
      client: fakeClient([], { "m1": { message: "quota exceeded for this model" } }),
      models: ["m1", "m1", "m1"],
    });
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ ok: false, kind: "quota" });
  });

  test("formatModelProbeLine 分组拼接，空探测返回空串", async () => {
    expect(formatModelProbeLine([])).toBe("");
    const line = formatModelProbeLine([
      { model: "a", ok: true, kind: "ok", latencyMs: 1 },
      { model: "b", ok: false, kind: "quota", detail: "x" },
      { model: "c", ok: false, kind: "unavailable", detail: "y" },
    ]);
    expect(line).toContain("✅ 可用: a");
    expect(line).toContain("⛔ 配额耗尽: b");
    expect(line).toContain("⚠️ 不可用/异常: c");
  });
});

describe("classifyProbeError", () => {
  test("中文配额提示、无 status 错误、普通异常各归其类", () => {
    expect(classifyProbeError(new Error("Free quota exhausted, 请充值")).kind).toBe("quota");
    expect(classifyProbeError(Object.assign(new Error("无权访问"), { status: 403 })).kind).toBe("quota");
    expect(classifyProbeError(new Error("model does not exist")).kind).toBe("unavailable");
    expect(classifyProbeError(new Error("socket hang up")).kind).toBe("error");
  });
});
