import { describe, expect, test } from "bun:test";
import { formatHistoryReplay } from "../src/core/session_replay";
import type { Message } from "../src/core/types";

describe("续聊历史回放", () => {
  test("空回答按结束原因占位，不让对话看起来凭空消失", () => {
    const messages = [
      { role: "user", content: "看一下 12.jpg" },
      {
        role: "assistant",
        content: "",
        outcome: { stopReason: "content_filter", errorMessage: "<400> DataInspectionFailed" },
      },
    ] as unknown as Message[];

    expect(formatHistoryReplay(messages)).toEqual([
      "你> 看一下 12.jpg",
      "助手> （没有生成内容 · 内容被过滤，尚未完成判断：<400> DataInspectionFailed）",
    ]);
  });

  test("没有 outcome 的空回答也给出明确占位", () => {
    const messages = [
      { role: "user", content: "问" },
      { role: "assistant", content: "" },
    ] as Message[];
    expect(formatHistoryReplay(messages)[1]).toBe("助手> （没有生成内容 · 没有保存回答）");
  });

  test("完整记录：不按轮数截断，所有提问与回答都在", () => {
    const messages: Message[] = [];
    for (let turn = 0; turn < 5; turn++) {
      messages.push({ role: "user", content: `问题${turn}` }, { role: "assistant", content: `回答${turn}` });
    }
    messages.push({ role: "user", content: "最后一问" });

    expect(formatHistoryReplay(messages)).toEqual([
      "你> 问题0", "助手> 回答0",
      "你> 问题1", "助手> 回答1",
      "你> 问题2", "助手> 回答2",
      "你> 问题3", "助手> 回答3",
      "你> 问题4", "助手> 回答4",
      "你> 最后一问",
    ]);
  });

  test("过程消息：按步骤显示思考与工具调用，再显示最终回答", () => {
    const messages = [
      { role: "user", content: "看一下 12.jpg" },
      {
        role: "assistant",
        content: "这个链接没有诈骗风险",
        process: [
          { llmContent: "我先读图", toolCalls: [{ name: "read_image", arguments: '{"path":"12.jpg"}' }] },
          { toolCalls: [{ name: "rag_search", arguments: '{"query":"色情引流"}' }] },
        ],
      },
    ] as unknown as Message[];

    expect(formatHistoryReplay(messages)).toEqual([
      "你> 看一下 12.jpg",
      "助手> 我先读图",
      '助手> [工具调用] read_image({"path":"12.jpg"})',
      '助手> [工具调用] rag_search({"query":"色情引流"})',
      "助手> 这个链接没有诈骗风险",
    ]);
  });

  test("直接落盘的 assistant(tool_calls) 记录同样显示", () => {
    const messages = [
      { role: "user", content: "查" },
      {
        role: "assistant",
        content: "我来调用工具",
        tool_calls: [{ id: "c1", type: "function", function: { name: "inspect", arguments: "{}" } }],
      },
      { role: "assistant", content: "答案" },
    ] as Message[];

    expect(formatHistoryReplay(messages)).toEqual([
      "你> 查",
      "助手> 我来调用工具",
      "助手> [工具调用] inspect({})",
      "助手> 答案",
    ]);
  });

  test("长文本与长错误信息不截断", () => {
    const answer = "答".repeat(1000);
    const error = "x".repeat(500);
    const messages = [
      { role: "user", content: "问" },
      { role: "assistant", content: "" , outcome: { stopReason: "error", errorMessage: error } },
      { role: "user", content: "再问" },
      { role: "assistant", content: answer },
    ] as unknown as Message[];

    expect(formatHistoryReplay(messages)).toEqual([
      "你> 问",
      `助手> （没有生成内容 · 运行出错：${error}）`,
      "你> 再问",
      `助手> ${answer}`,
    ]);
  });

  test("跳过 tool 响应，不把工具输出当对话内容", () => {
    const messages = [
      { role: "user", content: "问" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "" } }] },
      { role: "tool", tool_call_id: "c1", content: "工具输出" },
      { role: "assistant", content: "答" },
    ] as unknown as Message[];

    expect(formatHistoryReplay(messages)).not.toContain("助手> 工具输出");
  });
});
