// tests/user_images.test.ts
// 用户上传图片（Web 附件 / CLI /image）的完整链路：
//   - 共享校验：张数、单张大小、请求总量、MIME、base64、命名清洗
//   - CLI 读取本地文件（按文件头判格式）
//   - Agent：图片随本轮每次请求发送、跨轮不重放、不落历史/事件/步骤；视觉关闭时如实说明
//   - 8 张配额与工具图片共享；413 丢弃后不再重挂
//   - 服务器：非法输入/视觉关闭/斜杠命令带图直接拒绝；run_start 只带元数据
// 运行: bun test ./tests/user_images.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { Agent, MAX_IMAGES_PER_REQUEST, MAX_REQUEST_IMAGE_BYTES } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { defineTool } from "../src/core/types";
import { loadAgentConfig } from "../src/config";
import {
  MAX_USER_IMAGE_BYTES,
  UserImageError,
  base64Size,
  formatImageSize,
  prepareUserImages,
  readLocalImageFiles,
} from "../src/core/user_images";
import { EventHub, SessionManager } from "../src/server/sessions";
import { UiBridge } from "../src/server/bridge";
import type { ServerRuntime } from "../src/server/runtime";
import type { ServerEvent } from "../src/server/protocol";
import { PNG_1X1_BASE64 } from "./fixtures/mcp_image_server";

const DATA_URL = `data:image/png;base64,${PNG_1X1_BASE64}`;
const PNG_BYTES = Buffer.from(PNG_1X1_BASE64, "base64");
const image = (n = 1): { name: string; mimeType: string; dataUrl: string } =>
  ({ name: `shot-${n}.png`, mimeType: "image/png", dataUrl: DATA_URL });
const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };

const dirs: string[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* Windows 句柄晚一拍 */ }
  }
});

const bigDataUrl = (rawBytes: number, mime = "image/png") =>
  `data:${mime};base64,${Buffer.alloc(rawBytes, 0x61).toString("base64")}`;

describe("prepareUserImages（Web 与 CLI 共用的校验口径）", () => {
  test("合法图片归一化：默认名、MIME 与尺寸", () => {
    const [prepared] = prepareUserImages([image()]);
    expect(prepared).toBeDefined();
    expect(prepared!.name).toBe("shot-1.png");
    expect(prepared!.mimeType).toBe("image/png");
    expect(prepared!.sizeBytes).toBe(PNG_BYTES.length);
    expect(prepared!.encodedBytes).toBe(Buffer.byteLength(DATA_URL, "utf8"));
  });

  test("缺省名按序号生成；名字清洗控制字符与路径分隔符并截断", () => {
    const prepared = prepareUserImages([
      { dataUrl: DATA_URL },
      { name: "a\u0000b/c\\d.png", dataUrl: DATA_URL },
      { name: "x".repeat(120), dataUrl: DATA_URL },
    ]);
    expect(prepared[0]!.name).toBe("图片 1");
    expect(prepared[1]!.name).toBe("ab_c_d.png");
    expect(prepared[2]!.name.length).toBeLessThanOrEqual(80);
    expect(prepared[2]!.name.endsWith("…")).toBe(true);
  });

  test.each([
    { input: "not-an-array", reason: /数组/ },
    { input: [image(), image(2), image(3), image(4), image(5), image(6), image(7), image(8), image(9)], reason: new RegExp(`最多上传 ${MAX_IMAGES_PER_REQUEST}`) },
    { input: [{}], reason: /dataUrl/ },
    { input: [{ dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }], reason: /受支持的图片/ },
    { input: [{ dataUrl: "data:text/plain;base64,aGk=" }], reason: /受支持的图片/ },
    { input: [{ dataUrl: DATA_URL, mimeType: "image/jpeg" }], reason: /MIME/ },
    { input: [{ dataUrl: "data:image/png;base64,not base64!" }], reason: /base64/ },
  ])("拒绝畸形输入：$reason", ({ input, reason }) => {
    expect(() => prepareUserImages(input)).toThrow(reason);
    try { prepareUserImages(input); } catch (error) { expect(error).toBeInstanceOf(UserImageError); }
  });

  test("单张超过 7MiB 拒绝，总量超过 20MiB 也拒绝", () => {
    expect(() => prepareUserImages([{ dataUrl: bigDataUrl(MAX_USER_IMAGE_BYTES + 1) }]))
      .toThrow(/单张上限/);
    // 每张 7MiB 原图编码后约 9.3MiB：两张在额度内，三张总量超限
    const perImage = bigDataUrl(MAX_USER_IMAGE_BYTES - 1);
    expect(Buffer.byteLength(perImage)).toBeGreaterThan(MAX_REQUEST_IMAGE_BYTES / 3);
    expect(() => prepareUserImages([{ dataUrl: perImage }, { dataUrl: perImage }, { dataUrl: perImage }]))
      .toThrow(/总量超过上限/);
  });

  test("base64Size 与 formatImageSize 的边界", () => {
    expect(base64Size(PNG_1X1_BASE64)).toBe(PNG_BYTES.length);
    expect(base64Size("a")).toBeUndefined();
    expect(base64Size("a===")).toBeUndefined();
    expect(base64Size("ab==")).toBe(1);
    expect(formatImageSize(512)).toBe("512B");
    expect(formatImageSize(2048)).toBe("2KB");
    expect(formatImageSize(2 * 1024 * 1024)).toBe("2.0MB");
  });
});

