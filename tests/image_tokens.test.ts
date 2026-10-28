import { describe, expect, test } from "bun:test";
import { estimateImageTokensFromDataUrl } from "../src/utils/image_tokens";

function pngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function jpegDataUrl(width: number, height: number): string {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  sof[10] = 1;
  sof[11] = 0x22;
  sof[12] = 0;
  sof[13] = 2;
  sof[14] = 0x11;
  sof[15] = 1;
  sof[16] = 3;
  sof[17] = 0x11;
  sof[18] = 1;
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function gifDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return `data:image/gif;base64,${bytes.toString("base64")}`;
}

function webpDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return `data:image/webp;base64,${bytes.toString("base64")}`;
}

describe("estimateImageTokensFromDataUrl", () => {
  test("按像素规模走高分块口径，小图取下限", () => {
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1, 1))).toBe(255); // 高分块至少占 1 块
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1024, 1024))).toBe(765); // 2×2 块
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1280, 900))).toBe(1_105); // 3×2 块
    expect(estimateImageTokensFromDataUrl(jpegDataUrl(800, 600))).toBe(765);
    expect(estimateImageTokensFromDataUrl(gifDataUrl(640, 480))).toBe(425); // 2×1 块
    expect(estimateImageTokensFromDataUrl(webpDataUrl(1200, 800))).toBe(1_105);
  });

  test("Qwen3-VL 按 32×32 块，默认 2560 token 上限，另加 2 个视觉边界", () => {
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1280, 900), { model: "qwen3-vl-plus" })).toBe(1_122);
    expect(estimateImageTokensFromDataUrl(pngDataUrl(4000, 3000), { model: "qwen3.5-vl" })).toBe(2_496);
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1, 1), { model: "qwen3-vl-max" })).toBe(6);
  });

  test("Qwen2.5-VL / QVQ 按 28×28 块，上下限 256/1280", () => {
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1280, 900), { model: "qwen2.5-vl-72b" })).toBe(1_262);
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1, 1), { model: "qvq-max" })).toBe(258);
  });

  test("GLM 按官方 FAQ 单图固定 1047 tokens", () => {
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1280, 900), { model: "glm-4.6v" })).toBe(1_047);
    expect(estimateImageTokensFromDataUrl(pngDataUrl(2048, 1152), { model: "glm-4v-flash" })).toBe(1_047);
  });

  test("DeepSeek 按像素近似并夹到单图 1024 上限", () => {
    expect(estimateImageTokensFromDataUrl(pngDataUrl(1280, 900), { model: "deepseek-flash" })).toBe(699);
    expect(estimateImageTokensFromDataUrl(pngDataUrl(4000, 3000), { model: "deepseek-flash" })).toBe(1_024);
  });

  test("尺寸读不出来时按体积退估，并按模型上限夹紧，绝不返回 0", () => {
    const payload = Buffer.alloc(300_000, 0x07).toString("base64");
    const url = `data:image/png;base64,${payload}`;
    expect(estimateImageTokensFromDataUrl(url)).toBe(1_445); // OpenAI 分块上限
    expect(estimateImageTokensFromDataUrl(url, { model: "deepseek-flash" })).toBe(1_024);
    expect(estimateImageTokensFromDataUrl(url, { model: "glm-4.6v" })).toBe(1_047);
    expect(estimateImageTokensFromDataUrl(url, { model: "qwen3-vl-plus" })).toBe(2_000); // 未触到 2562 上限
    expect(estimateImageTokensFromDataUrl("https://example.test/a.png")).toBe(800);
    expect(estimateImageTokensFromDataUrl("not-a-data-url")).toBe(800);
  });
});
