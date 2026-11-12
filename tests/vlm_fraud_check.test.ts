// vlm_fraud_check 工具测试：模板保真 / JSON 校验重试 / 失败询问闩锁 / 付费回退 /
// 并发闸门 / 路径守卫 / URL 下载 / 配置与体检。
// 运行: bun test ./tests/vlm_fraud_check.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createVlmFraudCheckTool, scannerVlmEnabled, loadVlmOptions,
  parseFraudResult, probeVlmEndpoint, VLM_FRAUD_CHECK_TOOL_NAME,
} from "../src/tools/vlm_fraud_check";
import { ProviderStore } from "../src/core/providers";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const VALID_JSON = '{"image_description":"一张聊天截图","fraud_details":"图中含刷单返利话术","contains_fraud":true}';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

async function workspaceWithImage(): Promise<{ dir: string; rel: string }> {
  const dir = await tempDir("vlm-ws-");
  const rel = path.join("images", "BV1test", "pic0.jpg");
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), PNG_1PX);
  return { dir, rel };
}

const okResponse = (content: string) => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** 按请求序号脚本化应答：可返回响应、抛错或延迟；记录全部请求体 */
function fakeClient(handler: (index: number, params: any) => any) {
  const requests: any[] = [];
  const client: any = {
    chat: {
      completions: {
        create: async (params: any) => {
          requests.push(params);
          return handler(requests.length, params);
        },
      },
    },
  };
  return { client, requests };
}

function makeTool(dir: string, client: any, extra: Record<string, unknown> = {}) {
  return createVlmFraudCheckTool({
    sandboxRoot: dir, client, model: "vllm-test::fraud-vlm",
    fallbackModel: "qwen3-vl-plus", timeoutMs: 5_000,
    now: () => new Date(2026, 10, 12),
    ...extra,
  });
}

