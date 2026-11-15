// tests/a2a_wire.test.ts
// 线格式防线：camelCase 键、Part oneof、状态机辅助、时间戳格式（进阶篇第 3 章的五类易错点）
import { describe, expect, test } from "bun:test";
import {
  a2aTimestamp,
  isInterrupted,
  isTerminal,
  isValidPart,
  parseInboundMessage,
  partKind,
  partsToText,
  type Artifact,
  type Task,
} from "../src/a2a/types";

describe("A2A 线格式", () => {
  test("序列化后的键名不允许出现 snake_case（规范 5.5）", () => {
    const task: Task = {
      id: "t1",
      contextId: "c1",
      status: { state: "TASK_STATE_WORKING", timestamp: a2aTimestamp() },
      artifacts: [{ artifactId: "a1", name: "最终回答", parts: [{ text: "hello" }] }],
      metadata: { source: "unit-test" },
    };
    const json = JSON.stringify(task);
    // 挡住 proto snake_case 字段漂移（context_id / message_id / task_id / protocol_version ...）
    expect(json).not.toMatch(/"[a-z]+_[a-z]+"\s*:/);
  });

  test("Part 的成员名 oneof：恰好一个内容成员", () => {
    expect(isValidPart({ text: "hi" })).toBe(true);
    expect(isValidPart({ data: { any: "json" } })).toBe(true);
    expect(isValidPart({ raw: "binary", mediaType: "image/png" })).toBe(true);
    expect(isValidPart({ url: "https://example.com" })).toBe(true);
    // 两个内容成员：v0.3 时代的混合写法必须拒绝
    expect(isValidPart({ text: "hi", data: { x: 1 } })).toBe(false);
    // 多余的未知字段（如 v0.3 残留的 kind）按规范宽容忽略，不影响成员判别
    expect(isValidPart({ text: "hi", kind: "text" })).toBe(true);
    expect(isValidPart({ kind: "text" })).toBe(false);
    expect(isValidPart("not an object")).toBe(false);
  });

  test("partKind 返回唯一成员名，多成员返回 null", () => {
    expect(partKind({ text: "hi" })).toBe("text");
    expect(partKind({ data: 1 })).toBe("data");
    expect(partKind({ text: "a", url: "b" } as never)).toBeNull();
  });

  test("终态/中断态判断：CANCELED 单 L，INPUT_REQUIRED 不是终态", () => {
    expect(isTerminal("TASK_STATE_COMPLETED")).toBe(true);
    expect(isTerminal("TASK_STATE_FAILED")).toBe(true);
    expect(isTerminal("TASK_STATE_CANCELED")).toBe(true);
    expect(isTerminal("TASK_STATE_REJECTED")).toBe(true);
    expect(isTerminal("TASK_STATE_WORKING")).toBe(false);
    expect(isTerminal("TASK_STATE_SUBMITTED")).toBe(false);
    expect(isInterrupted("TASK_STATE_INPUT_REQUIRED")).toBe(true);
    expect(isInterrupted("TASK_STATE_WORKING")).toBe(false);
  });

  test("时间戳是 ISO 8601 UTC 毫秒、Z 结尾", () => {
    expect(a2aTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("入站消息校验：role/messageId/parts 合规才放行", () => {
    const valid = { role: "ROLE_USER", messageId: "m1", parts: [{ text: "你好" }] };
    const parsed = parseInboundMessage(valid);
    expect(parsed.messageId).toBe("m1");
    expect(parsed.parts).toHaveLength(1);

    expect(() => parseInboundMessage({ ...valid, role: "user" })).toThrow(); // v0.3 小写 role
    expect(() => parseInboundMessage({ ...valid, messageId: "" })).toThrow();
    expect(() => parseInboundMessage({ ...valid, parts: [] })).toThrow();
    expect(() => parseInboundMessage({ ...valid, parts: [{ text: "a", data: 1 }] })).toThrow();
  });

  test("partsToText 提取文本；data 序列化；url/raw 标注占位", () => {
    const text = partsToText([{ text: "第一段" }, { data: { k: 1 } }, { url: "https://a.b" }, { raw: "x", filename: "a.bin" }]);
    expect(text).toContain("第一段");
    expect(text).toContain('"k":1');
    expect(text).toContain("https://a.b");
    expect(text).toContain("a.bin");
  });

  test("Artifacts 结构完整时也没有下划线键", () => {
    const artifact: Artifact = { artifactId: "a1", parts: [{ text: "内容" }], metadata: { "ext-uri": { v: 1 } } };
    const json = JSON.stringify(artifact);
    expect(json).toContain("artifactId");
    expect(json).not.toMatch(/"[a-z]+_[a-z]+"\s*:/);
  });
});
