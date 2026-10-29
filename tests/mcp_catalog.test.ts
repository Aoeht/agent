// tests/mcp_catalog.test.ts
// MCP 目录接口（🧩 面板的数据源）：资源/模板清单映射、单侧失败降级、资源预览截断
// 与二进制处理。不启动真实 MCP server，运行时替身只实现这三个方法。
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager, EventHub } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import { loadAgentConfig } from "../src/config";
import type { ServerRuntime } from "../src/server/runtime";
import type { McpResourceContent, McpResourceInfo } from "../src/mcp/types";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface FakeMcp {
  resources: McpResourceInfo[];
  prompts: Array<{ serverId: string; name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
  failPrompts?: boolean;
  read?: (serverId: string, uri: string) => Promise<McpResourceContent[]>;
}

async function fixture(mcp: FakeMcp) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-catalog-"));
  dirs.push(dir);
  const hub = new EventHub();
  const bridge = new UiBridge(hub.publish, 5_000);
  const mcpImpl = {
    async listResources() {
      return mcp.resources;
    },
    async listPrompts() {
      if (mcp.failPrompts === true) throw new Error("prompts/list 超时");
      return mcp.prompts;
    },
    async readResource(serverId: string, uri: string) {
      if (mcp.read !== undefined) return mcp.read(serverId, uri);
      return [{ uri, text: "正文" }];
    },
  };
  const runtime = {
    config: { ...loadAgentConfig(), model: "default-model", stream: false, checkpointsEnabled: false },
    mcp: mcpImpl,
    sandbox: { backend: "host", reason: "test" },
    sandboxRoot: dir,
  } as unknown as ServerRuntime;
  return new SessionManager({ hub, bridge, runtime, sessionDir: dir, traceDir: path.join(dir, "trace") });
}

test("目录映射：资源与模板字段完整，模板参数保留必填标记", async () => {
  const manager = await fixture({
    resources: [
      { serverId: "local", uri: "file:///docs/a.md", name: "a.md", mimeType: "text/markdown", description: "说明", size: 12 },
    ],
    prompts: [
      {
        serverId: "local",
        name: "review",
        description: "审查",
        arguments: [{ name: "text", description: "正文", required: true }, { name: "tone" }],
      },
    ],
  });

  const catalog = await manager.mcpCatalog();
  expect(catalog.errors).toBeUndefined();
  expect(catalog.resources).toEqual([
    { serverId: "local", uri: "file:///docs/a.md", name: "a.md", mimeType: "text/markdown", description: "说明", size: 12 },
  ]);
  expect(catalog.prompts).toEqual([
    {
      serverId: "local",
      name: "review",
      description: "审查",
      arguments: [{ name: "text", description: "正文", required: true }, { name: "tone" }],
    },
  ]);
});

test("模板列取失败只降级为空数组并带 errors，资源侧不受影响", async () => {
  const manager = await fixture({
    resources: [{ serverId: "local", uri: "file:///docs/a.md", name: "a.md" }],
    prompts: [],
    failPrompts: true,
  });

  const catalog = await manager.mcpCatalog();
  expect(catalog.resources).toHaveLength(1);
  expect(catalog.prompts).toEqual([]);
  expect(catalog.errors?.join("\n")).toContain("prompts/list 超时");
});

test("资源预览：文本超 20k 截断并标 truncated", async () => {
  const manager = await fixture({
    resources: [],
    prompts: [],
    read: async (_serverId, uri) => [{ uri, text: "x".repeat(25_000) }],
  });

  const result = await manager.readMcpResource("local", "file:///docs/big.md");
  expect(result.contents).toHaveLength(1);
  expect(result.contents[0]!.text).toHaveLength(20_000);
  expect(result.contents[0]!.truncated).toBe(true);
});

test("资源预览：二进制只回字节数，不回传 base64", async () => {
  const manager = await fixture({
    resources: [],
    prompts: [],
    // "aGVsbG8=" 是 5 字节
    read: async (_serverId, uri) => [{ uri, mimeType: "image/png", blob: "aGVsbG8=" }],
  });

  const result = await manager.readMcpResource("local", "file:///assets/logo.png");
  expect(result.contents[0]).toEqual({ uri: "file:///assets/logo.png", mimeType: "image/png", blobBytes: 5 });
});

test("守卫/未知 server 的错误原样抛出（路由层映射状态码）", async () => {
  const manager = await fixture({
    resources: [],
    prompts: [],
    read: async () => {
      throw new Error('Security Exception: 路径 "file:///etc/passwd" 超出允许的工作区范围');
    },
  });

  await expect(manager.readMcpResource("local", "file:///etc/passwd")).rejects.toThrow("Security Exception");
});
