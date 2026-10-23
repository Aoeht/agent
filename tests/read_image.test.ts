import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/core/agent";
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
      { emitImage: (image) => emitted.push(image) }
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
      tool.execute({ path: "fake.png" }, { emitImage: () => {} })
    ).rejects.toThrow("不是支持的图片格式");
  });

  test("路径守卫拒绝越出工作区", async () => {
    const root = await sandbox();
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(
      tool.execute({ path: "../secret.png" }, { emitImage: () => {} })
    ).rejects.toThrow("越出工作区");
  });

  test("超过大小上限直接拒绝，不做静默压缩", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(
      tool.execute({ path: "huge.png" }, { emitImage: () => {} })
    ).rejects.toThrow("图片过大");
  });

  test("缺少图片通道时明确报错，而不是假装已附加", async () => {
    const root = await sandbox();
    await fs.writeFile(path.join(root, "pic.png"), PNG_1X1);
    const tool = createReadImageTool({ sandboxRoot: root });
    await expect(tool.execute({ path: "pic.png" })).rejects.toThrow("没有图片通道");
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
