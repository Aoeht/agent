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
});