describe("readLocalImageFiles（CLI /image）", () => {
  const gif = Buffer.from("GIF89a", "ascii");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);

  async function fixtureDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "user-images-"));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "tiny.png"), PNG_BYTES);
    await fs.writeFile(path.join(dir, "tiny.gif"), gif);
    await fs.writeFile(path.join(dir, "tiny.webp"), webp);
    await fs.writeFile(path.join(dir, "tiny.jpg"), jpeg);
    await fs.writeFile(path.join(dir, "notes.txt"), "not an image");
    await fs.writeFile(path.join(dir, "big.png"), Buffer.alloc(MAX_USER_IMAGE_BYTES + 1));
    await fs.mkdir(path.join(dir, "folder.png"));
    return dir;
  }

  test("按文件头判定格式，返回文件名与 data URL", async () => {
    const dir = await fixtureDir();
    const uploads = await readLocalImageFiles(
      ["tiny.png", "tiny.gif", "tiny.webp", "tiny.jpg"].map(name => path.join(dir, name))
    );
    expect(uploads.map(upload => upload.mimeType)).toEqual(["image/png", "image/gif", "image/webp", "image/jpeg"]);
    expect(uploads.map(upload => upload.name)).toEqual(["tiny.png", "tiny.gif", "tiny.webp", "tiny.jpg"]);
    for (const upload of uploads) expect(upload.dataUrl.startsWith(`data:${upload.mimeType};base64,`)).toBe(true);
    // 读出来的结果应能直接通过共享校验
    expect(prepareUserImages(uploads)).toHaveLength(4);
  });

  test.each([
    { file: "missing.png", reason: /不存在/ },
    { file: "notes.txt", reason: /不是支持的图片格式/ },
    { file: "big.png", reason: /图片过大/ },
    { file: "folder.png", reason: /不是文件/ },
  ])("拒绝 $file", async ({ file, reason }) => {
    const dir = await fixtureDir();
    await expect(readLocalImageFiles([path.join(dir, file)])).rejects.toThrow(reason);
  });
});

// ---------- Agent + 本地 mock LLM ----------

function localLlm(handler: (index: number, request: any) => unknown) {
  const payloads: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body: any = await request.json();
    payloads.push(body);
    const reply = handler(payloads.length - 1, body);
    if (reply instanceof Response) return reply;
    return Response.json(reply);
  } });
  cleanups.push(() => { void server.stop(true); });
  const client = new OpenAI({ apiKey: "local-test-only", baseURL: `http://127.0.0.1:${server.port}/v1`, maxRetries: 0 });
  return { client, payloads };
}

function call(name: string, id: string, args: Record<string, unknown> = {}) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}
const toolReply = (...calls: ReturnType<typeof call>[]) => ({
  choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }], usage,
});
const finalReply = (content = "本地测试完成") => ({
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage,
});
const imagesIn = (request: any) =>
  request.messages.flatMap((message: any) => Array.isArray(message.content)
    ? message.content.filter((part: any) => part.type === "image_url") : []);
const userText = (request: any) =>
  request.messages.filter((message: any) => message.role === "user" && typeof message.content === "string")
    .map((message: any) => message.content).join("\n");
const observationOf = (request: any, id: string) =>
  String(request.messages.find((message: any) => message.role === "tool" && message.tool_call_id === id)?.content ?? "");
const noImageData = (value: unknown) => {
  const serialized = JSON.stringify(value) ?? "";
  expect(serialized.includes("data:image/")).toBe(false);
  expect(serialized.includes(PNG_1X1_BASE64)).toBe(false);
};

function echoRegistry() {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "echo_probe",
    description: "Return a short fixed text",
    schema: z.object({}),
    execute: async () => "probe-ok",
  }));
  return registry;
}

