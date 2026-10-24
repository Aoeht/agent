// tests/mcp_hot_reload.test.ts
// MCP 配置热载入：
//   - resolveMcpServers：.mcp.json 与内置默认的合并（新增/覆盖/false 下线/坏文件兜底）
//   - planMcpDiff：增量计划（纯函数）
//   - applyMcpPlan：按计划调用 addServer/removeServer（stub manager）
//   - McpConfigWatcher.reload：文件变更重载 + 无变化不动作
// 运行: bun test ./tests/mcp_hot_reload.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  resolveMcpServers, planMcpDiff, applyMcpPlan, McpConfigWatcher,
} from "../src/mcp/hot_reload";
import { McpServers } from "../src/mcp/config";
import type { McpServerConfig } from "../src/mcp/types";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

const stdioServer = (id: string, args: string[] = []): McpServerConfig => ({
  id, transport: "stdio", command: "echo", args, enabled: true,
});

test("resolveMcpServers：无文件 → 纯内置", async () => {
  const dir = await tempDir("dsh-mcp-hl-none-");
  const { servers, fileIssues } = await resolveMcpServers(path.join(dir, ".mcp.json"));
  expect(servers.map((s) => s.id)).toEqual(McpServers.map((s) => s.id));
  expect(fileIssues).toEqual([]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("resolveMcpServers：新增、覆盖、false 下线", async () => {
  const dir = await tempDir("dsh-mcp-hl-merge-");
  const file = path.join(dir, ".mcp.json");
  await fs.writeFile(file, JSON.stringify({
    servers: {
      probe: { transport: "stdio", command: "bun", args: ["run", "probe.ts"] },
      logistics: { transport: "streamableHttp", url: "https://example.test/mcp" },
      filesystem: false,
    },
  }), "utf-8");
  const { servers, fileIssues } = await resolveMcpServers(file);
  expect(fileIssues).toEqual([]);
  const ids = servers.map((s) => s.id);
  expect(ids).toContain("probe");
  expect(ids).not.toContain("filesystem"); // false 下线内置
  expect(ids).toContain("logistics");
  // 覆盖：url 换成了文件里的
  const logistics = servers.find((s) => s.id === "logistics");
  expect(logistics?.transport).toBe("streamableHttp");
  expect((logistics as { url?: string }).url).toBe("https://example.test/mcp");
  await fs.rm(dir, { recursive: true, force: true });
});

test("resolveMcpServers：坏 JSON / 非法条目 → 告警并兜底", async () => {
  const dir = await tempDir("dsh-mcp-hl-bad-");
  const file = path.join(dir, ".mcp.json");
  await fs.writeFile(file, "{ not json", "utf-8");
  const broken = await resolveMcpServers(file);
  expect(broken.servers.map((s) => s.id)).toEqual(McpServers.map((s) => s.id));
  expect(broken.fileIssues.length).toBe(1);

  await fs.writeFile(file, JSON.stringify({
    servers: {
      bad_one: { transport: "stdio" }, // 缺 command
      ok_one: { transport: "stdio", command: "echo" },
    },
  }), "utf-8");
  const partial = await resolveMcpServers(file);
  expect(partial.servers.map((s) => s.id)).toEqual([...McpServers.map((s) => s.id), "ok_one"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("planMcpDiff：新增/移除/重连/未变/禁用", () => {
  const current = new Map([
    ["keep", stdioServer("keep")],
    ["drop", stdioServer("drop")],
    ["change", stdioServer("change", ["--old"])],
  ]);
  const plan = planMcpDiff(current, [
    stdioServer("keep"),
    stdioServer("change", ["--new"]),
    stdioServer("fresh"),
    { ...stdioServer("off"), enabled: false },
  ]);
  expect(plan.added.map((s) => s.id)).toEqual(["fresh"]);
  expect(plan.removed).toEqual(["drop"]); // 禁用的 off 不在 current，不产生动作
  expect(plan.reloaded.map((s) => s.id)).toEqual(["change"]);
  expect(plan.unchanged).toEqual(["keep"]);
});

test("planMcpDiff：目标里禁用已加载的 → 计入移除", () => {
  const plan = planMcpDiff(new Map([["x", stdioServer("x")]]), [{ ...stdioServer("x"), enabled: false }]);
  expect(plan.removed).toEqual(["x"]);
  expect(plan.added).toEqual([]);
});

test("applyMcpPlan：按计划串行调用 stub manager", async () => {
  const calls: string[] = [];
  const manager = {
    addServer: async (config: McpServerConfig) => { calls.push(`add:${config.id}`); return []; },
    removeServer: async (id: string) => { calls.push(`remove:${id}`); },
  };
  const plan = planMcpDiff(new Map([["drop", stdioServer("drop")], ["change", stdioServer("change", ["--old"])]]), [
    stdioServer("change", ["--new"]),
    stdioServer("fresh"),
  ]);
  const { ok, failed } = await applyMcpPlan(manager, plan);
  expect(failed).toEqual([]);
  expect(ok).toEqual(["-drop", "-change", "+change", "+fresh"]);
  expect(calls).toEqual(["remove:drop", "remove:change", "add:change", "add:fresh"]);
});

test("McpConfigWatcher.reload：文件变更增量应用，无变化不动作", async () => {
  const dir = await tempDir("dsh-mcp-hl-watch-");
  const file = path.join(dir, ".mcp.json");
  const calls: string[] = [];
  const manager = {
    addServer: async (config: McpServerConfig) => { calls.push(`add:${config.id}`); return []; },
    removeServer: async (id: string) => { calls.push(`remove:${id}`); },
  };
  await fs.writeFile(file, JSON.stringify({ servers: { keep: { transport: "stdio", command: "echo" } } }), "utf-8");
  // 初始已应用 = 同一份文件的合并结果（与 bootstrap 的实际流程一致）
  const initial = await resolveMcpServers(file);
  const watcher = new McpConfigWatcher(manager, file, initial.servers);

  const noChange = await watcher.reload();
  expect(noChange?.added).toEqual([]);
  expect(calls).toEqual([]);

  await fs.writeFile(file, JSON.stringify({
    servers: {
      keep: { transport: "stdio", command: "echo" },
      probe: { transport: "stdio", command: "bun", args: ["run", "probe.ts"] },
    },
  }), "utf-8");
  const changed = await watcher.reload();
  expect(changed?.added.map((s) => s.id)).toEqual(["probe"]);
  expect(calls).toEqual(["add:probe"]);

  watcher.close();
  await fs.rm(dir, { recursive: true, force: true });
});