test("模板保真：comment 变体三段 content、中文日期、system 人设", async () => {
  const { dir, rel } = await workspaceWithImage();
  const { client, requests } = fakeClient(() => okResponse(VALID_JSON));
  const tool = makeTool(dir, client);
  const result: any = await tool.execute({ image: rel, text: "加我微信带你赚钱" });

  expect(result.ok).toBe(true);
  expect(result.contains_fraud).toBe(true);
  expect(result.image_description).toBe("一张聊天截图");
  expect(result.model).toBe("vllm-test::fraud-vlm");
  expect(result.used_fallback).toBe(false);

  const params = requests[0];
  expect(params.model).toBe("vllm-test::fraud-vlm");
  const system = params.messages[0];
  expect(system.role).toBe("system");
  expect(system.content.startsWith("今天是2026年11月12日。")).toBe(true);
  expect(system.content).toContain("短视频与社交平台安全审核专家");
  const parts = params.messages[1].content;
  expect(parts[0]).toEqual({ type: "text", text: "用户评论图片：" });
  expect(parts[1].type).toBe("image_url");
  expect(parts[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  expect(parts[2].text.startsWith("\n评论内容：加我微信带你赚钱。请仔细观察并分析传入的图片和上面的文字")).toBe(true);
  expect(parts[2].text).toContain('"contains_fraud": true/false');
  expect(JSON.stringify(result)).not.toContain("base64");
  await fs.rm(dir, { recursive: true, force: true });
});

test("模板保真：cover 变体用标题", async () => {
  const { dir, rel } = await workspaceWithImage();
  const { client, requests } = fakeClient(() => okResponse(VALID_JSON));
  const tool = makeTool(dir, client);
  await tool.execute({ image: rel, text: "日入过千的项目", kind: "cover" });
  const parts = requests[0].messages[1].content;
  expect(parts[0].text).toBe("视频封面图片：");
  expect(parts[2].text.startsWith("\n标题：日入过千的项目。")).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("围栏包裹与前后解释文字都能解析", () => {
  expect(parseFraudResult("```json\n" + VALID_JSON + "\n```")).toEqual(JSON.parse(VALID_JSON));
  expect(parseFraudResult("分析如下：\n" + VALID_JSON + "\n以上。")).toEqual(JSON.parse(VALID_JSON));
  expect(parseFraudResult("不是 JSON")).toBeUndefined();
  expect(parseFraudResult('{"image_description":"x","fraud_details":"y","contains_fraud":"yes"}')).toBeUndefined();
  expect(parseFraudResult('{"image_description":"x","contains_fraud":true}')).toBeUndefined();
});

test("输出不合格：原样重试一次后成功；两次都不合格返回 ok:false 且不问用户", async () => {
  const { dir, rel } = await workspaceWithImage();
  let asked = 0;
  const runtime = { askUser: async () => { asked += 1; return "停止"; } };

  const bad = fakeClient((i) => okResponse(i === 1 ? "抱歉我无法输出" : VALID_JSON));
  const tool1 = makeTool(dir, bad.client);
  const r1: any = await tool1.execute({ image: rel, text: "t" }, runtime);
  expect(r1.ok).toBe(true);
  expect(bad.requests.length).toBe(2);
  expect(bad.requests[0].messages).toEqual(bad.requests[1].messages);
  expect(bad.requests[0].model).toBe(bad.requests[1].model);

  const bothBad = fakeClient(() => okResponse("不是 JSON"));
  const tool2 = makeTool(dir, bothBad.client);
  const r2: any = await tool2.execute({ image: rel, text: "t" }, runtime);
  expect(r2.ok).toBe(false);
  expect(r2.error).toContain("两次输出均不合格");
  expect(bothBad.requests.length).toBe(2);
  expect(asked).toBe(0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("传输失败 + 用户选付费继续：回退模型接管，后续调用直走回退不再问", async () => {
  const { dir, rel } = await workspaceWithImage();
  let asked = 0;
  const runtime = { askUser: async (prompt: string) => { asked += 1; expect(prompt).toContain("付费继续"); return "付费继续"; } };
  const { client, requests } = fakeClient((_i, params) => {
    if (params.model === "vllm-test::fraud-vlm") throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    return okResponse(VALID_JSON);
  });
  const tool = makeTool(dir, client);

  const r1: any = await tool.execute({ image: rel, text: "t" }, runtime);
  expect(r1.ok).toBe(true);
  expect(r1.used_fallback).toBe(true);
  expect(r1.model).toBe("qwen3-vl-plus");
  expect(asked).toBe(1);

  const r2: any = await tool.execute({ image: rel, text: "t" }, runtime);
  expect(r2.ok).toBe(true);
  expect(asked).toBe(1);
  expect(requests.map((r: any) => r.model)).toEqual(["vllm-test::fraud-vlm", "qwen3-vl-plus", "qwen3-vl-plus"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("传输失败 + 用户选停止：抛错并要求结束扫描，后续调用零请求快速失败", async () => {
  const { dir, rel } = await workspaceWithImage();
  const runtime = { askUser: async () => "停止" };
  const { client, requests } = fakeClient(() => { throw new Error("timeout"); });
  const tool = makeTool(dir, client);
  await expect(tool.execute({ image: rel, text: "t" }, runtime)).rejects.toThrow("用户选择停止扫描");
  await expect(tool.execute({ image: rel, text: "t" }, runtime)).rejects.toThrow("已选择停止");
  expect(requests.length).toBe(1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("传输失败且无 askUser 通道：默认停止，绝不静默付费", async () => {
  const { dir, rel } = await workspaceWithImage();
  const { client, requests } = fakeClient(() => { throw new Error("502 Bad Gateway"); });
  const tool = makeTool(dir, client);
  await expect(tool.execute({ image: rel, text: "t" })).rejects.toThrow("不支持询问用户");
  expect(requests.length).toBe(1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("run 级闩锁：并发失败只问一次，共享同一应答", async () => {
  const { dir, rel } = await workspaceWithImage();
  let asked = 0;
  const runtime = {
    askUser: async () => { asked += 1; await Bun.sleep(20); return "付费继续"; },
  };
  const { client } = fakeClient((_i, params) => {
    if (params.model === "vllm-test::fraud-vlm") throw new Error("ECONNREFUSED");
    return okResponse(VALID_JSON);
  });
  const tool = makeTool(dir, client);
  const results = await Promise.all([
    tool.execute({ image: rel, text: "a" }, runtime),
    tool.execute({ image: rel, text: "b" }, runtime),
    tool.execute({ image: rel, text: "c" }, runtime),
  ]) as any[];
  expect(asked).toBe(1);
  for (const r of results) { expect(r.ok).toBe(true); expect(r.used_fallback).toBe(true); }
  await fs.rm(dir, { recursive: true, force: true });
});

test("并发闸门：在飞请求不超过 concurrency", async () => {
  const { dir, rel } = await workspaceWithImage();
  let inFlight = 0;
  let maxInFlight = 0;
  const { client } = fakeClient(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(15);
    inFlight -= 1;
    return okResponse(VALID_JSON);
  });
  const tool = makeTool(dir, client, { concurrency: 2 });
  await Promise.all(Array.from({ length: 6 }, (_v, i) => tool.execute({ image: rel, text: `t${i}` })));
  expect(maxInFlight).toBeLessThanOrEqual(2);
  expect(maxInFlight).toBeGreaterThan(0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("路径守卫：越出工作区 / 不存在 / 非图片都拒绝，且不触发询问", async () => {
  const { dir, rel } = await workspaceWithImage();
  let asked = 0;
  const runtime = { askUser: async () => { asked += 1; return "付费继续"; } };
  const { client, requests } = fakeClient(() => okResponse(VALID_JSON));
  const tool = makeTool(dir, client);

  const outside = await tempDir("vlm-out-");
  await fs.writeFile(path.join(outside, "x.png"), PNG_1PX);
  await expect(tool.execute({ image: path.join(outside, "x.png"), text: "t" }, runtime)).rejects.toThrow("越出工作区");
  await expect(tool.execute({ image: "../escape.png", text: "t" }, runtime)).rejects.toThrow("越出工作区");
  await expect(tool.execute({ image: "images/nope.jpg", text: "t" }, runtime)).rejects.toThrow("不存在");
  await fs.writeFile(path.join(dir, "fake.png"), "not an image");
  await expect(tool.execute({ image: "fake.png", text: "t" }, runtime)).rejects.toThrow("不是支持的图片格式");
  expect(requests.length).toBe(0);
  expect(asked).toBe(0);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test("URL 图片：下载后内联 base64；下载失败是输入错误不触发询问", async () => {
  const { dir } = await workspaceWithImage();
  const savedFetch = globalThis.fetch;
  let asked = 0;
  const runtime = { askUser: async () => { asked += 1; return "停止"; } };
  const { client, requests } = fakeClient(() => okResponse(VALID_JSON));
  const tool = makeTool(dir, client);
  try {
    globalThis.fetch = (async (input: any) => {
      if (String(input).includes("ok.png")) return new Response(PNG_1PX, { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const r: any = await tool.execute({ image: "https://example.com/ok.png", text: "t" }, runtime);
    expect(r.ok).toBe(true);
    expect(requests[0].messages[1].content[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);

    await expect(tool.execute({ image: "https://example.com/missing.png", text: "t" }, runtime)).rejects.toThrow("HTTP 404");
    expect(asked).toBe(0);
  } finally {
    globalThis.fetch = savedFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scannerVlmEnabled：1/true/on/yes 开，其余关", () => {
  for (const value of ["1", "true", "ON", " yes "]) expect(scannerVlmEnabled({ AGENT_SCANNER_VLLM: value })).toBe(true);
  for (const value of ["0", "false", "off", "", "2"]) expect(scannerVlmEnabled({ AGENT_SCANNER_VLLM: value })).toBe(false);
  expect(scannerVlmEnabled({})).toBe(false);
});

test("loadVlmOptions：默认值、env 覆盖、缺 model 报错", () => {
  expect(loadVlmOptions({ AGENT_VLLM_MODEL: "p::m" })).toEqual({
    model: "p::m", fallbackModel: "qwen3-vl-plus", concurrency: 4, timeoutMs: 120_000,
  });
  expect(loadVlmOptions({
    AGENT_VLLM_MODEL: "p::m", AGENT_VLLM_FALLBACK_MODEL: "other", AGENT_VLLM_CONCURRENCY: "8", AGENT_VLLM_TIMEOUT_MS: "60000",
  })).toEqual({ model: "p::m", fallbackModel: "other", concurrency: 8, timeoutMs: 60_000 });
  expect(() => loadVlmOptions({})).toThrow("AGENT_VLLM_MODEL");
  expect(() => loadVlmOptions({ AGENT_VLLM_MODEL: "no-prefix" })).toThrow("AGENT_VLLM_MODEL");
});

test("probeVlmEndpoint：200 通过；5xx / 连接失败 / 供应商缺失报错", async () => {
  const dir = await tempDir("vlm-probe-");
  const store = new ProviderStore(path.join(dir, "providers.json"));
  const info = store.add({ name: "vllm", baseURL: "http://127.0.0.1:8000/v1", apiKey: "secret", models: ["fraud-vlm"] });
  const model = `${info.id}::fraud-vlm`;

  const seen: Array<{ url: string; auth: string | null }> = [];
  const okFetcher = (async (input: any, init: any) => {
    seen.push({ url: String(input), auth: new Headers(init.headers).get("authorization") });
    return new Response('{"data":[]}', { status: 200 });
  }) as typeof fetch;
  await probeVlmEndpoint(model, { store, fetcher: okFetcher });
  expect(seen[0]!.url).toBe("http://127.0.0.1:8000/v1/models");
  expect(seen[0]!.auth).toBe("Bearer secret");

  const badFetcher = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
  await expect(probeVlmEndpoint(model, { store, fetcher: badFetcher })).rejects.toThrow("HTTP 503");

  const downFetcher = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  await expect(probeVlmEndpoint(model, { store, fetcher: downFetcher })).rejects.toThrow("SSH 隧道");

  await expect(probeVlmEndpoint("ghost::m", { store, fetcher: okFetcher })).rejects.toThrow("不存在");
  await fs.rm(dir, { recursive: true, force: true });
});

test("工具元数据：名称 / parallelSafe / 自管超时", () => {
  const tool = createVlmFraudCheckTool({ model: "p::m", client: fakeClient(() => okResponse(VALID_JSON)).client });
  expect(tool.name).toBe(VLM_FRAUD_CHECK_TOOL_NAME);
  expect(tool.parallelSafe).toBe(true);
  expect(tool.timeoutMs).toBe(0);
  expect(tool.needsReconciliation).toBe(false);
});