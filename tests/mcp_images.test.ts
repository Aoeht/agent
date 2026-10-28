import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Agent, MAX_IMAGES_PER_REQUEST, MAX_REQUEST_IMAGE_BYTES } from "../src/core/agent";
import { isErrorObservation, ToolRegistry } from "../src/core/registry";
import { createToolSearchTool } from "../src/core/tool_search";
import type { ToolRuntime } from "../src/core/types";
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";
import type { McpAdapterOptions, McpAuditEvent } from "../src/mcp/types";
import { createReadImageTool } from "../src/tools/read_image";
import { PNG_1X1_BASE64 } from "./fixtures/mcp_image_server";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const TOOL = "images__capture";
const DATA_URL = `data:image/png;base64,${PNG_1X1_BASE64}`;
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  // Always close HTTP/MCP transports and remove generated files, including on assertion failure.
  const errors: unknown[] = [];
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "MCP image test cleanup failed");
});

const image = (data = PNG_1X1_BASE64, mimeType = "image/png") =>
  ({ type: "image" as const, data, mimeType });
const text = (value: string) => ({ type: "text" as const, text: value });
const resultOf = (...content: CallToolResult["content"]): CallToolResult => ({ content });
type Reply = CallToolResult | (() => CallToolResult | Promise<CallToolResult>);

