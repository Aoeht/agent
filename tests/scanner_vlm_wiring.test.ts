// 接线测试：createScannerRegistry 的 env opt-in + 体检 + 挂载，scannerCapabilities 动态声明，
// delegate_task 仅对 scanner 放行 askUser。
// 运行: bun test ./tests/scanner_vlm_wiring.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { defineTool, type ToolRuntime } from "../src/core/types";
import { ProviderStore } from "../src/core/providers";
import { createScannerRegistry, scannerCapabilities, SCANNER_CAPABILITIES } from "../src/team_runtime";
import { createDelegateTaskTool } from "../src/tools/delegate_task";
import { VLM_FRAUD_CHECK_TOOL_NAME } from "../src/tools/vlm_fraud_check";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const VALID_JSON = '{"image_description":"截图","fraud_details":"刷单话术","contains_fraud":true}';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

function fakeTool(name: string, execute?: (args: unknown, runtime?: ToolRuntime) => Promise<unknown>) {
  return defineTool({
    name, description: `${name} 假工具`, schema: z.object({}), parallelSafe: true,
    execute: execute ?? (async () => "结果"),
  });
}

function sourceRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of ["bili_collect", "read_image", "inspect_link", "rag_search", "ingest_findings"]) {
    registry.register(fakeTool(name));
  }
  registry.register(fakeTool("run_script"));
  return registry;
}

const okFetcher = (async () => new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch;
const downFetcher = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

function fakeClient() {
  const client: any = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: VALID_JSON }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) } },
  };
  return client;
}

async function vlmFixture() {
  const dir = await tempDir("vlm-wire-");
  const store = new ProviderStore(path.join(dir, "providers.json"));
  const info = store.add({ name: "vllm", baseURL: "http://127.0.0.1:8000/v1", apiKey: "k", models: ["fraud-vlm"] });
  const env = { AGENT_SCANNER_VLLM: "1", AGENT_VLLM_MODEL: `${info.id}::fraud-vlm` };
  await fs.writeFile(path.join(dir, "pic.png"), PNG_1PX);
  return { dir, store, env };
}

test("opt-in 默认关：scanner 注册表没有 vlm_fraud_check，白名单原样", async () => {
  const registry = await createScannerRegistry(sourceRegistry(), new PlanStore(), { env: {} });
  expect(registry.get(VLM_FRAUD_CHECK_TOOL_NAME)).toBeUndefined();
  expect(registry.get("bili_collect")).toBeDefined();
  expect(registry.get("run_script")).toBeUndefined();
});

test("opt-in 开 + 体检通过：挂载且可端到端调用（注入 client/store/fetcher）", async () => {
  const { dir, store, env } = await vlmFixture();
  const registry = await createScannerRegistry(sourceRegistry(), new PlanStore(), {
    sandboxRoot: dir, env, vlm: { client: fakeClient(), store, fetcher: okFetcher },
  });
  const tool = registry.get(VLM_FRAUD_CHECK_TOOL_NAME);
  expect(tool).toBeDefined();
  const result: any = await tool!.execute({ image: "pic.png", text: "加微信" });
  expect(result.ok).toBe(true);
  expect(result.contains_fraud).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("opt-in 开 + 体检不通：注册立刻失败，不拖到扫描中途", async () => {
  const { dir, store, env } = await vlmFixture();
  await expect(createScannerRegistry(sourceRegistry(), new PlanStore(), {
    sandboxRoot: dir, env, vlm: { store, fetcher: downFetcher },
  })).rejects.toThrow("体检失败");
  await fs.rm(dir, { recursive: true, force: true });
});

test("opt-in 开 + 缺 AGENT_VLLM_MODEL：注册立刻失败并给出配置指引", async () => {
  await expect(createScannerRegistry(sourceRegistry(), new PlanStore(), {
    env: { AGENT_SCANNER_VLLM: "1" },
  })).rejects.toThrow("AGENT_VLLM_MODEL");
});

test("scannerCapabilities：关闭时原样，开启时补充 vlm 引导", () => {
  expect(scannerCapabilities({})).toBe(SCANNER_CAPABILITIES);
  const on = scannerCapabilities({ AGENT_SCANNER_VLLM: "1" });
  expect(on.startsWith(SCANNER_CAPABILITIES)).toBe(true);
  expect(on).toContain("vlm_fraud_check");
  expect(on).toContain("local_images");
});

/** 子代理假 client：第一轮调 read_image（两种角色白名单都有），第二轮终答 */
function delegateClient() {
  let calls = 0;
  const client: any = {
    chat: { completions: { create: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_image", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      }
      return {
        choices: [{ message: { content: "扫描完成" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    } } },
  };
  return client;
}

test("delegate_task：仅 scanner 把 askUser 传进子代理运行时", async () => {
  const saved = process.env.AGENT_SCANNER_VLLM;
  delete process.env.AGENT_SCANNER_VLLM;
  const dir = await tempDir("vlm-delegate-");
  try {
    const observed: Array<{ defined: boolean; answer: string | null }> = [];
    const source = new ToolRegistry();
    source.register(fakeTool("read_image", async (_args, runtime) => {
      // 在执行期间调用（真实路径）：run 结束后账本已释放，不能事后补问
      const answer = runtime?.askUser ? await runtime.askUser("测试问题", new AbortController().signal) : null;
      observed.push({ defined: runtime?.askUser !== undefined, answer });
      return "ok";
    }));
    const asked: string[] = [];
    const askUser = async (prompt: string) => { asked.push(prompt); return "停止"; };
    const makeTool = () => createDelegateTaskTool({
      sourceRegistry: source, config: { model: "m" }, sandboxRoot: dir,
      traceDir: path.join(dir, "delegates"), client: delegateClient(),
    });

    await makeTool().execute({ goal: "扫描 BV1test", role: "scanner" }, { askUser });
    expect(observed[0]).toEqual({ defined: true, answer: "停止" });
    expect(asked).toEqual(["测试问题"]);

    await makeTool().execute({ goal: "调研 X", role: "researcher" }, { askUser });
    expect(observed[1]!.defined).toBe(false);
    expect(asked).toEqual(["测试问题"]);
  } finally {
    if (saved !== undefined) process.env.AGENT_SCANNER_VLLM = saved;
    await fs.rm(dir, { recursive: true, force: true });
  }
});