import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, MAX_IMAGES_PER_REQUEST, MAX_REQUEST_IMAGE_BYTES } from "../src/core/agent";
import { z } from "zod";
import { defineTool, type ToolRuntime } from "../src/core/types";
import { loadAgentConfig } from "../src/config";
import OpenAI from "openai";
import { ToolRegistry } from "../src/core/registry";
import { createReadImageTool, MAX_IMAGE_BYTES, sniffImageMime } from "../src/tools/read_image";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const dirs: string[] = [];

async function sandbox(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-image-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("read_image", () => {
  test("按文件头识别格式，把图片交给图片通道并返回元信息", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const emitted: Array<{ dataUrl: string; label: string }> = [];
    const tool = createReadImageTool({ sandboxRoot: root });
    const result = (await tool.execute(
      { path: "pic.png" },
      { emitImage: (image) => { emitted.push(image); return true; } }
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ path: "pic.png", mime_type: "image/png", attached: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.dataUrl).toBe(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
    expect(emitted[0]!.label).toContain("pic.png");
  });

  test("扩展名不可信：内容才是格式依据，非图片内容被拒绝", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "fake.png"), "这不是图片");
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(
      tool.execute({ path: "fake.png" }, { emitImage: () => true })
    ).rejects.toThrow("不是支持的图片格式");
  });

  test("路径守卫拒绝越出工作区", async () => {
    const root = await sandbox();
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(
      tool.execute({ path: "../secret.png" }, { emitImage: () => true })
    ).rejects.toThrow("越出工作区");
  });

  test("超过大小上限直接拒绝，不做静默压缩", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(
      tool.execute({ path: "huge.png" }, { emitImage: () => true })
    ).rejects.toThrow("图片过大");
  });

  test("缺少图片通道时明确报错，而不是假装已附加", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(tool.execute({ path: "pic.png" })).rejects.toThrow("没有图片通道");
  });

  test("图片被配额拒绝时如实报错，不返回 attached:true", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(
      tool.execute({ path: "pic.png" }, { emitImage: () => false })
    ).rejects.toThrow("图片未能附加");
  });

  test("识别 PNG/JPEG/GIF/WebP 文件头", () => {
    expect(sniffImageMime(PNG_1X1)).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF0000WEBP", "ascii"))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from("plain text", "ascii"))).toBeUndefined();
  });
});

describe("多模态图片进入模型请求", () => {
  test("read_image 的结果作为 image_url 附加到下一次 LLM 请求", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));

    const payloads: any[] = [];
    let requests = 0;
    const client = {
      chat: {
        completions: {
          create: async (request: unknown) => {
            payloads.push(request);
            if (requests++ === 0) {
              return {
                choices: [{
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [{
                      id: "img-1",
                      type: "function",
                      function: { name: "read_image", arguments: JSON.stringify({ path: "pic.png" }) },
                    }],
                  },
                }],
                usage,
              };
            }
            return { choices: [{ finish_reason: "stop", message: { content: "看到一张 1x1 图片" } }], usage };
          },
        },
      },
    };
    const agent = new Agent({
      model: "test",
      systemPrompt: "test",
      maxRetries: 0,
      tools,
      client: client as any,
    });
    const result = await agent.run("看看 pic.png");

    expect(result).toMatchObject({ success: true, finalAnswer: "看到一张 1x1 图片" });
    expect(requests).toBe(2);
    const first = payloads[0].messages.filter((m: any) => Array.isArray(m.content));
    expect(first).toHaveLength(0);
    const withImage = payloads[1].messages.find(
      (m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url")
    );
    expect(withImage).toBeDefined();
    const imagePart = withImage.content.find((p: any) => p.type === "image_url");
    expect(imagePart.image_url.url).toBe(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
    expect(withImage.content[0].text).toContain("工作区图片 pic.png");
  });
});

