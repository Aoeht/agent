import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAuthorHistory } from "../src/bili/author_history";

const day = 86_400_000;
const now = Date.parse("2026-11-04T00:00:00Z");
const bvid = "BV1AbCdEfGh2";
const record = (ageDays: number) => ({
  id: "finding-1", recorded_at: new Date(now - ageDays * day).toISOString(),
  subject: bvid, source: "scan_video", dedupe_key: `${bvid}:author`, evidence: "历史签名原文",
  author_risk: { owner_mid: 123, risk_level: "high" },
});
const review = (decision: string, ageDays: number) => ({
  finding_id: "finding-1", decision, reviewed_at: new Date(now - ageDays * day).toISOString(), reason: "人工核对证据",
});

test("模型历史在到期点失效，调整有效期可重放；finding 不能自报人工确认", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-expiry-"));
  try {
    const storePath = path.join(dir, "findings.jsonl");
    for (const ageDays of [89, 90, 91]) {
      await fs.writeFile(storePath, JSON.stringify({ ...record(ageDays), status: "confirmed", confirmed: true }));
      const history = await loadAuthorHistory(123, { storePath, now });
      expect(history.level).toBe(ageDays < 90 ? "high" : "unknown");
      expect(history.records[0]?.status).toBe(ageDays < 90 ? "model" : "expired");
    }
    expect((await loadAuthorHistory(123, { storePath, now, modelMaxAgeDays: 120 })).level).toBe("high");
    await expect(loadAuthorHistory(123, { storePath, now, modelMaxAgeDays: 0 })).rejects.toThrow();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("人工确认不限期；撤销按复核时间而非文件顺序生效，未来复核无效", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-review-"));
  try {
    const storePath = path.join(dir, "findings.jsonl");
    const reviewsPath = path.join(dir, "reviews.jsonl");
    await fs.writeFile(storePath, JSON.stringify(record(300)));
    await fs.writeFile(reviewsPath, JSON.stringify(review("confirmed", 200)));
    const confirmed = await loadAuthorHistory("123", { storePath, reviewsPath, now });
    expect(confirmed.level).toBe("high");
    expect(confirmed.records[0]?.status).toBe("confirmed");
    expect(confirmed.records[0]?.review?.reason).toBe("人工核对证据");
    await fs.writeFile(reviewsPath, [review("revoked", 1), review("confirmed", 200), review("confirmed", -1)].map((r) => JSON.stringify(r)).join("\n"));
    const revoked = await loadAuthorHistory(123, { storePath, reviewsPath, now });
    expect(revoked.level).toBe("unknown");
    expect(revoked.records[0]?.status).toBe("revoked");
    // 同一时刻的不同 UTC 表示也由撤销优先，避免行顺序改变结果。
    const sameTime = { ...review("confirmed", 1), reviewed_at: "2026-11-03T08:00:00+08:00" };
    await fs.writeFile(reviewsPath, [sameTime, review("revoked", 1), sameTime].map((r) => JSON.stringify(r)).join("\n"));
    expect((await loadAuthorHistory(123, { storePath, reviewsPath, now })).records[0]?.status).toBe("revoked");
    // 未来记录、当前视频、其他 MID 即使有人确认，也不能参与本次预算。
    expect((await loadAuthorHistory(123, { storePath, reviewsPath, now, excludeBvid: bvid })).records).toEqual([]);
    expect((await loadAuthorHistory(456, { storePath, reviewsPath, now })).records).toEqual([]);
    await fs.writeFile(storePath, JSON.stringify(record(-1)));
    expect((await loadAuthorHistory(123, { storePath, reviewsPath, now })).records).toEqual([]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("默认复核侧文件自动读取；格式错误或显式缺文件必须报错，不能漏掉撤销", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-review-invalid-"));
  try {
    const storePath = path.join(dir, "findings.jsonl");
    const reviewsPath = `${storePath}.author-reviews.jsonl`;
    await fs.writeFile(storePath, JSON.stringify(record(1)));
    await fs.writeFile(reviewsPath, JSON.stringify(review("revoked", 0)));
    expect((await loadAuthorHistory(123, { storePath, now })).level).toBe("unknown");
    await fs.writeFile(reviewsPath, "{broken");
    await expect(loadAuthorHistory(123, { storePath, now })).rejects.toThrow("人工复核文件格式错误");
    await expect(loadAuthorHistory(123, { storePath, now, reviewsPath: path.join(dir, "missing") })).rejects.toThrow();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
