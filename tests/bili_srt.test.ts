// tests/bili_srt.test.ts
// SRT 解析：text_stamp/ 的 B 站字幕格式（说话人前缀、\r\n、BOM）都要能吃
// 运行: bun test ./tests/bili_srt.test.ts
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseSrt } from "../src/bili/srt";

test("标准 SRT：说话人前缀剥离、多行合并、时间换算", () => {
  const srt = [
    "1", "00:00:00,000 --> 00:00:16,230", "[说话人 0]: 第一句", "第二行", "",
    "2", "00:01:02,500 --> 00:01:05,678", "[说话人 1]: 🎼", "",
  ].join("\r\n");
  expect(parseSrt(srt)).toEqual([
    { start_s: 0, end_s: 16.23, text: "第一句 第二行" },
    { start_s: 62.5, end_s: 65.678, text: "🎼" },
  ]);
});

test("容错：BOM、缺索引行、空块、无文本块跳过", () => {
  const srt = "\uFEFF00:00:01,000 --> 00:00:02,000\n只有时间码和文本\n\n\n坏块没有时间码\n\n00:00:03,000 --> 00:00:04,000\n";
  expect(parseSrt(srt)).toEqual([{ start_s: 1, end_s: 2, text: "只有时间码和文本" }]);
});

test("text_stamp 真实字幕可解析（本机存在该目录时）", () => {
  const dir = path.resolve(import.meta.dir, "..", "text_stamp");
  if (!existsSync(dir)) return;
  const sample = readdirSync(dir).find((f) => f.endsWith(".srt"));
  if (!sample) return;
  const segments = parseSrt(readFileSync(path.join(dir, sample), "utf8"));
  expect(segments.length).toBeGreaterThan(0);
  for (const segment of segments) {
    expect(segment.text.length).toBeGreaterThan(0);
    expect(segment.end_s).toBeGreaterThanOrEqual(segment.start_s);
  }
});