describe("图片配额与视觉能力门控", () => {
  /** 脚本化 client：按 payloads 长度决定回什么，测试只管断言最终发出的请求 */
  function scriptedClient(handler: (payloads: any[], request: any) => any) {
    const payloads: any[] = [];
    return {
      payloads,
      client: {
        chat: {
          completions: {
            create: async (request: any) => {
              payloads.push(request);
              return handler(payloads, request);
            },
          },
        },
      } as any,
    };
  }

  const toolCalls = (names: Array<{ id: string; path: string }>) => ({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: names.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: "read_image", arguments: JSON.stringify({ path: call.path }) },
        })),
      },
    }],
    usage,
  });
  const finalAnswer = (content: string) => ({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage,
  });
  const hasImage = (request: any) => request.messages.some((m: any) =>
    Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"));
  const toolResultOf = (request: any, callId: string) =>
    String(request.messages.find((m: any) => m.role === "tool" && m.tool_call_id === callId)?.content ?? "");

  test("同批图片超过张数上限：超额那张被拒，模型收到的是原因而不是假成功", async () => {
    const root = await sandbox();
    const total = MAX_IMAGES_PER_REQUEST + 1;
    for (let i = 0; i < total; i++) await fs.writeFile(path.join(root, `pic-${i}.png`), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const { payloads, client } = scriptedClient((sent) =>
      sent.length === 1
        ? toolCalls(Array.from({ length: total }, (_, i) => ({ id: `call-${i}`, path: `pic-${i}.png` })))
        : finalAnswer("看完"));

    const agent = new Agent({ model: "test", systemPrompt: "test", maxRetries: 0, tools, client });
    const result = await agent.run(`看这 ${total} 张图`);

    expect(result.success).toBe(true);
    expect(hasImage(payloads[1])).toBe(true);
    const images = payloads[1].messages.filter((m: any) =>
      Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"));
    expect(images).toHaveLength(MAX_IMAGES_PER_REQUEST);
    const results = payloads[1].messages.filter((m: any) => m.role === "tool");
    expect(results.filter((m: any) => m.content.includes("图片未能附加"))).toHaveLength(1);
    expect(results.filter((m: any) => m.content.includes("图片已附加"))).toHaveLength(MAX_IMAGES_PER_REQUEST);
  });

  test("厂商拒收 image_url：丢图重试一次并闩锁视觉通道", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const { payloads, client } = scriptedClient((sent, request) => {
      if (hasImage(request)) {
        throw Object.assign(new Error("This model does not support image input"), { status: 400 });
      }
      return sent.length === 1 ? toolCalls([{ id: "c1", path: "pic.png" }]) : finalAnswer("改用脚本 OCR");
    });

    const agent = new Agent({ model: "text-model", systemPrompt: "test", maxRetries: 0, tools, client });
    const result = await agent.run("看看 pic.png");

    expect(result.success).toBe(true);
    expect(agent.visionEnabled).toBe(false);
    const retry = payloads[payloads.length - 1];
    expect(hasImage(retry)).toBe(false);
    expect(JSON.stringify(retry.messages)).toContain("不接受图片输入");
  });

  test("visionCapable=false 时根本没有图片通道，read_image 直接报错", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const { payloads, client } = scriptedClient((sent) =>
      sent.length === 1 ? toolCalls([{ id: "c1", path: "pic.png" }]) : finalAnswer("看不了图"));

    const agent = new Agent({
      model: "text-only", systemPrompt: "test", maxRetries: 0, tools, client, visionCapable: false,
    });
    const result = await agent.run("看看 pic.png");

    expect(result.success).toBe(true);
    expect(agent.visionEnabled).toBe(false);
    expect(hasImage(payloads[1])).toBe(false);
    expect(toolResultOf(payloads[1], "c1")).toContain("没有图片通道");
  });

  test("并发大图按编码总字节限额，下一请求恢复配额", async () => {
    const root = await sandbox();
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
    PNG_1X1.copy(bytes);
    await fs.writeFile(path.join(root, "big.png"), bytes);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const { client, payloads } = scriptedClient(sent => {
      if (sent.length === 1) return toolCalls([1, 2, 3].map(id => ({ id: `b${id}`, path: "big.png" })));
      if (sent.length === 2) return toolCalls([{ id: "next", path: "big.png" }]);
      return finalAnswer("完成");
    });
    const result = await new Agent({ model: "test", systemPrompt: "test", tools, client }).run("读取大图");
    expect(result.success).toBe(true);
    const images = payloads[1].messages.flatMap((m: any) => Array.isArray(m.content)
      ? m.content.filter((p: any) => p.type === "image_url") : []);
    expect(images).toHaveLength(2);
    expect(images.reduce((sum: number, p: any) => sum + Buffer.byteLength(p.image_url.url), 0))
      .toBeLessThanOrEqual(MAX_REQUEST_IMAGE_BYTES);
    expect(payloads[1].messages.filter((m: any) => m.role === "tool" && m.content.includes("图片未能附加")))
      .toHaveLength(1);
    expect(hasImage(payloads[2])).toBe(true);
    expect(toolResultOf(payloads[2], "next")).toContain("图片已附加");
  });

  test.each([
    [413, "Payload Too Large"],
    [400, "image_url size exceeds maximum size"],
    [400, "This model does not support images exceeding 20 MB"],
    [422, "too many images"],
  ])("图片体积/数量错误 %i：去图重试，不关闭视觉且校准成功请求", async (status, message) => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const { client, payloads } = scriptedClient(sent => {
      if (sent.length === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
      if (sent.length === 2) throw Object.assign(new Error(message), { status });
      return finalAnswer("图片未发送");
    });
    const agent = new Agent({ model: "test", systemPrompt: "test", tools, client, maxRetries: 0 });
    const cm = (agent as any).contextManager;
    const calibration = spyOn(cm, "recordPromptUsage");
    try {
      const result = await agent.run("看图");
      expect(result.success).toBe(true);
      expect(payloads).toHaveLength(3);
      expect(hasImage(payloads[2])).toBe(false);
      expect(JSON.stringify(payloads[2].messages)).toContain("图片未发送");
      expect(agent.visionEnabled).toBe(true);
      expect(calibration).toHaveBeenCalledTimes(2);
      expect(calibration.mock.calls[1]![0]).toEqual(payloads[2].messages);
      expect(cm.ephemeralTokens).toBe(0);
    } finally { calibration.mockRestore(); }
  });

  test.each(["Invalid image_url: failed to decode image", "Unsupported image format", "This model does not support image format PNG", "Invalid temperature"])(
    "非能力错误不误关闭视觉或自动去图：%s", async message => {
      const root = await sandbox();
      await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
      const tools = new ToolRegistry();
      tools.register(createReadImageTool({ sandboxRoot: root }));
      const { client, payloads } = scriptedClient(sent => {
        if (sent.length === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
        throw Object.assign(new Error(message), { status: 400 });
      });
      const agent = new Agent({ model: "test", systemPrompt: "test", tools, client, maxRetries: 0 });
      expect((await agent.run("看图")).success).toBe(false);
      expect(payloads).toHaveLength(2);
      expect(agent.visionEnabled).toBe(true);
    });

  test("无图片的 413 不重试，去图后仍失败也不无限重试", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    for (const withImage of [false, true]) {
      const tools = new ToolRegistry();
      tools.register(createReadImageTool({ sandboxRoot: root }));
      const { client, payloads } = scriptedClient(sent => {
        if (withImage && sent.length === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
        throw Object.assign(new Error("Payload Too Large"), { status: 413 });
      });
      const agent = new Agent({ model: "test", systemPrompt: "test", tools, client, maxRetries: 0 });
      expect((await agent.run("看图")).success).toBe(false);
      expect(payloads).toHaveLength(withImage ? 3 : 1);
      expect(agent.visionEnabled).toBe(true);
    }
  });

  test.each([400, 413])("强制收尾 %i 去图保留收尾提示，空答再收尾不重新发图", async status => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const { client, payloads } = scriptedClient(sent => {
      if (sent.length === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
      if (sent.length === 2) throw Object.assign(new Error(status === 400
        ? "This model does not support image input" : "Payload Too Large"), { status });
      if (sent.length === 3) return finalAnswer("");
      return finalAnswer("无法查看图片");
    });
    const agent = new Agent({ model: "test", systemPrompt: "test", tools, client, maxRetries: 0, maxIterations: 1 });
    expect(await agent.run("看图")).toMatchObject({ stopReason: "iteration_limit", finalAnswer: "无法查看图片" });
    expect(payloads).toHaveLength(4);
    for (const retry of payloads.slice(2)) {
      expect(hasImage(retry)).toBe(false);
      expect(JSON.stringify(retry.messages)).toContain("已达到工具调用轮次上限");
      expect(JSON.stringify(retry.messages)).toContain("图片未发送");
      expect(retry.messages.some((m: any) => m.role === "tool" && m.tool_call_id === "c1")).toBe(true);
    }
    expect(payloads[3].tools).toBeUndefined();
  });

  test.each([true, false])("上下文压缩和去图恢复可先后发生，保留强制收尾提示：%s", async contextFirst => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const { client, payloads } = scriptedClient(sent => {
      if (sent.length === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
      if (sent.length <= 3) {
        const overflow = (sent.length === 2) === contextFirst;
        throw Object.assign(new Error(overflow ? "maximum context length exceeded" : "Payload Too Large"),
          { status: overflow ? 400 : 413 });
      }
      return finalAnswer("无法查看图片");
    });
    const agent = new Agent({ model: "test", systemPrompt: "test", tools, client, maxRetries: 0, maxIterations: 1 });
    const compress = spyOn((agent as any).contextManager, "compress")
      .mockImplementation(async (messages: any) => messages);
    try {
      expect(await agent.run("看图")).toMatchObject({ stopReason: "iteration_limit", finalAnswer: "无法查看图片" });
      expect(payloads).toHaveLength(4);
      expect(hasImage(payloads[3])).toBe(false);
      expect(JSON.stringify(payloads[3].messages)).toContain("已达到工具调用轮次上限");
      expect(JSON.stringify(payloads[3].messages)).toContain("图片未发送");
      expect(compress.mock.calls.some((call: any) => call[1]?.emergency)).toBe(true);
      expect(agent.visionEnabled).toBe(true);
    } finally { compress.mockRestore(); }
  });

  test("压缩后图片仍撑爆上下文：再去图一次，仍失败则停止", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    for (const recover of [true, false]) {
      const tools = new ToolRegistry();
      tools.register(createReadImageTool({ sandboxRoot: root }));
      const { client, payloads } = scriptedClient(sent => {
        if (sent.length === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
        if (sent.length < 4 || !recover) throw Object.assign(new Error("maximum context length exceeded"), { status: 413 });
        return finalAnswer("恢复");
      });
      const agent = new Agent({ model: "test", systemPrompt: "test", tools, client, maxRetries: 0 });
      const compress = spyOn((agent as any).contextManager, "compress").mockImplementation(async (messages: any) => messages);
      try {
        expect((await agent.run("看图")).success).toBe(recover);
        expect(payloads).toHaveLength(4);
        expect(hasImage(payloads[2])).toBe(true);
        expect(hasImage(payloads[3])).toBe(false);
        expect(JSON.stringify(payloads[3].messages)).toContain("上下文压缩后仍超限");
        expect(agent.visionEnabled).toBe(true);
      } finally { compress.mockRestore(); }
    }
  });

  test("视觉拒绝跨 run 保持，换模型解除；显式关闭不随换模型解除", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    let turn = 0;
    const { client, payloads } = scriptedClient((_sent, request) => {
      if (++turn === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
      if (request.model === "text-only" && hasImage(request)) {
        throw Object.assign(new Error("Image input is not supported by this model"), { status: 400 });
      }
      return finalAnswer("完成");
    });
    const agent = new Agent({ model: "text-only", systemPrompt: "test", tools, client, maxRetries: 0 });
    expect((await agent.run("看图")).success).toBe(true);
    expect(agent.visionEnabled).toBe(false);
    turn = 0;
    const secondStart = payloads.length;
    expect((await agent.run("再看图")).success).toBe(true);
    expect(payloads.slice(secondStart).some(hasImage)).toBe(false);
    expect(toolResultOf(payloads.at(-1), "c1")).toContain("没有图片通道");
    expect(payloads[secondStart].messages[0].content).toContain("图片通道已关闭");
    agent.setModel("vision-model");
    expect(agent.visionEnabled).toBe(true);
    turn = 0;
    expect((await agent.run("换模型再看")).success).toBe(true);
    expect(hasImage(payloads.at(-1))).toBe(true);
    const disabled = new Agent({ model: "text-only", systemPrompt: "test", client, visionCapable: false });
    disabled.setModel("vision-model");
    expect(disabled.visionEnabled).toBe(false);
  });

  test("工具结束后迟到的图片不会占用下一请求", async () => {
    let emit: ToolRuntime["emitImage"];
    const tools = new ToolRegistry();
    tools.register(defineTool({ name: "read_image", description: "test", schema: z.object({}),
      execute: async (_args, runtime) => { emit = runtime?.emitImage; return "完成"; } }));
    const { client, payloads } = scriptedClient(sent => {
      if (sent.length === 1) return toolCalls([{ id: "c1", path: "pic.png" }]);
      expect(emit?.({ dataUrl: `data:image/png;base64,${PNG_1X1.toString("base64")}`, label: "迟到图片" })).toBe(false);
      return finalAnswer("完成");
    });
    expect((await new Agent({ model: "test", systemPrompt: "test", tools, client }).run("test")).success).toBe(true);
    expect(hasImage(payloads[1])).toBe(false);
  });

  test.each([false, true])("真实 SDK 经本地 HTTP/SSE 处理图片 413，stream=%s", async stream => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tools = new ToolRegistry();
    tools.register(createReadImageTool({ sandboxRoot: root }));
    const payloads: any[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const body: any = await request.json();
      payloads.push(body);
      if (hasImage(body)) return Response.json({ error: { message: "Payload Too Large", type: "invalid_request_error" } }, { status: 413 });
      const reply = payloads.length === 1 ? toolCalls([{ id: "c1", path: "pic.png" }]) : finalAnswer("无法查看图片");
      if (!stream) return Response.json(reply);
      const choice = reply.choices[0]!;
      const message: any = choice.message;
      const delta = { role: "assistant", content: message.content,
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tc: any, index: number) => ({ ...tc, index })) } : {}) };
      const chunk = { id: "test", object: "chat.completion.chunk", model: "test", created: 0,
        choices: [{ index: 0, delta, finish_reason: choice.finish_reason }], usage };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } });
    } });
    try {
      const client = new OpenAI({ apiKey: "local-test", baseURL: `http://127.0.0.1:${server.port}/v1`, maxRetries: 0 });
      const agent = new Agent({ model: "test", systemPrompt: "test", tools, client, maxRetries: 0, stream });
      const result = await agent.run("看图");
      expect(result).toMatchObject({ success: true, finalAnswer: "无法查看图片", totalTokens: 20 });
      expect(payloads).toHaveLength(3);
      expect(hasImage(payloads[1])).toBe(true);
      expect(hasImage(payloads[2])).toBe(false);
      expect(JSON.stringify(payloads[2].messages)).toContain("图片未发送");
      expect(agent.visionEnabled).toBe(true);
    } finally { await server.stop(true); }
  });

  test("AGENT_VISION 默认允许，显式关闭按布尔环境变量解析", () => {
    const saved = process.env.AGENT_VISION;
    try {
      delete process.env.AGENT_VISION;
      expect(loadAgentConfig().visionCapable).toBe(true);
      for (const value of ["0", "false", "off", "no", "OFF"]) {
        process.env.AGENT_VISION = value;
        expect(loadAgentConfig().visionCapable).toBe(false);
      }
      process.env.AGENT_VISION = "1";
      expect(loadAgentConfig().visionCapable).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.AGENT_VISION;
      else process.env.AGENT_VISION = saved;
    }
  });
});
