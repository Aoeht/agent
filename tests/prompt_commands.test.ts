// tests/prompt_commands.test.ts
// 运行: bun test ./tests/prompt_commands.test.ts
import { test, expect, describe } from "bun:test";
import { handlePromptCommand, type PromptSource } from "../src/prompts/commands";
import type { McpGetPromptResult, McpPromptInfo } from "../src/mcp/types";

/** 假 PromptSource：不 spawn server、不联网，只验证 dispatcher 的解析与分支 */
function makeFake(): { mcp: PromptSource; calls: string[] } {
  const calls: string[] = [];
  const mcp: PromptSource = {
    async listPrompts(): Promise<McpPromptInfo[]> {
      calls.push("listPrompts");
      return [
        {
          serverId: "local_prompts",
          name: "review",
          description: "审查模板",
          arguments: [
            { name: "text", required: true },
            { name: "focus", required: false },
          ],
        },
        { serverId: "other", name: "summarize" },
      ] as McpPromptInfo[];
    },
    async getPrompt(serverId, name, args): Promise<McpGetPromptResult> {
      calls.push(`getPrompt:${serverId}:${name}:${JSON.stringify(args ?? null)}`);
      if (serverId === "local_prompts" && name === "review") {
        const focus = args?.focus ?? "general";
        const text = args?.text ?? "";
        return {
          messages: [
            { role: "user", content: { type: "text", text: `请从 ${focus} 角度审查：${text}` } },
          ],
        };
      }
      throw new Error(`Prompt "${name}" 不在 Server "${serverId}" 的当前 prompts/list 结果中`);
    },
  };
  return { mcp, calls };
}

/** 收集 out 输出，便于断言打印内容 */
function collector(): { out: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (s) => lines.push(s), lines };
}

describe("/prompts 列表", () => {
  test("列出所有 server 的模板与参数标记", async () => {
    const { mcp } = makeFake();
    const { out, lines } = collector();
    const res = await handlePromptCommand("/prompts", mcp, out);
    expect(res.kind).toBe("handled");
    const joined = lines.join("\n");
    expect(joined).toContain("local_prompts:review");
    expect(joined).toContain("text*"); // 必填带星
    expect(joined).toContain("focus"); // 可选不带星
    expect(joined).toContain("other:summarize");
  });

  test("listPrompts 抛错时不崩，转 handled", async () => {
    const mcp: PromptSource = {
      async listPrompts() {
        throw new Error("boom");
      },
      async getPrompt() {
        throw new Error("unused");
      },
    };
    const { out, lines } = collector();
    const res = await handlePromptCommand("/prompts", mcp, out);
    expect(res.kind).toBe("handled");
    expect(lines.join("\n")).toContain("列出模板失败");
  });
});

describe("/prompt 取模板", () => {
  test("带 JSON 参数 → inject，文本按参数渲染", async () => {
    const { mcp, calls } = makeFake();
    const { out } = collector();
    const res = await handlePromptCommand(
      `/prompt local_prompts:review {"text":"可疑交易","focus":"risk"}`,
      mcp,
      out
    );
    expect(res.kind).toBe("inject");
    if (res.kind === "inject") {
      expect(res.text).toBe("请从 risk 角度审查：可疑交易");
      expect(res.label).toBe("local_prompts:review");
      expect(res.messages).toEqual([
        { role: "user", content: { type: "text", text: "请从 risk 角度审查：可疑交易" } },
      ]);
    }
    expect(calls).toContain(`getPrompt:local_prompts:review:{"text":"可疑交易","focus":"risk"}`);
  });

  test("不带参数 → 走 server 默认分支", async () => {
    const { mcp } = makeFake();
    const { out } = collector();
    const res = await handlePromptCommand("/prompt local_prompts:review", mcp, out);
    expect(res.kind).toBe("inject");
    if (res.kind === "inject") expect(res.text).toBe("请从 general 角度审查：");
  });

  test("标识缺冒号 → handled + 格式提示", async () => {
    const { mcp } = makeFake();
    const { out, lines } = collector();
    const res = await handlePromptCommand("/prompt review", mcp, out);
    expect(res.kind).toBe("handled");
    expect(lines.join("\n")).toContain("serverId>:<name");
  });

  test("未知模板 → getPrompt 抛错被兜住", async () => {
    const { mcp } = makeFake();
    const { out, lines } = collector();
    const res = await handlePromptCommand("/prompt nope:review", mcp, out);
    expect(res.kind).toBe("handled");
    expect(lines.join("\n")).toContain("取模板失败");
  });

  test("坏 JSON 参数 → handled + 提示", async () => {
    const { mcp } = makeFake();
    const { out, lines } = collector();
    const res = await handlePromptCommand('/prompt local_prompts:review {"text":', mcp, out);
    expect(res.kind).toBe("handled");
    expect(lines.join("\n")).toContain("不是合法 JSON");
  });

  test("参数值非字符串 → handled + 提示", async () => {
    const { mcp } = makeFake();
    const { out, lines } = collector();
    const res = await handlePromptCommand('/prompt local_prompts:review {"text":123}', mcp, out);
    expect(res.kind).toBe("handled");
    expect(lines.join("\n")).toContain("必须是字符串");
  });

  test("空 /prompt → 清除待注入", async () => {
    const { mcp } = makeFake();
    const { out, lines } = collector();
    const res = await handlePromptCommand("/prompt", mcp, out);
    expect(res.kind).toBe("handled");
    expect(lines.join("\n")).toContain("已清除");
  });

  test("多消息模板：role 原样保留，system 不被压平成 user", async () => {
    const mcp: PromptSource = {
      async listPrompts() {
        return [{ serverId: "srv", name: "review" }] as McpPromptInfo[];
      },
      async getPrompt(): Promise<McpGetPromptResult> {
        return {
          messages: [
            { role: "system", content: { type: "text", text: "只输出 JSON" } },
            { role: "user", content: { type: "text", text: "审查这段对话" } },
          ],
        };
      },
    };
    const { out } = collector();
    const res = await handlePromptCommand("/prompt srv:review", mcp, out);
    expect(res.kind).toBe("inject");
    if (res.kind === "inject") {
      expect(res.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(res.label).toBe("srv:review");
      // 预览文本带角色标记，人读时能看出哪条是 system 约束
      expect(res.text).toContain("[system] 只输出 JSON");
      expect(res.text).toContain("[user] 审查这段对话");
    }
  });
});

describe("非 prompt 命令交回主循环", () => {
  test("普通问题 → not-a-command", async () => {
    const { mcp } = makeFake();
    const res = await handlePromptCommand("帮我总结这段", mcp, () => {});
    expect(res.kind).toBe("not-a-command");
  });

  test("/exit → not-a-command（不被 prompt 逻辑吞掉）", async () => {
    const { mcp } = makeFake();
    const res = await handlePromptCommand("/exit", mcp, () => {});
    expect(res.kind).toBe("not-a-command");
  });

  test("/promptfoo 未知斜杠 → not-a-command", async () => {
    const { mcp } = makeFake();
    const res = await handlePromptCommand("/promptfoo", mcp, () => {});
    expect(res.kind).toBe("not-a-command");
  });
});
