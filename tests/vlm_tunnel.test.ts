// SSH 隧道自动管理测试：配置解析 / 复用 / spawn 参数 / 早退报错 / 超时回收 /
// 死亡重起 / 并发去重 / ssh 缺失。全部用注入替身，不触网、不起真实 ssh。
// 运行: bun test ./tests/vlm_tunnel.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { resolveTunnelConfig, VlmTunnelManager, type SshChild } from "../src/tools/vlm_tunnel";
import { ProviderStore } from "../src/core/providers";

class FakeSsh extends EventEmitter implements SshChild {
  stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}

const CFG = { host: "c534", localPort: 8000, remotePort: 8000 };

async function tempStore(baseURL = "http://127.0.0.1:8000/v1") {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "vlm-tunnel-"));
  const store = new ProviderStore(path.join(dir, "providers.json"));
  const info = store.add({ name: "vllm", baseURL, apiKey: "secret", models: ["fraud-vlm"] });
  return { store, model: `${info.id}::fraud-vlm`, dir };
}

test("resolveTunnelConfig：未配 host 返回 null；端口从 baseURL 推导；远端口可覆盖", async () => {
  const { store, model } = await tempStore();
  expect(resolveTunnelConfig(model, {}, store)).toBeNull();
  expect(resolveTunnelConfig(model, { AGENT_VLLM_SSH_HOST: "  " }, store)).toBeNull();
  expect(resolveTunnelConfig(model, { AGENT_VLLM_SSH_HOST: "c534" }, store))
    .toEqual({ host: "c534", localPort: 8000, remotePort: 8000 });
  expect(resolveTunnelConfig(model, { AGENT_VLLM_SSH_HOST: "c534", AGENT_VLLM_REMOTE_PORT: "30001" }, store))
    .toEqual({ host: "c534", localPort: 8000, remotePort: 30001 });
});

test("resolveTunnelConfig：https 缺省 443；供应商缺失与非法端口报错", async () => {
  const { store, model } = await tempStore("https://gpu.example.com/v1");
  expect(resolveTunnelConfig(model, { AGENT_VLLM_SSH_HOST: "c534" }, store))
    .toEqual({ host: "c534", localPort: 443, remotePort: 443 });
  expect(() => resolveTunnelConfig("ghost::m", { AGENT_VLLM_SSH_HOST: "c534" }, store)).toThrow("不存在");
  expect(() => resolveTunnelConfig(model, { AGENT_VLLM_SSH_HOST: "c534", AGENT_VLLM_REMOTE_PORT: "abc" }, store)).toThrow("AGENT_VLLM_REMOTE_PORT");
  expect(() => resolveTunnelConfig(model, { AGENT_VLLM_SSH_HOST: "c534", AGENT_VLLM_REMOTE_PORT: "70000" }, store)).toThrow("AGENT_VLLM_REMOTE_PORT");
});

test("端口已通 → 直接复用，不 spawn（兼容手动隧道）", async () => {
  let spawns = 0;
  const manager = new VlmTunnelManager({
    spawnSsh: () => { spawns++; return new FakeSsh(); },
    portOpen: async () => true,
  });
  await manager.ensure(CFG);
  await manager.ensure(CFG);
  expect(spawns).toBe(0);
});

test("spawn ssh：参数固化（BatchMode/ExitOnForwardFailure/保活/-L），端口通后 resolve", async () => {
  const child = new FakeSsh();
  let open = false;
  let seen: string[] = [];
  const manager = new VlmTunnelManager({
    spawnSsh: args => { seen = args; open = true; return child; },
    portOpen: async () => open,
    pollMs: 5, waitMs: 1_000,
  });
  await manager.ensure({ host: "c534", localPort: 8000, remotePort: 30001 });
  expect(seen).toEqual([
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", "8000:127.0.0.1:30001",
    "c534",
  ]);
  expect(child.killed).toBe(false);
});

test("ssh 早退（密钥被拒）→ reject 且带 stderr 线索", async () => {
  const child = new FakeSsh();
  const manager = new VlmTunnelManager({
    spawnSsh: () => {
      queueMicrotask(() => {
        child.stderr.write("zth@192.168.3.159: Permission denied (publickey).\n");
        child.emit("exit", 255, null);
      });
      return child;
    },
    portOpen: async () => false,
    pollMs: 5, waitMs: 1_000,
  });
  await expect(manager.ensure(CFG)).rejects.toThrow("Permission denied");
});

test("等待超时 → kill 子进程并报错", async () => {
  const child = new FakeSsh();
  const manager = new VlmTunnelManager({
    spawnSsh: () => child,
    portOpen: async () => false,
    pollMs: 5, waitMs: 60,
  });
  await expect(manager.ensure(CFG)).rejects.toThrow("超时");
  expect(child.killed).toBe(true);
});

test("ssh 命令不存在（ENOENT）→ 可读报错", async () => {
  const manager = new VlmTunnelManager({
    spawnSsh: () => {
      const child = new FakeSsh();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })));
      return child;
    },
    portOpen: async () => false,
    pollMs: 5, waitMs: 1_000,
  });
  await expect(manager.ensure(CFG)).rejects.toThrow("OpenSSH");
});

test("隧道死亡后再次 ensure → 重新 spawn", async () => {
  let open = false;
  const children: FakeSsh[] = [];
  const manager = new VlmTunnelManager({
    spawnSsh: () => { const child = new FakeSsh(); children.push(child); open = true; return child; },
    portOpen: async () => open,
    pollMs: 5, waitMs: 1_000,
  });
  await manager.ensure(CFG);
  expect(children.length).toBe(1);
  children[0]!.emit("exit", 0, null);
  open = false;
  await manager.ensure(CFG);
  expect(children.length).toBe(2);
});

test("并发 ensure 只起一条隧道", async () => {
  let open = false;
  let spawns = 0;
  const manager = new VlmTunnelManager({
    spawnSsh: () => { spawns++; setTimeout(() => { open = true; }, 20); return new FakeSsh(); },
    portOpen: async () => open,
    pollMs: 5, waitMs: 1_000,
  });
  await Promise.all([manager.ensure(CFG), manager.ensure(CFG), manager.ensure(CFG)]);
  expect(spawns).toBe(1);
});

test("失败后不闩锁：下一次 ensure 可以重试成功", async () => {
  const child = new FakeSsh();
  let attempt = 0;
  let open = false;
  const manager = new VlmTunnelManager({
    spawnSsh: () => {
      attempt++;
      if (attempt === 1) {
        queueMicrotask(() => child.emit("exit", 255, null));
        return child;
      }
      open = true;
      return new FakeSsh();
    },
    portOpen: async () => open,
    pollMs: 5, waitMs: 1_000,
  });
  await expect(manager.ensure(CFG)).rejects.toThrow("SSH");
  await manager.ensure(CFG);
  expect(attempt).toBe(2);
});