async function inMemoryMcp(cases: Record<string, Reply>, options: McpAdapterOptions = {}) {
  const audit: McpAuditEvent[] = [];
  const calls: string[] = [];
  const adapter = new McpAdapter({
    allowedRoots: [ROOT], requestTimeoutMs: 2_000,
    ...options, onAudit: event => { audit.push(structuredClone(event)); options.onAudit?.(event); },
  });
  const server = new McpServer({ name: "p2-memory-images", version: "1.0.0" });
  server.registerTool("capture", {
    description: "Capture an image for the next model request",
    inputSchema: { case: z.string(), note: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async args => {
    calls.push(args.case);
    const reply = cases[args.case];
    if (!reply) throw new Error(`Unknown fixture case: ${args.case}`);
    return typeof reply === "function" ? await reply() : reply;
  });
  const client = new Client({ name: "p2-test-host", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  expect(await adapter.syncTools(client, "images")).toEqual([TOOL]);
  return {
    adapter, audit, calls, client, server,
    execute: (key: string, runtime?: ToolRuntime) => adapter.registry.execute(TOOL, { case: key }, runtime),
  };
}

function collector(accept = true) {
  const emitted: Array<{ dataUrl: string; label: string }> = [];
  const runtime: ToolRuntime = { emitImage: value => { emitted.push(value); return accept; } };
  return { emitted, runtime };
}

function noImageData(value: unknown, extraData: string[] = []) {
  const serialized = JSON.stringify(value) ?? "";
  // Test booleans rather than printing potentially multi-megabyte data on failures.
  expect(serialized.includes("data:image/")).toBe(false);
  for (const data of [PNG_1X1_BASE64, ...extraData]) {
    if (data) expect(serialized.includes(data)).toBe(false);
  }
}

function attached(value: string) {
  expect(value).toContain("已附加");
  expect(value).toContain("下一轮");
  expect(value).not.toContain("未附加");
  noImageData(value);
}

function notAttached(value: string, reason: RegExp) {
  expect(value).toContain("未附加");
  expect(value).not.toContain("已附加");
  expect(value).toMatch(reason);
  expect(isErrorObservation(value)).toBe(false);
  noImageData(value);
}

describe("P2 MCP adapter image channel (real SDK / InMemoryTransport)", () => {
  test("golden: pure image emits the complete data URL and a namespaced label", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(image()) });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("png", runtime);
    expect(mcp.calls).toEqual(["png"]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.dataUrl).toBe(DATA_URL);
    expect(emitted[0]!.label).toContain(TOOL);
    expect(emitted[0]!.label).toMatch(/1/);
    attached(observation);
  });

  test("mixed text, embedded resource text and multiple images retain order and numbered labels", async () => {
    const mcp = await inMemoryMcp({ mixed: resultOf(
      text("正文开头"), image(),
      { type: "resource", resource: { uri: "note://local/context", mimeType: "text/plain", text: "资源正文" } },
      image(PNG_1X1_BASE64.replace(/=+$/, "")), text("正文结尾"),
    ) });
    const { runtime, emitted } = collector();
    const observation = JSON.parse(await mcp.execute("mixed", runtime)) as string;
    expect(emitted).toHaveLength(2);
    expect(emitted.map(item => item.dataUrl)).toEqual([DATA_URL, DATA_URL.replace(/=+$/, "")]);
    expect(new Set(emitted.map(item => item.label)).size).toBe(2);
    for (const [index, item] of emitted.entries()) {
      expect(item.label).toContain(TOOL);
      expect(item.label).toContain(String(index + 1));
    }
    expect(observation.indexOf("已附加")).toBeLessThan(observation.indexOf("正文开头"));
    expect(observation.indexOf("正文开头")).toBeLessThan(observation.indexOf("资源正文"));
    expect(observation.indexOf("资源正文")).toBeLessThan(observation.indexOf("正文结尾"));
    attached(observation);
  });

  test.each(["accepted", "quota", "invalid"] as const)(
    "long text truncation preserves the image status prefix: %s", async mode => {
      const limit = 480;
      // Empty base64 passes the SDK schema, so the adapter must reject it per block.
      const mcp = await inMemoryMcp({ long: resultOf(text("BODY:" + "x".repeat(4_000)),
        mode === "invalid" ? image("") : image()) }, { maxResultChars: limit });
      const { runtime, emitted } = collector(mode !== "quota");
      const observation = JSON.parse(await mcp.execute("long", runtime));
      expect(typeof observation).toBe("string");
      const prefix = observation.slice(0, observation.indexOf("BODY:"));
      expect(observation).toContain("BODY:");
      expect(observation).toContain("[truncated");
      expect(observation.length).toBeLessThan(limit + 100);
      if (mode === "accepted") {
        attached(prefix);
        expect(emitted).toHaveLength(1);
        expect(emitted[0]!.dataUrl).toBe(DATA_URL);
      } else {
        notAttached(prefix, mode === "quota" ? /配额|上限|拒绝|结束|限制|通道/ : /base64|空/i);
        expect(emitted).toHaveLength(mode === "quota" ? 1 : 0);
      }
      noImageData(observation);
    });

  test.each([
    { count: 9, limit: 480, structured: false, accept: 0 },
    { count: 9, limit: 480, structured: true, accept: 2 },
    { count: 300, limit: 20_000, structured: false, accept: 0 },
    { count: 300, limit: 20_000, structured: true, accept: 8 },
  ])("many image statuses preserve the body: %j", async ({ count, limit, structured, accept }) => {
    const content = [text("必须保留的正文"), ...Array.from({ length: count }, () => image())];
    const mcp = await inMemoryMcp({ many: { content,
      ...(structured ? { structuredContent: { answer: "必须保留的正文" } } : {}) } }, { maxResultChars: limit });
    let attempts = 0;
    const observation = await mcp.execute("many", { emitImage: () => ++attempts <= accept });
    expect(attempts).toBe(count);
    expect(observation).toContain("必须保留的正文");
    expect(observation).toContain(`已附加 ${accept} 张`);
    expect(observation).toContain(`未附加 ${count - accept} 张`);
    expect(observation).toContain("配额");
    expect(observation).toContain("逐图详情已省略");
    noImageData(observation);
  });

  test("structuredContent plus images returns the image status envelope, without mutating structured data", async () => {
    const structuredContent = { total: 2, nested: { hits: ["a", "b"] }, images: ["original field"] };
    const original = structuredClone(structuredContent);
    const mcp = await inMemoryMcp({ typed: { content: [text("legacy text"), image(), image()], structuredContent } });
    const { runtime, emitted } = collector();
    const observation = JSON.parse(await mcp.execute("typed", runtime));
    expect(observation.structuredContent).toEqual(original);
    expect(Object.keys(observation).sort()).toEqual(["images", "structuredContent"]);
    expect(observation.images).toHaveLength(2);
    for (const status of observation.images) attached(status);
    expect(emitted).toHaveLength(2);
    expect(structuredContent).toEqual(original);
    noImageData(observation);
  });

  test.each([true, false])("nested structured image copies are sanitized without changing business data: %s", async accept => {
    const structuredContent = { nested: [{ preview: image(), caption: "保留描述" }],
      business: { type: "record", data: "保留数据", mimeType: "text/plain" } };
    const original = structuredClone(structuredContent);
    const mcp = await inMemoryMcp({ typed: { content: [image()], structuredContent } });
    const { runtime, emitted } = collector(accept);
    const observation = JSON.parse(await mcp.execute("typed", runtime));
    expect(emitted).toHaveLength(1);
    expect(observation.structuredContent.business).toEqual(original.business);
    expect(observation.structuredContent.nested[0].caption).toBe("保留描述");
    expect(observation.structuredContent.nested[0].preview.data).toContain("已省略");
    expect(structuredContent).toEqual(original);
    noImageData([observation, mcp.audit]);
    if (accept) attached(observation.images[0]);
    else notAttached(observation.images[0], /配额/);
  });

  test.each(["missing", "false"] as const)("structured image refusal preserves the original object: %s", async mode => {
    const structuredContent = { answer: "正文仍可用", ok: true };
    const mcp = await inMemoryMcp({ typed: { content: [image()], structuredContent } });
    const { runtime, emitted } = collector(false);
    const observation = JSON.parse(await mcp.execute("typed", mode === "missing" ? undefined : runtime));
    expect(observation.structuredContent).toEqual(structuredContent);
    expect(observation.images).toHaveLength(1);
    notAttached(observation.images[0], mode === "missing" ? /通道|视觉/ : /配额|上限|拒绝|结束|限制|通道/);
    expect(emitted).toHaveLength(mode === "missing" ? 0 : 1);
  });

  test("structured image envelope uses the existing formatStructured truncation budget", async () => {
    const limit = 480;
    const mcp = await inMemoryMcp({ typed: { content: [image()], structuredContent: { body: "x".repeat(4_000) } } },
      { maxResultChars: limit });
    const { runtime, emitted } = collector();
    const observation = JSON.parse(await mcp.execute("typed", runtime));
    expect(typeof observation).toBe("string");
    expect(observation).toContain('"images"');
    expect(observation.indexOf('"images"')).toBeLessThan(observation.indexOf('"structuredContent"'));
    attached(observation);
    expect(observation).toContain("[truncated");
    expect(observation.length).toBeLessThan(limit + 100);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.dataUrl).toBe(DATA_URL);
  });

  test("no-image structured data and pure-text JSON retain their previous behavior", async () => {
    const structuredContent = { total: 2, hits: ["a", "b"] };
    for (const parseJsonText of [true, false]) {
      const mcp = await inMemoryMcp({
        typed: { content: [text("ignored legacy text")], structuredContent },
        json: resultOf(text('{"ok":true,"hits":[1]}')),
        plain: resultOf(text("one"), text("two")),
      }, { parseJsonText });
      const { runtime, emitted } = collector();
      expect(JSON.parse(await mcp.execute("typed", runtime))).toEqual(structuredContent);
      expect(JSON.parse(await mcp.execute("json", runtime))).toEqual(
        parseJsonText ? { ok: true, hits: [1] } : '{"ok":true,"hits":[1]}');
      expect(JSON.parse(await mcp.execute("plain", runtime))).toBe("one\ntwo");
      expect(emitted).toHaveLength(0);
    }
  });

  test.each(["missing", "false"] as const)("unavailable image channel does not fake success or lose text: %s", async mode => {
    const mcp = await inMemoryMcp({ mixed: resultOf(text("保留正文"), image(), text("结尾")) });
    const { runtime, emitted } = collector(false);
    const observation = await mcp.execute("mixed", mode === "missing" ? undefined : runtime);
    notAttached(observation, mode === "missing" ? /通道|视觉/ : /配额|上限|拒绝|结束|限制|通道/);
    expect(observation).toContain("保留正文");
    expect(observation).toContain("结尾");
    expect(emitted).toHaveLength(mode === "missing" ? 0 : 1);
  });

  test("each emitImage boolean is honored independently", async () => {
    const mcp = await inMemoryMcp({ mixed: { content: [image(), image(), image()], structuredContent: { ok: true } } });
    let calls = 0;
    const observation = JSON.parse(await mcp.execute("mixed", { emitImage: () => ++calls !== 2 }));
    expect(calls).toBe(3);
    expect(observation.images).toHaveLength(3);
    attached(observation.images[0]);
    notAttached(observation.images[1], /配额|上限|拒绝|结束|限制|通道/);
    attached(observation.images[2]);
  });

  test.each(["image/png", "image/jpeg", "image/webp", "image/gif"])(
    "supported MIME %s is passed through without pixel decoding", async mime => {
      // Syntactically valid base64, deliberately not a decodable raster.
      const data = Buffer.from("opaque transport bytes").toString("base64");
      const mcp = await inMemoryMcp({ valid: resultOf(image(data, mime)) });
      const { runtime, emitted } = collector();
      attached(await mcp.execute("valid", runtime));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.dataUrl).toBe(`data:${mime};base64,${data}`);
    });

  test.each(["YQ==", "YWI=", "YQ", "YWI"])("valid padded/unpadded base64 is accepted: %s", async data => {
    const mcp = await inMemoryMcp({ valid: resultOf(image(data)) });
    const { runtime, emitted } = collector();
    attached(await mcp.execute("valid", runtime));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.dataUrl).toBe(`data:image/png;base64,${data}`);
  });

  test.each(["image/svg+xml", "text/plain", "image/bmp", "image/jpg", "image/png;evil=1"])(
    "invalid MIME is never emitted and text survives: %s", async mime => {
      const mcp = await inMemoryMcp({ invalid: resultOf(text("安全正文"), image(PNG_1X1_BASE64, mime)) });
      const { runtime, emitted } = collector();
      const observation = await mcp.execute("invalid", runtime);
      expect(emitted).toHaveLength(0);
      notAttached(observation, /MIME|格式|类型/i);
      expect(observation).toContain("安全正文");
    });

  test.each(["", "not!base64", "A", "A===", "Y=Q=", "YQ===", "YQ==junk", "Y Q==", "-_8="])(
    "adapter rejects malformed base64 supplied by middleware without losing text: %j", async data => {
      // Inject after SDK validation to exercise the adapter boundary independently.
      const mcp = await inMemoryMcp({ invalid: resultOf(text("安全正文"), image()) }, {
        middlewares: [async (_args, _context, next) => {
          const result = await next();
          return { ...result, content: result.content.map(block => block.type === "image" ? { ...block, data } : block) };
        }],
      });
      const { runtime, emitted } = collector();
      const observation = await mcp.execute("invalid", runtime);
      expect(mcp.calls).toEqual(["invalid"]);
      expect(emitted).toHaveLength(0);
      notAttached(observation, /base64|空/i);
      expect(observation).toContain("安全正文");
      if (data.length > 3) noImageData(observation, [data]);
    });

  test.each(["", "Y Q=="])("SDK-admitted but invalid base64 preserves text through the real wire: %j", async data => {
    const mcp = await inMemoryMcp({ invalid: resultOf(text("安全正文"), image(data)) });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("invalid", runtime);
    expect(emitted).toHaveLength(0);
    notAttached(observation, /base64|空/i);
    expect(observation).toContain("安全正文");
    if (data) noImageData(observation, [data]);
  });

  test("SDK rejects malformed wire base64 before formatting, with no emission or data leak", async () => {
    const mcp = await inMemoryMcp({ invalid: resultOf(text("server-side text"), image("not!base64")) });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("invalid", runtime);
    expect(mcp.calls).toEqual(["invalid"]);
    expect(isErrorObservation(observation)).toBe(true);
    expect(observation).toContain("Invalid Base64 string");
    expect(observation).not.toContain("已附加");
    expect(emitted).toHaveLength(0);
    noImageData([observation, mcp.audit], ["not!base64"]);
  });

  test("invalid siblings do not prevent a valid image or text from being delivered", async () => {
    const mcp = await inMemoryMcp({ mixed: resultOf(image(""), text("可用正文"), image(), image("YQ==", "text/html")) });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("mixed", runtime);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.dataUrl).toBe(DATA_URL);
    expect(observation.match(/未附加/g)).toHaveLength(2);
    expect(observation.match(/已附加/g)).toHaveLength(1);
    expect(observation).toContain("可用正文");
    noImageData(observation, ["not!base64"]);
    expect(isErrorObservation(observation)).toBe(false);
  });

  test("cancellation after tools/call returns does not emit and preserves the received text", async () => {
    const abort = new AbortController();
    const mcp = await inMemoryMcp({ png: resultOf(text("取消前已返回的正文"), image()) }, {
      middlewares: [async (_args, _context, next) => {
        const result = await next();
        abort.abort(); // deterministic return/format boundary, no timing or sleep
        return result;
      }],
    });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("png", { ...runtime, signal: abort.signal });
    expect(mcp.calls).toEqual(["png"]);
    expect(emitted).toHaveLength(0);
    notAttached(observation, /取消|中止|终止|abort/i);
    expect(observation).toContain("取消前已返回的正文");
  });

  test("cancellation between image blocks stops subsequent emits", async () => {
    const abort = new AbortController();
    const mcp = await inMemoryMcp({ png: { content: [image(), image()], structuredContent: { text: "仍保留" } } });
    let emits = 0;
    const observation = JSON.parse(await mcp.execute("png", {
      signal: abort.signal, emitImage: () => { emits++; abort.abort(); return true; },
    }));
    expect(emits).toBe(1);
    attached(observation.images[0]);
    notAttached(observation.images[1], /取消|中止|终止|abort/i);
    expect(observation.structuredContent).toEqual({ text: "仍保留" });
  });

  test("an already aborted SDK call never emits an image", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(image()) });
    const { runtime, emitted } = collector();
    const abort = new AbortController();
    abort.abort();
    const observation = await mcp.execute("png", { ...runtime, signal: abort.signal });
    expect(emitted).toHaveLength(0);
    expect(observation).not.toContain("已附加");
    noImageData(observation);
  });

  test("MCP isError images are never emitted, even with structuredContent", async () => {
    const mcp = await inMemoryMcp({ error: { content: [text("capture failed"), image()],
      structuredContent: { ok: false }, isError: true } });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("error", runtime);
    expect(isErrorObservation(observation)).toBe(true);
    expect(observation).toContain("MCP Tool Error");
    expect(observation).toContain("capture failed");
    expect(emitted).toHaveLength(0);
    noImageData([observation, mcp.audit]);
  });

  test("policy refusal prevents the real MCP handler from running or emitting", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(image()) }, { toolPolicy: () => "deny" });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("png", runtime);
    expect(observation).toContain("Policy Denied");
    expect(mcp.calls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(mcp.audit.map(event => event.phase)).toEqual(["started", "denied"]);
    noImageData([observation, mcp.audit]);
  });

  test("middleware rejection after an SDK response still prevents image emission", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(image()) }, {
      middlewares: [async (_args, _context, next) => { await next(); throw new Error("blocked by middleware"); }],
    });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("png", runtime);
    expect(mcp.calls).toEqual(["png"]);
    expect(observation).toContain("blocked by middleware");
    expect(emitted).toHaveLength(0);
    noImageData([observation, mcp.audit]);
  });

  test("audit contains only metadata, not image data or raw string arguments", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(image()) });
    const { runtime } = collector();
    const observation = await mcp.adapter.registry.execute(TOOL, { case: "png", note: PNG_1X1_BASE64 }, runtime);
    expect(mcp.audit.map(event => event.phase)).toEqual(["started", "completed"]);
    expect(mcp.audit[1]!.args.note).toBe(`[string ${PNG_1X1_BASE64.length} chars]`);
    expect(mcp.audit[1]!.resultChars).toBeGreaterThan(0);
    noImageData([observation, mcp.audit]);
  });

  test("MCP has no extra 7 MiB per-image limit before the existing Agent encoded-byte budget", async () => {
    const data = Buffer.alloc(8 * 1024 * 1024, 0x61).toString("base64");
    expect(Buffer.byteLength(`data:image/png;base64,${data}`)).toBeLessThan(MAX_REQUEST_IMAGE_BYTES);
    const mcp = await inMemoryMcp({ large: resultOf(image(data)) });
    const { runtime, emitted } = collector();
    const observation = await mcp.execute("large", runtime);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.dataUrl === `data:image/png;base64,${data}`).toBe(true);
    attached(observation);
    noImageData(observation, [data]);
  });
});

