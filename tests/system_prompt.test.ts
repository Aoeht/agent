import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/prompts/system";

describe("文件操作分工", () => {
  test("挂载 filesystem 时列出简单文本工具，其余操作要求写脚本", () => {
    const prompt = buildSystemPrompt("/tmp/ws", [], {
      filesystemTools: [
        "filesystem__read_text_file",
        "filesystem__write_file",
        "filesystem__edit_file",
        "filesystem__read_media_file",
        "filesystem__search_files",
      ],
    });
    expect(prompt).toContain("filesystem__read_text_file");
    expect(prompt).toContain("filesystem__write_file");
    expect(prompt).toContain("filesystem__edit_file");
    expect(prompt).not.toContain("filesystem__read_media_file");
    expect(prompt).not.toContain("filesystem__search_files");
    expect(prompt).not.toContain("当前未挂载 filesystem MCP");
    expect(prompt).toContain("一律自己写脚本文件");
    expect(prompt).toContain("查看本地图片用 read_image");
    expect(prompt).toContain("不要用 filesystem 的 read_media_file");
  });

  test("未挂载 filesystem 时明确所有文件操作写脚本", () => {
    const prompt = buildSystemPrompt("/tmp/ws");
    expect(prompt).toContain("【文件操作】");
    expect(prompt).toContain("当前未挂载 filesystem MCP");
    expect(prompt).toContain("run_script");
  });

  test("只列出实际挂载的简单文本工具", () => {
    const prompt = buildSystemPrompt("/tmp/ws", [], { filesystemTools: ["filesystem__read_text_file"] });
    expect(prompt).toContain("当前可用：filesystem__read_text_file。");
    expect(prompt).not.toContain("filesystem__write_file");
  });

  test("模型无视觉时不再推荐 read_image，改要求脚本化处理", () => {
    const prompt = buildSystemPrompt("/tmp/ws", [], { visionCapable: false });
    expect(prompt).not.toContain("查看本地图片用 read_image");
    expect(prompt).toContain("当前模型不能理解图片");
    expect(prompt).toContain("绝不要凭文件名或路径猜测图片内容");
    // 编号不能断档：兜底那条整体去掉，后面的规则要接着排
    expect(prompt).toContain("4. 脚本必须写在工作区内");
  });
});
