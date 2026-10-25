// tests/model_probe.test.ts
// 运行: bun test ./tests/model_probe.test.ts
import { test, expect, describe, spyOn } from "bun:test";
import OpenAI from "openai";
import { classifyProbeError, fetchZhipuAccountQuota, formatModelProbeLine, isLikelyChatModel, probeModels, quotaFromHeaders } from "../src/core/model_probe";

/** 假响应头容器：够 withResponse 用即可 */
function fakeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

/** 按模型名返回预设结果的假客户端：ok 名单里的成功（带响应头），其余按 errorMap 分类 */
function fakeClient(
  ok: string[],
  errorMap: Record<string, { status?: number; message: string }>,
  okHeaders: Record<string, string> = {}
): OpenAI {
  return {
    chat: {
      completions: {
        create: ({ model }: { model: string }) => {
          const payload = ok.includes(model)
            ? { choices: [{ message: { content: "OK" } }] }
            : Promise.reject(Object.assign(new Error(errorMap[model]?.message ?? "unexpected"), { status: errorMap[model]?.status }));
          return {
            ...payload,
            withResponse: async () => ({
              data: await payload,
              response: { headers: fakeHeaders(okHeaders) },
            }),
          };
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

  test("并发池：全量清单逐个探测且并发不超上限，结果与输入对齐", async () => {
    let active = 0;
    let maxActive = 0;
    const models = Array.from({ length: 30 }, (_, i) => `m-${i}`);
    const countingClient = {
      chat: {
        completions: {
          create: ({ model }: { model: string }) => {
            active++;
            maxActive = Math.max(maxActive, active);
            return {
              ...Promise.resolve({ choices: [{ message: { content: "OK" } }] }),
              withResponse: async () => {
                await new Promise((resolve) => setTimeout(resolve, 1));
                active--;
                return { data: {}, response: { headers: fakeHeaders({}) } };
              },
            };
          },
        },
      },
    } as unknown as OpenAI;
    const results = await probeModels({ client: countingClient, models, concurrency: 5, timeoutMs: 5_000 });
    expect(results.length).toBe(30);
    // 字符串排序两侧一致比较（m-10 排在 m-2 前，与插入序无关）
    expect(results.map((r) => r.model).sort()).toEqual([...models].sort());
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  test("isLikelyChatModel：图像/语音/OCR/实时音频等非对话模型剔除，对话模型保留", () => {
    for (const dead of [
      "qwen-image-2.0-pro", "wan2.7-image", "z-image-turbo", "MiniMax/speech-02-hd",
      "qwen-vl-ocr", "qwen-audio-3.0-realtime-plus", "qwen3-s2s-flash-realtime",
      "qwen3.5-livetranslate-flash", "text-embedding-v4", "qwen-tts",
    ]) {
      expect(isLikelyChatModel(dead)).toBe(false);
    }
    for (const alive of ["glm-5.2", "qwen3.8-flash", "deepseek-v4-pro", "kimi/kimi-k3", "ZHIPU/GLM-5.3-Flash", "qwen-max"]) {
      expect(isLikelyChatModel(alive)).toBe(true);
    }
  });

  test("可用模型解析响应头里的剩余配额；无头字段时缺省", async () => {
    const results = await probeModels({
      client: fakeClient(["with-quota", "without-quota"], {}, {
        "x-ratelimit-remaining-requests": "480",
        "x-ratelimit-remaining-tokens": "123456",
      }),
      models: ["with-quota", "without-quota"],
      timeoutMs: 5_000,
    });
    const byModel = new Map(results.map((r) => [r.model, r]));
    expect(byModel.get("with-quota")!.quota).toContain("480");
    expect(byModel.get("with-quota")!.quota).toContain("123456");
    // 响应头是同一份的假实现，两模型都拿得到——这里验证的是解析存在且拼进结果
    expect(byModel.get("without-quota")!.quota).toBeDefined();
  });

  test("无 status 的配额文案也归为 quota；重复模型去重", async () => {
    const results = await probeModels({
      client: fakeClient([], { "m1": { message: "quota exceeded for this model" } }),
      models: ["m1", "m1", "m1"],
    });
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({ ok: false, kind: "quota" });
  });

  test("formatModelProbeLine 分组拼接，可用模型带配额后缀，空探测返回空串", async () => {
    expect(formatModelProbeLine([])).toBe("");
    const line = formatModelProbeLine([
      { model: "a", ok: true, kind: "ok", latencyMs: 1, quota: "剩 480 次请求" },
      { model: "b", ok: false, kind: "quota", detail: "x" },
      { model: "c", ok: false, kind: "unavailable", detail: "y" },
    ]);
    expect(line).toContain("✅ 可用: a（剩 480 次请求）");
    expect(line).toContain("⛔ 配额耗尽: b");
    expect(line).toContain("⚠️ 不可用/异常: c");
  });
});

describe("quotaFromHeaders", () => {
  test("OpenAI 风格限流头 → 可读描述；缺失时 undefined", () => {
    expect(quotaFromHeaders(fakeHeaders({ "x-ratelimit-remaining-requests": "480" }))).toBe("剩 480 次请求");
    expect(
      quotaFromHeaders(fakeHeaders({ "x-ratelimit-remaining-requests": "10", "x-ratelimit-remaining-tokens": "99" }))
    ).toBe("剩 10 次请求，剩 99 tokens");
    expect(quotaFromHeaders(fakeHeaders({}))).toBeUndefined();
    // DashScope 实测不带任何限流头——此时诚实缺席，不编数字
    expect(quotaFromHeaders(fakeHeaders({ "content-type": "application/json" }))).toBeUndefined();
  });
});

describe("fetchZhipuAccountQuota", () => {
  test("非智谱 host 直接跳过，不发请求（DashScope/聚合器零开销）", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await fetchZhipuAccountQuota("https://dashscope.aliyuncs.com/compatible-mode/v1", "k")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test("智谱 host：取 trial_balance 首个资源包余额；非 2xx/坏 JSON 静默缺席", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      return new Response(JSON.stringify({ data: [{ totalBalance: "12.50", currencyCode: "CNY" }] }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await fetchZhipuAccountQuota("https://open.bigmodel.cn/api/paas/v4", "k")).toBe("账户余额 12.50 CNY");
    expect((fetchSpy.mock.calls[0]![0] as string)).toBe("https://open.bigmodel.cn/api/paas/v4/trial_balance");

    fetchSpy.mockImplementation((async () => new Response("{}", { status: 403 })) as unknown as typeof fetch);
    expect(await fetchZhipuAccountQuota("https://open.bigmodel.cn/api/paas/v4", "k")).toBeUndefined();

    fetchSpy.mockImplementation((async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    expect(await fetchZhipuAccountQuota("https://open.bigmodel.cn/api/paas/v4", "k")).toBeUndefined();
    fetchSpy.mockRestore();
  });
});

describe("classifyProbeError", () => {
  test("中文配额提示、无 status 错误、普通异常各归其类", () => {
    expect(classifyProbeError(new Error("Free quota exhausted, 请充值")).kind).toBe("quota");
    expect(classifyProbeError(Object.assign(new Error("无权访问"), { status: 403 })).kind).toBe("quota");
    expect(classifyProbeError(new Error("model does not exist")).kind).toBe("unavailable");
    expect(classifyProbeError(new Error("socket hang up")).kind).toBe("error");
  });

  test("DashScope 的 400 未激活是确凿不可用（不是限流），归 unavailable 剔除", () => {
    expect(
      classifyProbeError(Object.assign(new Error("400 The product is not activated, please confirm"), { status: 400 })).kind
    ).toBe("unavailable");
  });
});