// Capture wire JSON so later history mutation cannot change earlier requests.
function localLlm(handler: (index: number, request: any) => unknown) {
  const payloads: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body: any = await request.json();
    payloads.push(body);
    const reply = handler(payloads.length - 1, body);
    if (reply instanceof Response) return reply;
    if (body.stream) {
      const response = reply as ReturnType<typeof finalReply>;
      const choice = response.choices[0]!;
      const message: any = choice.message;
      const delta = { role: "assistant", content: message.content,
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call: any, index: number) => ({ ...call, index })) } : {}) };
      const chunk = { id: "p2-test", object: "chat.completion.chunk", model: "test", created: 0,
        choices: [{ index: 0, delta, finish_reason: choice.finish_reason }], usage };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } });
    }
    return Response.json(reply);
  } });
  cleanup.push(async () => { await server.stop(true); });
  const client = new OpenAI({ apiKey: "local-test-only", baseURL: `http://127.0.0.1:${server.port}/v1`, maxRetries: 0 });
  return { client, payloads };
}

function call(name: string, id: string, args: Record<string, unknown> = {}) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}
const mcpCall = (id: string, key = "png") => call(TOOL, id, { case: key });
const toolReply = (...calls: ReturnType<typeof call>[]) => ({
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }], usage,
});
const finalReply = (content = "本地测试完成") => ({
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage,
});
const imagesIn = (request: any): Array<{ type: "image_url"; image_url: { url: string } }> =>
  request.messages.flatMap((message: any) => Array.isArray(message.content)
    ? message.content.filter((part: any) => part.type === "image_url") : []);
