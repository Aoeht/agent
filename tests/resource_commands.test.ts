// tests/resource_commands.test.ts
// resources 消费入口：/resources 列表、/resource 读取并钉到下一轮、空 /resource 清除。
// 命令通道部分验证 busy 门控与"只改 agent 内存字段"的接线（注入围栏本身在
// resource_injection.test.ts 里验）。
import { describe, expect, test } from "bun:test";
import type { McpResourceContent, McpResourceInfo } from "../src/mcp/types";
import { handleResourceCommand, isResourceCommand, type ResourceSource } from "../src/mcp/resource_commands";
import { handleSlashCommand } from "../src/core/command_router";
import type { Agent } from "../src/core/agent";
import type { SessionStore } from "../src/core/session_store";
import type { PromptSource } from "../src/prompts/commands";

const resources: McpResourceInfo[] = [
  {
    serverId: "local",
    uri: "file:///docs/notes.md",
    name: "notes.md",
    mimeType: "text/markdown",
    description: "工作笔记",
  },
  { serverId: "local", uri: "file:///assets/logo.png", name: "logo.png", mimeType: "image/png" },
];

function makeSource(overrides: Partial<ResourceSource> = {}): ResourceSource {
  return {
    async listResources(serverId?: string) {
      if (serverId !== undefined && !resources.some((resource) => resource.serverId === serverId)) {
        throw new Error(`Server "${serverId}" 不存在或未声明 resources 能力`);
      }
      return serverId === undefined ? [...resources] : resources.filter((resource) => resource.serverId === serverId);
    },
    async readResource(_serverId: string, uri: string): Promise<McpResourceContent[]> {
      if (uri.endsWith(".png")) return [{ uri, mimeType: "image/png", blob: "aGVsbG8=" }]; // 5 字节 base64
      if (uri.endsWith("big.md")) return [{ uri, text: "x".repeat(9_000) }];
      return [{ uri, mimeType: "text/markdown", text: "# 笔记\n\n正文第一条" }];
    },
    ...overrides,
  };
}

function collect(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line) };
}

describe("recognize", () => {
  test("只认 /resources 与 /resource 两条", () => {
    expect(isResourceCommand("/resources")).toBe(true);
    expect(isResourceCommand("/resources local")).toBe(true);
    expect(isResourceCommand("/resource")).toBe(true);
    expect(isResourceCommand("/resource local:notes.md")).toBe(true);
    expect(isResourceCommand("/resourcex")).toBe(false);
    expect(isResourceCommand("/prompts")).toBe(false);
    expect(isResourceCommand("普通消息")).toBe(false);
  });
});