function picsRegistry() {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: "pics",
    description: "Try to emit eight copies of a tiny image",
    schema: z.object({}),
    execute: async (_args, runtime) => {
      let attached = 0;
      for (let index = 0; index < 8; index++) {
        if (runtime?.emitImage?.({ dataUrl: DATA_URL, label: `pic ${index + 1}` })) attached++;
      }
      return { attached, rejected: 8 - attached };
    },
  }));
  return registry;
}

function makeAgent(tools: ToolRegistry, client: OpenAI, options: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const agent = new Agent({ model: "test", systemPrompt: "Local test; never use external services.",
    tools, client, maxRetries: 0, maxIterations: 8, toolSearch: "off", ...options });
  const events: unknown[] = [];
  for (const name of ["run_start", "run_end", "step", "compact", "tool_end", "retry"] as const) {
    agent.events.on(name, payload => events.push({ name, payload: structuredClone(payload) }));
  }
  return { agent, events };
}

describe("Agent：用户图片随本轮发送、跨轮不重放", () => {
  test("首次请求带 image_url，工具迭代后仍在；下一轮不再出现；历史/事件无 base64", async () => {
    const { client, payloads } = localLlm(index => index === 0
      ? toolReply(call("echo_probe", "call-1")) : finalReply());
    const { agent, events } = makeAgent(echoRegistry(), client);

    const first = await agent.run("看图并回答", undefined, [image()]);
    expect(first.success).toBe(true);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(imagesIn(payload)).toHaveLength(1);
      expect(imagesIn(payload)[0]!.image_url.url).toBe(DATA_URL);
      // 用户消息正文写成"本轮有图"的说明：像素不进历史
      expect(userText(payload)).toContain("[用户上传了 1 张图片：shot-1.png");
    }
    // 工具观察结果与历史消息都不含像素
    noImageData(first.messages);
    noImageData(first.steps);
    noImageData(events);
    expect(JSON.stringify(first.messages)).toContain("[用户上传了 1 张图片");

    const second = await agent.run("再问一次");
    expect(second.success).toBe(true);
    expect(payloads).toHaveLength(3);
    expect(imagesIn(payloads[2])).toHaveLength(0);
    noImageData(payloads[2]);
  });

  test("纯图片消息补一句中性说明，不伪造用户文字", async () => {
    const { client, payloads } = localLlm(() => finalReply("收到图片"));
    const { agent } = makeAgent(echoRegistry(), client);
    const result = await agent.run("", undefined, [image()]);
    expect(result.success).toBe(true);
    expect(userText(payloads[0])).toContain("（用户未输入文字，仅上传了图片）");
    expect(userText(payloads[0])).toContain("[用户上传了 1 张图片");
  });

  test("视觉关闭：不发送像素，说明通道关闭且不得声称看见", async () => {
    const { client, payloads } = localLlm(() => finalReply("无法查看图片"));
    const { agent, events } = makeAgent(echoRegistry(), client, { visionCapable: false });
    const result = await agent.run("看图", undefined, [image()]);
    expect(result.success).toBe(true);
    expect(imagesIn(payloads[0])).toHaveLength(0);
    expect(userText(payloads[0])).toContain("图片通道已关闭");
    expect(userText(payloads[0])).toContain("不能声称看见图片");
    noImageData([result.messages, events]);
  });

  test("8 张请求配额与工具图片共享：用户占 1 张后工具只能再附加 7 张", async () => {
    const { client, payloads } = localLlm(index => index === 0
      ? toolReply(call("pics", "call-pics")) : finalReply());
    const { agent } = makeAgent(picsRegistry(), client);
    const result = await agent.run("发图", undefined, [image()]);
    expect(result.success).toBe(true);
    const observation = observationOf(payloads[1], "call-pics");
    expect(observation).toContain("\"attached\":7");
    expect(observation).toContain("\"rejected\":1");
    expect(imagesIn(payloads[1])).toHaveLength(MAX_IMAGES_PER_REQUEST);
  });

  test("413 丢弃图片后重试，后续迭代不再重挂", async () => {
    const { client, payloads } = localLlm(index => index === 0
      ? new Response(JSON.stringify({ error: "request payload too large" }), { status: 413 })
      : index === 1 ? toolReply(call("echo_probe", "call-2")) : finalReply());
    const { agent, events } = makeAgent(echoRegistry(), client);
    const result = await agent.run("看图", undefined, [image()]);
    expect(result.success).toBe(true);
    expect(payloads).toHaveLength(3);
    // 第一次 413（被守卫吞掉并重试）→ 第二次已换成文字说明 → 第三次工具迭代也不再带图
    expect(imagesIn(payloads[1])).toHaveLength(0);
    expect(imagesIn(payloads[2])).toHaveLength(0);
    expect(JSON.stringify(payloads[1])).toContain("【图片未发送】");
    expect((events as any[]).some(event => event.name === "compact" && event.payload.action === "drop_images")).toBe(true);
    noImageData([result.messages, events]);
  });

  test("畸形图片在 Agent 入口整体拒绝，没走到模型", async () => {
    const { client, payloads } = localLlm(() => finalReply());
    const { agent } = makeAgent(echoRegistry(), client);
    await expect(agent.run("看图", undefined, [
      { dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
    ])).rejects.toThrow(/受支持的图片/);
    expect(payloads).toHaveLength(0);
    expect((agent as any).running).toBe(false);
  });
});

