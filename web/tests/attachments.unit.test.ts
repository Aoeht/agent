// web/tests/attachments.unit.test.ts
// 浏览器侧附件的纯函数：文件头判定、大小/张数校验、data URL 编码。
// 运行: bun test web/tests/attachments.unit.test.ts
import { expect, test } from "bun:test";
import {
  MAX_IMAGES_PER_REQUEST,
  MAX_USER_IMAGE_BYTES,
  addImageFiles,
  formatImageSize,
  toUploadBodies,
  type LocalImageAttachment,
} from "../src/lib/attachments";

// 与 tests/fixtures/mcp_image_server.ts 相同的 1x1 PNG
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pngBytes = Buffer.from(PNG_BASE64, "base64");
const pngFile = (name = "shot.png") => new File([pngBytes], name);

test("按文件头判定格式（不看扩展名与 File.type）", async () => {
  const { added, errors } = await addImageFiles([], [
    new File([pngBytes], "no-extension"),
    new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])], "fake.png", { type: "image/png" }),
  ]);
  expect(errors).toEqual([]);
  expect(added.map(image => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
  expect(added[0]!.name).toBe("no-extension");
  expect(added[0]!.sizeBytes).toBe(pngBytes.length);
  expect(added[0]!.encodedBytes).toBe(added[0]!.dataUrl.length);
  expect(added[0]!.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
});

test("非图片内容、空文件与超限文件逐个报错，合法文件照常加入", async () => {
  const { added, errors } = await addImageFiles([], [
    pngFile("ok.png"),
    new File(["hello"], "notes.txt"),
    new File([], "empty.png"),
    new File([new Uint8Array(MAX_USER_IMAGE_BYTES + 1)], "big.png"),
  ]);
  expect(added.map(image => image.name)).toEqual(["ok.png"]);
  expect(errors).toHaveLength(3);
  expect(errors[0]).toContain("notes.txt");
  expect(errors[0]).toContain("不是受支持的图片格式");
  expect(errors[1]).toContain("空文件");
  expect(errors[2]).toContain("big.png");
  expect(errors[2]).toContain(formatImageSize(MAX_USER_IMAGE_BYTES));
});

test("张数上限 8：超出的文件被拒绝并报错", async () => {
  const files = Array.from({ length: MAX_IMAGES_PER_REQUEST + 2 }, (_, index) => pngFile(`p${index}.png`));
  const { added, errors } = await addImageFiles([], files);
  expect(added).toHaveLength(MAX_IMAGES_PER_REQUEST);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain(`最多上传 ${MAX_IMAGES_PER_REQUEST} 张`);
  // 已有附件也计入上限
  const existing: LocalImageAttachment[] = added.map((image, index) => ({ ...image, id: `id-${index}` }));
  const more = await addImageFiles(existing, [pngFile("overflow.png")]);
  expect(more.added).toEqual([]);
  expect(more.errors[0]).toContain("最多上传");
});

test("缺省文件名按序号命名；toUploadBodies 只留协议字段", async () => {
  const { added } = await addImageFiles([], [pngFile("")]);
  expect(added[0]!.name).toBe("图片 1");
  expect(toUploadBodies(added)).toEqual([{
    name: added[0]!.name,
    mimeType: "image/png",
    dataUrl: added[0]!.dataUrl,
  }]);
});