const observationOf = (request: any, id: string): string =>
  String(request.messages.find((message: any) => message.role === "tool" && message.tool_call_id === id)?.content ?? "");

function makeAgent(tools: ToolRegistry, client: OpenAI, options: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const agent = new Agent({ model: "test", systemPrompt: "Local test; never use external services.",
    tools, client, maxRetries: 0, maxIterations: 8, toolSearch: "off", ...options });
  const events: unknown[] = [];
  for (const name of ["run_start", "run_end", "step", "token", "tool_start", "tool_progress", "tool_end",
    "task_update", "compact", "retry", "plan_update"] as const) {
    agent.events.on(name, payload => events.push({ name, payload: structuredClone(payload) }));
  }
  return { agent, events };
}

async function localPngFile() {
  // Runtime-only file, confined to the permitted test tree and removed by afterEach.
  const root = await fs.mkdtemp(path.join(FIXTURES, "mcp-images-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "tiny.png"), Buffer.from(PNG_1X1_BASE64, "base64"));
  return root;
}

describe("P2 Agent + real MCP + local mock LLM", () => {
  test("golden Agent: next request has image_url, later turns and messages/steps/events do not replay base64", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(text("MCP正文"), image()), text: resultOf(text("只返回文字")) });
    const { client, payloads } = localLlm(index => index === 0 ? toolReply(mcpCall("image-1"))
      : index === 1 ? toolReply(mcpCall("text-2", "text")) : finalReply());
    const { agent, events } = makeAgent(mcp.adapter.registry, client);
    const result = await agent.run("查看 MCP 图片，然后读取文字");
    expect(result.success).toBe(true);
    expect(payloads).toHaveLength(3);
    expect(imagesIn(payloads[0])).toHaveLength(0);
    expect(imagesIn(payloads[1])).toHaveLength(1);
    expect(imagesIn(payloads[1])[0]!.image_url.url).toBe(DATA_URL);
    attached(observationOf(payloads[1], "image-1"));
    expect(JSON.stringify(payloads[1].messages)).toContain(TOOL);
    expect(imagesIn(payloads[2])).toHaveLength(0);
    noImageData(payloads[2]);
    noImageData([result.messages, result.steps, result, events, mcp.audit]);
    expect(events.some((event: any) => event.name === "step")).toBe(true);
    expect(events.some((event: any) => event.name === "tool_end")).toBe(true);
  });

  test("visionCapable=false preserves MCP text but does not attach or claim success", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(text("文字可用"), image()) });
    const { client, payloads } = localLlm(index => index === 0 ? toolReply(mcpCall("image-1")) : finalReply());
    const { agent, events } = makeAgent(mcp.adapter.registry, client, { visionCapable: false });
    const result = await agent.run("看图");
    expect(result.success).toBe(true);
    expect(agent.visionEnabled).toBe(false);
    expect(payloads).toHaveLength(2);
    expect(imagesIn(payloads[1])).toHaveLength(0);
    notAttached(observationOf(payloads[1], "image-1"), /通道|视觉/);
    expect(observationOf(payloads[1], "image-1")).toContain("文字可用");
    noImageData([payloads, result, events]);
  });

  test("invalid images and MCP errors never contaminate a model request", async () => {
    const mcp = await inMemoryMcp({
      invalid: resultOf(text("有效正文"), image(""), image(PNG_1X1_BASE64, "image/svg+xml")),
      error: { content: [text("server error"), image()], isError: true },
    });
    const { client, payloads } = localLlm(index => index === 0
      ? toolReply(mcpCall("invalid", "invalid"), mcpCall("error", "error")) : finalReply());
    const { agent, events } = makeAgent(mcp.adapter.registry, client);
    const result = await agent.run("获取图片");
    expect(result.success).toBe(true);
    expect(imagesIn(payloads[1])).toHaveLength(0);
    expect(observationOf(payloads[1], "invalid")).toContain("有效正文");
    expect(observationOf(payloads[1], "invalid").match(/未附加/g)).toHaveLength(2);
    expect(observationOf(payloads[1], "error")).toContain("MCP Tool Error");
    noImageData([payloads, result, events, mcp.audit], ["not!base64"]);
  });

  test.each([false, true])("read_image and MCP share the same 8-image quota, MCP first=%s", async mcpFirst => {
    const root = await localPngFile();
    const mcp = await inMemoryMcp({ png: resultOf(image()) });
    mcp.adapter.registry.register(createReadImageTool({ sandboxRoot: root }));
    const first = mcpFirst ? Array.from({ length: MAX_IMAGES_PER_REQUEST }, (_, i) => mcpCall(`m${i}`))
      : Array.from({ length: MAX_IMAGES_PER_REQUEST }, (_, i) => call("read_image", `r${i}`, { path: "tiny.png" }));
    const overflow = mcpFirst ? call("read_image", "overflow", { path: "tiny.png" }) : mcpCall("overflow");
    const { client, payloads } = localLlm(index => index === 0 ? toolReply(...first, overflow) : finalReply());
    // Deterministic quota winner; the Agent still owns the budget used by both tools.
    const { agent, events } = makeAgent(mcp.adapter.registry, client, { parallelToolCalls: false });
    const result = await agent.run("按序读取这些图片");
    expect(result.success).toBe(true);
    expect(imagesIn(payloads[1])).toHaveLength(MAX_IMAGES_PER_REQUEST);
    for (const firstCall of first) attached(observationOf(payloads[1], firstCall.id));
    const rejected = observationOf(payloads[1], "overflow");
    expect(rejected).toContain(mcpFirst ? "未能附加" : "未附加");
    expect(rejected).not.toContain("已附加");
    noImageData([result, events, mcp.audit]);
  });

  test("MCP uses the 20 MiB encoded-byte budget, allows >7 MiB raw, and resets next turn", async () => {
    const data = Buffer.alloc(8 * 1024 * 1024, 0x61).toString("base64");
    const dataUrl = `data:image/png;base64,${data}`;
    expect(Buffer.byteLength(dataUrl)).toBeLessThan(MAX_REQUEST_IMAGE_BYTES);
    expect(Buffer.byteLength(dataUrl) * 2).toBeGreaterThan(MAX_REQUEST_IMAGE_BYTES);
    const mcp = await inMemoryMcp({ big: resultOf(text("大图正文"), image(data)) });
    const { client, payloads } = localLlm(index => index === 0 ? toolReply(mcpCall("big-1", "big"), mcpCall("big-2", "big"))
      : index === 1 ? toolReply(mcpCall("big-next", "big")) : finalReply());
    const { agent, events } = makeAgent(mcp.adapter.registry, client, { parallelToolCalls: false });
    const result = await agent.run("读取大图后下一轮再读");
    expect(result.success).toBe(true);
    expect(payloads).toHaveLength(3);
    expect(imagesIn(payloads[1])).toHaveLength(1);
    expect(imagesIn(payloads[1])[0]!.image_url.url === dataUrl).toBe(true);
    attached(observationOf(payloads[1], "big-1"));
    notAttached(observationOf(payloads[1], "big-2"), /配额|上限|拒绝|结束|限制|通道/);
    expect(imagesIn(payloads[2])).toHaveLength(1);
    attached(observationOf(payloads[2], "big-next"));
    noImageData([result, events, mcp.audit], [data]);
  }, 20_000);

  test.each([false, true])("provider 413 drops MCP images once without disabling vision, stream=%s", async stream => {
    const mcp = await inMemoryMcp({ png: resultOf(image()) });
    let rejected = 0;
    const { client, payloads } = localLlm((index, request) => {
      if (index === 0) return toolReply(mcpCall("image-1"));
      if (imagesIn(request).length) {
        rejected++;
        return Response.json({ error: { message: "Payload Too Large", type: "invalid_request_error" } }, { status: 413 });
      }
      return finalReply("图片未发送");
    });
    const { agent, events } = makeAgent(mcp.adapter.registry, client, { stream });
    const result = await agent.run("看图");
    expect(result.success).toBe(true);
    expect(rejected).toBe(1);
    expect(payloads).toHaveLength(3);
    expect(imagesIn(payloads[1])).toHaveLength(1);
    expect(imagesIn(payloads[2])).toHaveLength(0);
    expect(JSON.stringify(payloads[2].messages)).toContain("图片未发送");
    expect(observationOf(payloads[2], "image-1")).not.toBe("");
    expect(agent.visionEnabled).toBe(true);
    noImageData([payloads[2], result, events, mcp.audit]);
  });

  test("tool_search activates a real MCP image tool before delivering its image", async () => {
    const mcp = await inMemoryMcp({ png: resultOf(image()) });
    mcp.adapter.registry.register(createToolSearchTool({ registry: mcp.adapter.registry }));
    const { client, payloads } = localLlm(index => index === 0
      ? toolReply(call("tool_search", "search-1", { query: TOOL }))
      : index === 1 ? toolReply(mcpCall("image-1")) : finalReply());
    const { agent, events } = makeAgent(mcp.adapter.registry, client, { toolSearch: "on" });
    const result = await agent.run("查找并使用 MCP 图片工具");
    expect(result.success).toBe(true);
    expect(payloads[0].tools.map((tool: any) => tool.function.name)).not.toContain(TOOL);
    expect(payloads[1].tools.map((tool: any) => tool.function.name)).toContain(TOOL);
    expect(mcp.adapter.registry.isToolActivated(TOOL)).toBe(true);
    expect(mcp.calls).toEqual(["png"]);
    expect(imagesIn(payloads[1])).toHaveLength(0);
    expect(imagesIn(payloads[2])).toHaveLength(1);
    expect(imagesIn(payloads[2])[0]!.image_url.url).toBe(DATA_URL);
    noImageData([result, events, mcp.audit]);
  });

  test("stdio child end-to-end: fixed PNG reaches the next real HTTP model request", async () => {
    const audit: McpAuditEvent[] = [];
    const adapter = new McpAdapter({ allowedRoots: [ROOT], onAudit: event => audit.push(event) });
    const manager = new McpClientManager(adapter);
    cleanup.push(() => manager.closeAll());
    const names = await manager.addServer({
      id: "stdio_images", transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/mcp_image_server.ts", import.meta.url))],
      cwd: ROOT, stderr: "pipe", connectTimeoutMs: 10_000, requestTimeoutMs: 5_000,
    });
    expect(names).toEqual(["stdio_images__capture"]);
    const { client, payloads } = localLlm(index => index === 0
      ? toolReply(call("stdio_images__capture", "stdio-1")) : finalReply());
    const { agent, events } = makeAgent(adapter.registry, client);
    const result = await agent.run("读取本地 MCP 子进程提供的小图");
    expect(result.success).toBe(true);
    expect(payloads).toHaveLength(2);
    expect(observationOf(payloads[1], "stdio-1")).toContain("stdio-fixed-png");
    expect(imagesIn(payloads[1])).toHaveLength(1);
    expect(imagesIn(payloads[1])[0]!.image_url.url).toBe(DATA_URL);
    attached(observationOf(payloads[1], "stdio-1"));
    noImageData([result, events, audit]);
    await manager.closeAll();
    expect(adapter.registry.has("stdio_images__capture")).toBe(false);
  }, 20_000);
});
