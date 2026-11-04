import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadSnapshot, loadTranscriptFile, normalizeTranscript } from "../src/bili/snapshot";
import { loadAuthorHistory } from "../src/bili/author_history";
import { createIngestFindingsTool } from "../src/tools/ingest_findings";
import { createBiliCollectTool } from "../src/tools/bili_collect";
import { buildWindowPlannerMessages } from "../src/frame/plan";

const bvid = "BV1AbCdEfGh2";

test("本地 ASR JSON 同时进入 scanner 证据和规划提示词；内嵌字幕优先", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-inputs-"));
  try {
    await fs.mkdir(path.join(dir, "transcripts"));
    const base = { bvid, fetched_at: "2026-11-04T00:00:00Z", video: { duration_s: 40 } };
    await fs.writeFile(path.join(dir, bvid + ".json"), JSON.stringify(base));
    await fs.writeFile(path.join(dir, "transcripts", bvid + ".json"), JSON.stringify({
      bvid, page: 1, source: "asr", segments: [{ start_s: 20, end_s: 25, text: "加微信领资料" }],
    }));
    const snapshot = await loadSnapshot(dir, bvid);
    expect(snapshot.transcript?.source).toBe("asr");
    expect(buildWindowPlannerMessages(snapshot).user).toContain("[20.0s-25.0s] 加微信领资料");
    const output = await createBiliCollectTool({ datasetDir: dir }).execute({ bvid });
    expect(String(output)).toContain("加微信领资料");
    expect(JSON.parse(String(output)).transcript.source).toBe("asr");
    await fs.writeFile(path.join(dir, bvid + ".json"), JSON.stringify({ ...base,
      transcript: { source: "cc", segments: [{ start_s: 0, end_s: 1, text: "已有字幕" }] },
    }));
    expect(normalizeTranscript(await loadSnapshot(dir, bvid))[0]!.text).toBe("已有字幕");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("SRT 可读，错误 BV / 分 P / 时间戳和空文件明确拒绝", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bili-transcript-"));
  try {
    const file = path.join(dir, "input.srt");
    await fs.writeFile(file, "1\n00:00:03,000 --> 00:00:04,000\n[说话人 0]: 加微信");
    expect((await loadTranscriptFile(file, bvid)).segments?.[0]).toEqual({ start_s: 3, end_s: 4, text: "加微信" });
    await fs.writeFile(file, "");
    await expect(loadTranscriptFile(file, bvid)).rejects.toThrow("有效分段");
    const json = path.join(dir, "input.json");
    const valid = { source: "asr", segments: [{ start_s: 1, end_s: 2, text: "内容" }] };
    for (const invalid of [{ ...valid, bvid: "BV1OTHER0000" }, { ...valid, page: 2 },
      { ...valid, segments: [{ start_s: 5, end_s: 2, text: "错误" }] }]) {
      await fs.writeFile(json, JSON.stringify(invalid));
      await expect(loadTranscriptFile(json, bvid)).rejects.toThrow();
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("作者结论落库后按 MID 聚合；缺证据、异账号、当前视频和坏行不抬高预算", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-history-"));
  try {
    const storePath = path.join(dir, "findings.jsonl");
    const tool = createIngestFindingsTool({ storePath, now: () => Date.parse("2026-11-01T00:00:00Z") });
    for (const [subject, mid, level, evidence] of [
      [bvid, 123, "medium", "可核对的签名原文"],
      ["BV1OTHER0000", 456, "high", "另一作者"],
      ["BV1CURRENT00", 123, "high", "当前视频"],
      ["BV1NOEVID000", 123, "high", ""],
    ] as const) {
      await tool.execute({ subject, source: "scan_video", findings: [{
        summary: "作者结论", verdict: level, evidence, dedupe_key: `${subject}:author`,
        author_risk: { owner_mid: mid, risk_level: level },
      }] });
    }
    await fs.appendFile(storePath, '{bad line\n');
    const history = await loadAuthorHistory("123", { storePath, excludeBvid: "BV1CURRENT00" });
    expect(history.level).toBe("medium");
    expect(history.records).toHaveLength(1);
    expect(history.records[0]!.bvid).toBe(bvid);
    expect((await loadAuthorHistory(999, { storePath })).level).toBe("unknown");
    await expect(loadAuthorHistory(123, { storePath: path.join(dir, "missing") })).rejects.toThrow();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
