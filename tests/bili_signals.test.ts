import { test, expect } from "bun:test";
import { SnapshotSchema } from "../src/bili/snapshot";
import { associateContacts } from "../src/bili/contacts";
import { measureDataCoverage } from "../src/bili/coverage";
import { buildWindowPlannerMessages } from "../src/frame/plan";

const snapshot = (overrides: object = {}) => SnapshotSchema.parse({
  bvid: "BV1AbCdEfGh2", fetched_at: "2026-11-04T00:00:00Z", ...overrides,
});

test("覆盖率合并重叠区间、夹取越界数据，最长空档含片尾", () => {
  const data = snapshot({ video: { duration_s: 100 }, transcript: { source: "asr", segments: [
    { start_s: 20, end_s: 40, text: "二" }, { start_s: 0, end_s: 30, text: "一" },
    { start_s: 70, end_s: 75, text: "三" }, { start_s: -5, end_s: 5, text: "越界" },
    { start_s: 120, end_s: 130, text: "片外" }, { start_s: 50, end_s: 45, text: "倒序" },
  ] } });
  const coverage = measureDataCoverage(data);
  expect(coverage.transcript.covered_seconds).toBe(45);
  expect(coverage.transcript.coverage_ratio).toBe(0.45);
  expect(coverage.transcript.longest_gap).toEqual({ start_s: 40, end_s: 70, duration_s: 30 });
  expect(coverage.transcript.invalid_segment_count).toBe(1);
  expect(coverage.transcript.out_of_bounds_segment_count).toBe(2);
  const overridden = measureDataCoverage(data, 200);
  expect(overridden.transcript.longest_gap).toEqual({ start_s: 130, end_s: 200, duration_s: 70 });
});

test("未知视频时长不伪造覆盖比例；空转写和完整覆盖可区分", () => {
  const missing = measureDataCoverage(snapshot());
  expect(missing.transcript.coverage_ratio).toBeNull();
  expect(missing.transcript.longest_gap).toBeNull();
  const empty = measureDataCoverage(snapshot({ video: { duration_s: 20 } }));
  expect(empty.transcript.coverage_ratio).toBe(0);
  expect(empty.transcript.longest_gap?.duration_s).toBe(20);
  const complete = measureDataCoverage(snapshot({ video: { duration_s: 2 },
    transcript: { source: "srt", srt: "1\n00:00:00,000 --> 00:00:02,000\n文字" } }));
  expect(complete.transcript.coverage_ratio).toBe(1);
  expect(complete.transcript.longest_gap?.duration_s).toBe(0);
});

test("相同联系标识跨简介、签名、评论、ASR 关联，保留位置与时间", () => {
  const data = snapshot({
    video: { duration_s: 20, desc: "微信: Abc123 https://example.com/a" },
    author: { sign: "微信号：abc123 https://www.example.com/b" },
    comments: [{ message: "举报微信 abc123", replies: [{ message: "QQ: 123456" }] }],
    danmaku: [{ t: 3, text: "QQ：123456" }],
    transcript: { source: "asr", segments: [{ start_s: 10, end_s: 15, text: "微信 abc123" }] },
  });
  const result = associateContacts(data);
  const wechat = result.associations.find((item) => item.kind === "wechat")!;
  expect(wechat.value).toBe("abc123");
  expect(wechat.sources).toEqual(["desc", "author_sign", "comment", "transcript"]);
  expect(wechat.evidence.find((item) => item.source === "transcript")).toMatchObject({ t: 10, ref: "transcript.segments[0]" });
  expect(result.associations.find((item) => item.kind === "domain")?.value).toBe("example.com");
  expect(result.associations.find((item) => item.kind === "qq")?.sources).toEqual(["danmaku", "reply"]);
  const prompt = buildWindowPlannerMessages(data);
  expect(prompt.user).toContain('"coverage_ratio":0.25');
  expect(prompt.user).toContain('"value":"abc123"');
});

test("区分联系方式类型与同来源重复，不把裸数字或普通文本当联系方式", () => {
  expect(associateContacts(snapshot({
    video: { desc: "订单 123456 abc123 QQ: 13800138000" },
    comments: [{ message: "电话: 13800138000" }, { message: "电话: 13800138000" }],
  })).associations).toEqual([]);
  const result = associateContacts(snapshot({ video: { desc: "电话：+86 138-0013-8000 邮箱 A@EXAMPLE.COM" },
    author: { sign: "手机 13800138000 A@example.com" } }));
  expect(result.associations.find((item) => item.kind === "phone")?.value).toBe("13800138000");
  expect(result.associations.find((item) => item.kind === "email")?.value).toBe("A@example.com");
});

test("QQ 群与个人账号不能互相关联，英文单词内部不触发联系标记", () => {
  expect(associateContacts(snapshot({ video: { desc: "QQ群: 123456 avxabc123" },
    author: { sign: "QQ: 123456 avxabc123" } })).associations).toEqual([]);
  const groups = associateContacts(snapshot({ video: { desc: "QQ群: 123456" },
    author: { sign: "QQ群号：123456" } }));
  expect(groups.associations[0]?.kind).toBe("qq_group");
});

test("关联按来源去重并限制输出数量，保留总数与截断标记", () => {
  const text = Array.from({ length: 12 }, (_, i) => `微信 abc${String(i).padStart(3, "0")}`).join("，");
  const result = associateContacts(snapshot({ video: { desc: text }, author: { sign: text },
    comments: [{ message: text }, { message: text }] }));
  expect(result.total).toBe(12);
  expect(result.truncated).toBe(true);
  expect(result.associations).toHaveLength(10);
  expect(result.associations[0]?.sources).toHaveLength(3);
  expect(result.associations[0]?.occurrences).toBe(4);
  expect(result.associations[0]?.evidence).toHaveLength(3);
});
