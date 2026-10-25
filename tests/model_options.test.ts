// tests/model_options.test.ts
// 运行: bun test ./tests/model_options.test.ts
// 纯函数测试：web/src/lib/modelOptions.ts 的下拉过滤逻辑（bun 直接跑 TS，无 DOM）
import { test, expect, describe } from "bun:test";
import { firstAvailableModel, visibleModelOptions } from "../web/src/lib/modelOptions";
import type { ModelProbeStatus } from "../src/server/protocol";

const probe = (model: string, kind: ModelProbeStatus["kind"], ok: boolean): ModelProbeStatus => ({ model, ok, kind });

describe("visibleModelOptions", () => {
  const models = ["glm-5.2", "qwen3.8-flash", "deepseek-v4-pro", "kimi-k3", "qwen-max"];
  const status: ModelProbeStatus[] = [
    probe("glm-5.2", "quota", false),
    probe("qwen3.8-flash", "ok", true),
    probe("deepseek-v4-pro", "ok", true),
    probe("kimi-k3", "error", false), // 429/网络等不确定结果
  ];

  test("配额耗尽/不可用的剔除，未探测与不确定结果的保留", () => {
    // glm-5.2 是 activeModel（死模型保留在列表尾），qwen-max 未探测保留
    const visible = visibleModelOptions(models, status, "glm-5.2");
    expect(visible).toEqual(["qwen3.8-flash", "deepseek-v4-pro", "kimi-k3", "qwen-max", "glm-5.2"]);
  });

  test("非激活的死模型直接剔除", () => {
    const visible = visibleModelOptions(models, status, "qwen3.8-flash");
    expect(visible).toEqual(["qwen3.8-flash", "deepseek-v4-pro", "kimi-k3", "qwen-max"]);
    expect(visible).not.toContain("glm-5.2");
  });

  test("没有探测数据时全量保留", () => {
    expect(visibleModelOptions(models, undefined)).toEqual(models);
  });
});

describe("firstAvailableModel", () => {
  test("跳过配额耗尽的，落到第一个可用模型", () => {
    const models = ["glm-5.2", "qwen3.8-flash", "deepseek-v4-pro"];
    const status: ModelProbeStatus[] = [
      probe("glm-5.2", "quota", false),
      probe("qwen3.8-flash", "ok", true),
      probe("deepseek-v4-pro", "ok", true),
    ];
    expect(firstAvailableModel(models, status)).toBe("qwen3.8-flash");
  });

  test("全都没有探测数据时取第一个", () => {
    expect(firstAvailableModel(["a", "b"], undefined)).toBe("a");
  });
});