describe("handleResourceCommand", () => {
  test("/resources 列出全部资源（含 uri 与类型）", async () => {
    const { lines, out } = collect();
    const result = await handleResourceCommand("/resources", makeSource(), out);
    expect(result.kind).toBe("handled");
    const text = lines.join("\n");
    expect(text).toContain("local:notes.md");
    expect(text).toContain("file:///docs/notes.md");
    expect(text).toContain("[text/markdown]");
    expect(text).toContain("local:logo.png");
    expect(text).toContain("/resource <serverId:name|uri>");
  });

  test("/resources <serverId> 过滤；未知 server 报错但不抛", async () => {
    const filtered = await handleResourceCommand("/resources local", makeSource(), collect().out);
    expect(filtered.kind).toBe("handled");

    const { lines, out } = collect();
    const unknown = await handleResourceCommand("/resources ghost", makeSource(), out);
    expect(unknown.kind).toBe("handled");
    expect(lines.join("\n")).toContain('Server "ghost" 不存在');
  });

  test("按名称读取：返回 inject + 带出处的正文", async () => {
    const result = await handleResourceCommand("/resource local:notes.md", makeSource(), collect().out);
    expect(result.kind).toBe("inject");
    if (result.kind !== "inject") return;
    expect(result.label).toBe("local:notes.md（file:///docs/notes.md）");
    expect(result.text).toContain("### local:notes.md（file:///docs/notes.md）");
    expect(result.text).toContain("正文第一条");
    expect(result.chars).toBe(result.text.length);
  });

  test("按 uri 读取与按名称等价", async () => {
    const result = await handleResourceCommand("/resource local:file:///docs/notes.md", makeSource(), collect().out);
    expect(result.kind).toBe("inject");
  });

  test("二进制资源不注入，明确提示", async () => {
    const { lines, out } = collect();
    const result = await handleResourceCommand("/resource local:logo.png", makeSource(), out);
    expect(result.kind).toBe("handled");
    expect(lines.join("\n")).toContain("只有二进制内容");
  });

  test("空 /resource 表示清除", async () => {
    const { lines, out } = collect();
    const result = await handleResourceCommand("/resource", makeSource(), out);
    expect(result.kind).toBe("handled");
    expect(lines.join("\n")).toContain("已清除待注入资源");
  });

  test("超长正文按 8k 截断并标注", async () => {
    const source = makeSource({
      async readResource(_serverId, uri) {
        return [{ uri, text: "x".repeat(9_000) }];
      },
    });
    const result = await handleResourceCommand("/resource local:notes.md", source, collect().out);
    expect(result.kind).toBe("inject");
    if (result.kind !== "inject") return;
    expect(result.text).toContain("已截断");
    // 8k 正文 + 头尾标注，不应接近 9k
    expect(result.chars).toBeLessThan(8_300);
  });

  test("未知资源名给出可用清单", async () => {
    const { lines, out } = collect();
    const result = await handleResourceCommand("/resource local:nope", makeSource(), out);
    expect(result.kind).toBe("handled");
    const text = lines.join("\n");
    expect(text).toContain('没有名为 "nope" 的资源');
    expect(text).toContain("notes.md");
  });

  test("格式不对（缺 serverId 或空 ref）不读取", async () => {
    for (const input of ["/resource notes.md", "/resource local:"]) {
      const { lines, out } = collect();
      const result = await handleResourceCommand(input, makeSource(), out);
      expect(result.kind).toBe("handled");
      expect(lines.join("\n")).toContain("<serverId:name|uri>");
    }
  });
});

describe("命令路由接线", () => {
  function deps(pinned: Array<string | undefined>, busy = false) {
    const agent = {
      model: "test",
      setPinnedResources(text: string | undefined) {
        pinned.push(text);
      },
    } as unknown as Agent;
    return {
      agent,
      store: {} as SessionStore,
      mcp: {} as PromptSource,
      resources: makeSource(),
      isBusy: () => busy,
    };
  }

  test("/resource 命中后把正文交给 agent 钉住", async () => {
    const pinned: Array<string | undefined> = [];
    const outcome = await handleSlashCommand("/resource local:notes.md", deps(pinned));
    expect(outcome.kind).toBe("handled");
    if (outcome.kind !== "handled") return;
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toContain("正文第一条");
    expect(outcome.lines.join("\n")).toContain("已钉住资源 local:notes.md");
  });

  test("空 /resource 清除 agent 上的钉住内容", async () => {
    const pinned: Array<string | undefined> = [];
    const outcome = await handleSlashCommand("/resource", deps(pinned));
    expect(outcome.kind).toBe("handled");
    expect(pinned).toEqual([undefined]);
  });

  test("回合进行中拒绝注入，但列表仍可用", async () => {
    const pinned: Array<string | undefined> = [];
    const busy = await handleSlashCommand("/resource local:notes.md", deps(pinned, true));
    expect(busy.kind).toBe("handled");
    if (busy.kind === "handled") expect(busy.lines.join("\n")).toContain("回合进行中");
    expect(pinned).toHaveLength(0);

    const list = await handleSlashCommand("/resources", deps(pinned, true));
    expect(list.kind).toBe("handled");
    if (list.kind === "handled") expect(list.lines.join("\n")).toContain("notes.md");
  });

  test("未接入资源来源时给明确提示", async () => {
    const outcome = await handleSlashCommand("/resources", {
      agent: {} as Agent,
      store: {} as SessionStore,
      mcp: {} as PromptSource,
    });
    expect(outcome.kind).toBe("handled");
    if (outcome.kind === "handled") expect(outcome.lines.join("\n")).toContain("未接入 MCP 资源来源");
  });
});
