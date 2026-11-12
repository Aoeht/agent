// 接线测试：createScannerRegistry 在体检前自动起隧道（env opt-in），
// 未配 host 保持手动模式，隧道失败则挂载失败。
// 运行: bun test ./tests/scanner_vlm_tunnel_wiring.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { ToolRegistry } from "../src/core/registry";
import { PlanStore } from "../src/core/plan_store";
import { ProviderStore } from "../src/core/providers";
import { VLM_FRAUD_CHECK_TOOL_NAME } from "../src/tools/vlm_fraud_check";
import { VlmTunnelManager, type SshChild } from "../src/tools/vlm_tunnel";
import { createScannerRegistry } from "../src/team_runtime";

const silentChild = (): SshChild => Object.assign(new EventEmitter(), { stderr: null, kill: () => true });

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "vlm-tunnel-wiring-"));
  const store = new ProviderStore(path.join(dir, "providers.json"));
  const info = store.add({ name: "vllm", baseURL: "http://127.0.0.1:8000/v1", apiKey: "secret", models: ["fraud-vlm"] });
  return { store, model: `${info.id}::fraud-vlm` };
}

const okFetcher = (async () => new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch;

test("配了 SSH host：先起隧道再体检，工具挂载成功", async () => {
  const { store, model } = await tempStore();
  const order: string[] = [];
  let tunnelArgs: string[] = [];
  let open = false;
  const tunnel = new VlmTunnelManager({
    spawnSsh: args => {
      order.push("tunnel");
      tunnelArgs = args;
      open = true;
      return silentChild();
    },
    portOpen: async () => open,
    pollMs: 5, waitMs: 1_000,
  });
  const fetcher = (async (input: any, init: any) => {
    order.push("probe");
    return okFetcher(input, init);
  }) as typeof fetch;
  const registry = await createScannerRegistry(new ToolRegistry(), new PlanStore(), {
    env: { AGENT_SCANNER_VLLM: "1", AGENT_VLLM_MODEL: model, AGENT_VLLM_SSH_HOST: "c534", AGENT_VLLM_REMOTE_PORT: "30001" },
    vlm: { store, fetcher, tunnel },
  });
  expect(order).toEqual(["tunnel", "probe"]);
  expect(tunnelArgs).toContain("8000:127.0.0.1:30001");
  expect(tunnelArgs).toContain("c534");
  expect(registry.get(VLM_FRAUD_CHECK_TOOL_NAME)).toBeDefined();
});

test("未配 SSH host：不起隧道（手动模式），体检照常", async () => {
  const { store, model } = await tempStore();
  let spawns = 0;
  const tunnel = new VlmTunnelManager({
    spawnSsh: () => { spawns++; throw new Error("不应 spawn"); },
    portOpen: async () => true,
  });
  const registry = await createScannerRegistry(new ToolRegistry(), new PlanStore(), {
    env: { AGENT_SCANNER_VLLM: "1", AGENT_VLLM_MODEL: model },
    vlm: { store, fetcher: okFetcher, tunnel },
  });
  expect(spawns).toBe(0);
  expect(registry.get(VLM_FRAUD_CHECK_TOOL_NAME)).toBeDefined();
});

test("隧道起不来：挂载直接失败，不注册工具", async () => {
  const { store, model } = await tempStore();
  const tunnel = new VlmTunnelManager({
    spawnSsh: () => silentChild(),
    portOpen: async () => false,
    pollMs: 5, waitMs: 50,
  });
  await expect(createScannerRegistry(new ToolRegistry(), new PlanStore(), {
    env: { AGENT_SCANNER_VLLM: "1", AGENT_VLLM_MODEL: model, AGENT_VLLM_SSH_HOST: "c534" },
    vlm: { store, fetcher: okFetcher, tunnel },
  })).rejects.toThrow("SSH 隧道");
});

test("VLM 未开启：隧道与体检都不触发", async () => {
  const { store, model } = await tempStore();
  let spawns = 0;
  let probes = 0;
  const tunnel = new VlmTunnelManager({
    spawnSsh: () => { spawns++; throw new Error("不应 spawn"); },
    portOpen: async () => true,
  });
  const fetcher = (async () => { probes++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const registry = await createScannerRegistry(new ToolRegistry(), new PlanStore(), {
    env: { AGENT_VLLM_MODEL: model, AGENT_VLLM_SSH_HOST: "c534" },
    vlm: { store, fetcher, tunnel },
  });
  expect(spawns).toBe(0);
  expect(probes).toBe(0);
  expect(registry.get(VLM_FRAUD_CHECK_TOOL_NAME)).toBeUndefined();
});