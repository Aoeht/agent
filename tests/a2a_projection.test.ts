// tests/a2a_projection.test.ts
// 投影层是信息边界：只有 finalAnswer/stopReason 能出站，messages/steps 等内部字段类型上就进不来
import { describe, expect, test } from "bun:test";
import { projectAgentResult, stopReasonToPublicText, stopReasonToTaskState } from "../src/a2a/projection";
import { isTerminal, type Part } from "../src/a2a/types";

/** Part 是成员名联合，取文本先判成员存在 */
const textOf = (part: Part): string => ("text" in part ? part.text : "");

describe("A2A 投影", () => {
  test("正常回答 → COMPLETED + 唯一文本产物", () => {
    const projection = projectAgentResult({ finalAnswer: "结论是 X", stopReason: "answer", errorMessage: undefined });
    expect(projection.state).toBe("TASK_STATE_COMPLETED");
    expect(isTerminal(projection.state)).toBe(true);
    expect(projection.agentMessage.role).toBe("ROLE_AGENT");
    expect(projection.artifacts).toHaveLength(1);
    expect(projection.artifacts[0]!.parts[0]).toEqual({ text: "结论是 X" });
  });

  test("取消 → CANCELED，取消前的部分结果进消息但不进产物", () => {
    const projection = projectAgentResult({ finalAnswer: "取消前找到一半", stopReason: "cancelled", errorMessage: undefined });
    expect(projection.state).toBe("TASK_STATE_CANCELED");
    expect(projection.artifacts).toHaveLength(0); // 产物只属于成功交付
    expect(textOf(projection.agentMessage.parts[0]!)).toContain("取消前找到一半");
  });

  test("拒绝/过滤 → REJECTED；其余 → FAILED", () => {
    expect(stopReasonToTaskState("model_refusal")).toBe("TASK_STATE_REJECTED");
    expect(stopReasonToTaskState("content_filter")).toBe("TASK_STATE_REJECTED");
    expect(stopReasonToTaskState("error")).toBe("TASK_STATE_FAILED");
    expect(stopReasonToTaskState("budget_exceeded")).toBe("TASK_STATE_FAILED");
    expect(stopReasonToTaskState("iteration_limit")).toBe("TASK_STATE_FAILED");
    expect(stopReasonToTaskState("plan_incomplete")).toBe("TASK_STATE_FAILED");
  });

  test("失败原因的对外文案：单行、不携带内部诊断细节", () => {
    const text = stopReasonToPublicText("error", "ENOENT: no such file\n  at /secret/internal/path.ts:1:1\n    at deeper");
    expect(text).toContain("任务执行出错");
    expect(text).not.toContain("at deeper"); // 只保留第一行，异常栈不出站
    expect(stopReasonToPublicText("budget_exceeded")).toContain("预算");
  });

  test("成功但没有 finalAnswer：状态仍按 stopReason 映射，消息回退为公开文案", () => {
    const projection = projectAgentResult({ finalAnswer: null, stopReason: "empty_response", errorMessage: undefined });
    expect(projection.state).toBe("TASK_STATE_FAILED");
    expect(projection.artifacts).toHaveLength(0);
    expect(textOf(projection.agentMessage.parts[0]!)).toContain("未能产生有效输出");
  });

  test("序列化投影结果不含内部字段名（messages/steps/toolCalls 等）", () => {
    const projection = projectAgentResult({ finalAnswer: "答案", stopReason: "answer", errorMessage: undefined });
    const json = JSON.stringify(projection);
    expect(json).not.toContain('"messages"');
    expect(json).not.toContain('"steps"');
    expect(json).not.toContain('"toolCallsCount"');
    expect(json).not.toContain('"totalTokens"');
  });
});