// ---------- 服务器：上传入口 ----------

async function serverFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "user-images-server-"));
  dirs.push(dir);
  if (!process.env.OPENAI_API_KEY) {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-unused-key";
    cleanups.push(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  }
  const hub = new EventHub();
  const bridge = new UiBridge(hub.publish, 5_000);
  const runtime = {
    config: { ...loadAgentConfig(), model: "default-model", stream: false, checkpointsEnabled: false, visionCapable: true },
    registry: new ToolRegistry(), skills: [], sandbox: { backend: "host", reason: "test" },
    sandboxRoot: dir, mcp: { getStatus: () => [], closeAll: async () => {} },
  } as unknown as ServerRuntime;
  const manager = new SessionManager({ hub, bridge, runtime, sessionDir: dir, traceDir: path.join(dir, "trace") });
  return { manager, runtime, dir };
}

function hello(manager: SessionManager, id: string) {
  return new Promise<Extract<ServerEvent, { type: "hello" }>>((resolve, reject) => {
    const off = manager.subscribe(id, event => {
      if (event.type === "hello") resolve(event);
      if (event.type === "error") reject(new Error(event.message));
    });
    cleanups.push(off);
  });
}

/** 门控假 client：主调用卡在 gate 上，放行后立即终答；无 tools 的调用直接回小结果 */
function installGatedClient(manager: SessionManager, sessionId: string, gate: Promise<void>) {
  const agent = (manager as any).entries.get(sessionId)!.agent;
  let mainCalls = 0;
  agent.client = {
    chat: { completions: { create: async (params: any) => {
      if (!params.tools?.length) {
        return { choices: [{ message: { content: "短摘要" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
      }
      mainCalls++;
      if (mainCalls === 1) await gate;
      return { choices: [{ message: { content: `第${mainCalls}次回答` }, finish_reason: "stop" }], usage };
    } } },
  };
  return () => mainCalls;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("服务器入口：上传校验与 run_start 元数据", () => {
  test("非法图片 / 视觉关闭 / 斜杠命令带图都在入口拒绝，不进队列", async () => {
    const { manager, runtime } = await serverFixture();
    await expect(manager.sendMessage("s1", "看图", [{ dataUrl: "nope" }])).rejects.toThrow(UserImageError);
    await expect(manager.sendMessage("s1", "看图", [
      { dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
    ])).rejects.toThrow(/受支持的图片/);
    expect(manager.queueSnapshot("s1")).toEqual([]);

    (runtime.config as any).visionCapable = false;
    await expect(manager.sendMessage("s1", "看图", [image()])).rejects.toThrow(/图片通道已关闭/);
    (runtime.config as any).visionCapable = true;

    await expect(manager.sendMessage("s1", "/help", [image()])).rejects.toThrow(/斜杠命令不能附带图片/);
    expect(manager.queueSnapshot("s1")).toEqual([]);
  });

  test("run_start 只带图片元数据；排队消息转正后也带", async () => {
    const { manager } = await serverFixture();
    await hello(manager, "s2");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    installGatedClient(manager, "s2", gate);
    const events: ServerEvent[] = [];
    cleanups.push(manager.subscribe("s2", event => events.push(event)));
    await waitFor(() => events.some(event => event.type === "hello"));

    const first = await manager.sendMessage("s2", "第一张", [image(1)]);
    expect(first.queued).toBe(false);
    const second = await manager.sendMessage("s2", "第二张", [image(2)]);
    expect(second.queued).toBe(true);

    release();
    await waitFor(() => events.filter(event => event.type === "run_end").length >= 2);

    const starts = events.filter(event => event.type === "run_start") as Array<Extract<ServerEvent, { type: "run_start" }>>;
    expect(starts).toHaveLength(2);
    expect(starts[0]!.images).toEqual([{ name: "shot-1.png", mimeType: "image/png", sizeBytes: PNG_BYTES.length }]);
    expect(starts[1]!.queueId).toBe(second.queueId);
    expect(starts[1]!.images).toEqual([{ name: "shot-2.png", mimeType: "image/png", sizeBytes: PNG_BYTES.length }]);
    // 事件流里没有像素
    noImageData(events);
  });
});
