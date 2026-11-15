// tests/a2a_card.test.ts
// Agent Card 派生：接口地址/协议版本来自参数，skills 是业务能力不是工具目录
import { describe, expect, test } from "bun:test";
import { buildAgentCard } from "../src/a2a/agent_card";

describe("A2A Agent Card", () => {
  const card = buildAgentCard({ interfaceUrl: "http://127.0.0.1:8787/a2a" });

  test("接口声明：JSONRPC 绑定 + 协议版本只写 Major.Minor", () => {
    expect(card.supportedInterfaces).toHaveLength(1);
    const iface = card.supportedInterfaces[0]!;
    expect(iface.url).toBe("http://127.0.0.1:8787/a2a");
    expect(iface.protocolBinding).toBe("JSONRPC");
    expect(iface.protocolVersion).toBe("1.0");
    expect(iface.protocolVersion.split(".")).toHaveLength(2); // 不带 patch
  });

  test("能力声明如实：流式开、推送关、无扩展", () => {
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.extensions).toBeUndefined();
    expect(card.capabilities.extendedAgentCard).toBeUndefined();
  });

  test("不声明 tenant（没有实现多租户就不宣称）", () => {
    expect(card.supportedInterfaces[0]!.tenant).toBeUndefined();
  });

  test("skills 描述业务能力，不含内部工具名", () => {
    expect(card.skills.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(card.skills);
    for (const internalTool of ["run_script", "delegate_task", "bili_collect", "filesystem__"]) {
      expect(serialized).not.toContain(internalTool);
    }
    expect(card.skills[0]!.tags.length).toBeGreaterThan(0);
  });

  test("版本有值（package.json 或开发版号），可作为 ETag", () => {
    expect(card.version).toMatch(/^[\w.\-]+$/);
  });

  test("缺省输入输出模式是 MIME 列表", () => {
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.defaultOutputModes).toContain("text/plain");
  });
});
