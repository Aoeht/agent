// tests/bili_snapshot.test.ts
// 快照契约：BV 号解析、zod 校验与默认值、SRT 归一化、缺失/非法的可读错误
// 运行: bun test ./tests/bili_snapshot.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadSnapshot, normalizeTranscript, resolveBvid } from "../src/bili/snapshot";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

test("resolveBvid：URL、纯 BV 号、非法输入", () => {
  expect(resolveBvid("https://www.bilibili.com/video/BV1AbCdEfGh2/?p=1")).toBe("BV1AbCdEfGh2");
  expect(resolveBvid("BV1AbCdEfGh2")).toBe("BV1AbCdEfGh2");
  expect(resolveBvid("看看这个 BV1AbCdEfGh2 讲什么的")).toBe("BV1AbCdEfGh2");
  expect(() => resolveBvid("av170001")).toThrow("BV 号");
});

test("loadSnapshot：合法快照、SRT 归一化、缺字段默认值", async () => {
  const dir = await tempDir("bili-snap-");
  const snapshot = {
    schema: "bili-snapshot/v1",
    bvid: "BV1AbCdEfGh2",
    fetched_at: "2026-10-24T00:00:00Z",
    video: { title: "标题" },
    transcript: { source: "srt", srt: "1\n00:00:01,000 --> 00:00:02,000\n[说话人 0]: 文本" },
  };
  await fs.writeFile(path.join(dir, "BV1AbCdEfGh2.json"), JSON.stringify(snapshot));
  const loaded = await loadSnapshot(dir, "BV1AbCdEfGh2");
  expect(loaded.danmaku).toEqual([]);
  expect(loaded.comments).toEqual([]);
  expect(loaded.video?.title).toBe("标题");
  expect(normalizeTranscript(loaded)).toEqual([{ start_s: 1, end_s: 2, text: "文本" }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadSnapshot：segments 优先于 srt", async () => {
  const dir = await tempDir("bili-snap-seg-");
  const snapshot = {
    schema: "bili-snapshot/v1",
    bvid: "BV1AbCdEfGh2",
    fetched_at: "2026-10-24T00:00:00Z",
    transcript: {
      source: "cc",
      segments: [{ start_s: 3, end_s: 4, text: "结构化" }],
      srt: "1\n00:00:01,000 --> 00:00:02,000\n不该被采用",
    },
  };
  await fs.writeFile(path.join(dir, "BV1AbCdEfGh2.json"), JSON.stringify(snapshot));
  const loaded = await loadSnapshot(dir, "BV1AbCdEfGh2");
  expect(normalizeTranscript(loaded)).toEqual([{ start_s: 3, end_s: 4, text: "结构化" }]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loadSnapshot：缺失、坏 JSON、schema 不符都给可读错误", async () => {
  const dir = await tempDir("bili-snap-bad-");
  const missing = loadSnapshot(dir, "BV1zzzzzzzzz");
  await expect(missing).rejects.toThrow("快照不存在");

  await fs.writeFile(path.join(dir, "BV1AbCdEfGh2.json"), "{ 不是 JSON");
  await expect(loadSnapshot(dir, "BV1AbCdEfGh2")).rejects.toThrow("不是合法 JSON");

  await fs.writeFile(path.join(dir, "BV1AbCdEfGh2.json"), JSON.stringify({ bvid: "BV1AbCdEfGh2" }));
  await expect(loadSnapshot(dir, "BV1AbCdEfGh2")).rejects.toThrow("bili-snapshot/v1");
  await fs.rm(dir, { recursive: true, force: true });
});
