// tests/vision_notes.test.ts
// 视觉观察转写：批量上限、来源标签、严格解析与纠错重试、渲染格式。
// 运行: bun test tests/vision_notes.test.ts
import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { DEFAULT_VISION_MODEL, MAX_VISION_IMAGES, renderVisionNotes, transcribeImages, type VisionImage } from "../src/bili/vision_notes";
import { parseVisualObservations, VISUAL_INSTRUCTIONS } from "../src/core/visual_observations";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function makeImages(count: number): Promise<{ dir: string; images: VisionImage[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-notes-"));
  const images: VisionImage[] = [];
  for (let index = 0; index < count; index += 1) {
    const file = path.join(dir, `image_${index + 1}.png`);
    await fs.writeFile(file, PNG);
    images.push({ path: file, label: `抽帧窗口 ${index + 1}（0:0${index}–0:0${index + 1}）` });
  }
  return { dir, images };
}

const detailsFor = (index: number): string =>
  `画面要点：第 ${index} 张；可辨认文字：示例文字；风险要素：无；不确定项：无`;

function fakeVision(reply: (imageCount: number, call: number) => string) {
  const requests: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          requests.push(params);
          const count = (params.messages[1].content as any[]).filter((part: any) => part.type === "image_url").length;
          return {
            choices: [{ message: { content: reply(count, requests.length) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

test("transcribeImages：一批转写，来源映射与 data URL 进请求，结果同序", async () => {
  const { dir, images } = await makeImages(2);
  const { client, requests } = fakeVision((count) =>
    JSON.stringify({ observations: Array.from({ length: count }, (_, i) => ({ id: `image_${i + 1}`, details: detailsFor(i + 1) })) }));
  const details = await transcribeImages(images, { client });
  expect(details).toEqual([detailsFor(1), detailsFor(2)]);
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe(DEFAULT_VISION_MODEL);
  expect(requests[0].messages[0].content).toContain(VISUAL_INSTRUCTIONS.slice(0, 20));
  const content = requests[0].messages[1].content as any[];
  expect(content[0].text).toContain("image_1 → 抽帧窗口 1");
  expect(content[0].text).toContain("image_2 → 抽帧窗口 2");
  const imageParts = content.filter((part: any) => part.type === "image_url");
  expect(imageParts).toHaveLength(2);
  expect(imageParts[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("transcribeImages：超过 8 张自动分批，每批 id 从 image_1 重新编号", async () => {
  const { dir, images } = await makeImages(MAX_VISION_IMAGES + 2);
  const { client, requests } = fakeVision((count) =>
    JSON.stringify({ observations: Array.from({ length: count }, (_, i) => ({ id: `image_${i + 1}`, details: detailsFor(i + 1) })) }));
  const details = await transcribeImages(images, { client });
  expect(details).toHaveLength(MAX_VISION_IMAGES + 2);
  expect(requests).toHaveLength(2);
  expect((requests[0].messages[1].content as any[]).filter((p: any) => p.type === "image_url")).toHaveLength(MAX_VISION_IMAGES);
  expect((requests[1].messages[1].content as any[]).filter((p: any) => p.type === "image_url")).toHaveLength(2);
  expect((requests[1].messages[1].content as any[])[0].text).toContain("本批共 2 张");
  await fs.rm(dir, { recursive: true, force: true });
});

test("transcribeImages：格式不合格时纠错重试一次；仍不合格才抛错", async () => {
  const { dir, images } = await makeImages(1);
  const retry = fakeVision((count, call) => call === 1
    ? "抱歉，我先说结论：图片里有二维码。"
    : JSON.stringify({ observations: [{ id: "image_1", details: detailsFor(1) }] }));
  expect(await transcribeImages(images, { client: retry.client })).toEqual([detailsFor(1)]);
  expect(retry.requests).toHaveLength(2);
  expect(retry.requests[1].messages[0].content).toContain("上一次输出不合格");

  const broken = fakeVision(() => JSON.stringify({ observations: [{ id: "image_1", details: "只有画面要点" }] }));
  await expect(transcribeImages(images, { client: broken.client })).rejects.toThrow("字段不完整");
  expect(broken.requests).toHaveLength(2);
  await fs.rm(dir, { recursive: true, force: true });
});

test("transcribeImages：空输入不请求；renderVisionNotes 保留来源标签", async () => {
  const { client, requests } = fakeVision(() => "{}");
  expect(await transcribeImages([], { client })).toEqual([]);
  expect(requests).toHaveLength(0);
  expect(renderVisionNotes(
    [{ path: "a.jpg", label: "抽帧 grid_001.jpg（窗口 1，0:02–0:33）" }],
    [detailsFor(1)],
  )).toBe(`- 抽帧 grid_001.jpg（窗口 1，0:02–0:33）：${detailsFor(1)}`);
});

test("parseVisualObservations：重复、缺项、字段名缺失都报错", () => {
  const ok = JSON.stringify({ observations: [
    { id: "image_1", details: detailsFor(1) },
    { id: "image_2", details: detailsFor(2) },
  ] });
  expect(parseVisualObservations(ok, 2)).toHaveLength(2);
  expect(() => parseVisualObservations(ok, 3)).toThrow("重复或缺项");
  expect(() => parseVisualObservations(JSON.stringify({ observations: [
    { id: "image_1", details: detailsFor(1) },
    { id: "image_1", details: detailsFor(2) },
  ] }), 2)).toThrow("重复或缺项");
  expect(() => parseVisualObservations(JSON.stringify({ observations: [
    { id: "image_1", details: "画面要点：只有一项" },
  ] }), 1)).toThrow("字段不完整");
});

test("缓存绑定图片内容、来源正文和模型；逐批发布 assistant 记录", async () => {
  const { dir, images } = await makeImages(1);
  try {
    const fake = fakeVision(() => JSON.stringify({ observations: [{ id: "image_1", details: detailsFor(1) }] }));
    const records: any[] = [];
    let tokens = 0;
    const options = { client: fake.client, cacheDir: path.join(dir, "cache"), onBatch: (r: any) => { records.push(r); }, onUsage: (n: number) => { tokens += n; } };
    await transcribeImages(images, options);
    await transcribeImages(images, options);
    expect(fake.requests).toHaveLength(1);
    expect(records.map(r => [r.role, r.cached])).toEqual([["assistant", false], ["assistant", true]]);
    expect(tokens).toBe(2);
    await fs.appendFile(images[0]!.path, "changed");
    await transcribeImages(images, options);
    await transcribeImages([{ ...images[0]!, label: "另一条评论及完整正文" }], options);
    await transcribeImages(images, { ...options, model: "another-vision" });
    expect(fake.requests).toHaveLength(4);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("后续批次失败时保留已成功的批次，下次只重新识别失败批次", async () => {
  const { dir, images } = await makeImages(9);
  try {
    const cacheDir = path.join(dir, "cache");
    const first = fakeVision((count, call) => call > 1 ? "bad" : JSON.stringify({ observations: Array.from({ length: count }, (_, i) => ({ id: `image_${i + 1}`, details: detailsFor(i) })) }));
    const records: any[] = [];
    await expect(transcribeImages(images, { client: first.client, cacheDir, onBatch: r => { records.push(r); } })).rejects.toThrow();
    expect(records).toHaveLength(1);
    const next = fakeVision(count => JSON.stringify({ observations: Array.from({ length: count }, (_, i) => ({ id: `image_${i + 1}`, details: detailsFor(i) })) }));
    expect(await transcribeImages(images, { client: next.client, cacheDir })).toHaveLength(9);
    expect(next.requests).toHaveLength(1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("取消、超大图片和渲染缺项不能伪装成成功观察", async () => {
  const { dir, images } = await makeImages(1);
  try {
    const fake = fakeVision(() => "{}");
    await expect(transcribeImages(images, { client: fake.client, signal: AbortSignal.abort() })).rejects.toThrow();
    await fs.writeFile(images[0]!.path, Buffer.alloc(8 * 1024 * 1024));
    await expect(transcribeImages(images, { client: fake.client })).rejects.toThrow("单图上限");
    expect(fake.requests).toHaveLength(0);
    expect(() => renderVisionNotes(images, [])).toThrow("数量");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
