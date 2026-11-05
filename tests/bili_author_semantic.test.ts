import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type OpenAI from "openai";
import { scoreAuthor, scoreAuthorWithModel } from "../src/bili/author_risk";

function clientFor(content: unknown, finish_reason = "stop") {
  const requests: any[] = [];
  const client = { chat: { completions: { create: async (request: unknown) => {
    requests.push(request);
    return { choices: [{ finish_reason, message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] };
  } } } } as unknown as OpenAI;
  return { client, requests };
}

test("语义替代硬匹配：否定私信不再重复加词分，历史下限仍生效", async () => {
  const input = { fans: 22, attention: 0, sign: "投资经验；私信你的都是骗子" };
  const fake = clientFor({ risk_level: "clean", reason: "提醒防范冒充私信，没有主动邀约", evidence: [{ field: "sign", quote: "私信你的都是骗子" }] });
  const result = await scoreAuthorWithModel(input, { client: fake.client, model: "test" });
  expect(scoreAuthor(input).level).toBe("high");
  expect(result).toMatchObject({ score: 55, level: "medium", semantic: { status: "model" } });
  expect((await scoreAuthorWithModel({ ...input, history_level: "high" }, { client: fake.client })).level).toBe("high");
  expect(JSON.parse(fake.requests[0].messages[1].content)).toEqual({ name: "", sign: input.sign, recent_videos: [] });
});

test("没有词表命中也调用模型；缺粉丝也能语义上调", async () => {
  const input = { name: "教程", sign: "➕V：abc123，每天躺着拿钱，先交入门费" };
  const fake = clientFor({ risk_level: "high", reason: "站外招揽并承诺收益、要求先交费", evidence: [{ field: "sign", quote: input.sign }] });
  expect(scoreAuthor(input).level).toBe("unknown");
  const result = await scoreAuthorWithModel(input, { client: fake.client });
  expect(result).toMatchObject({ score: 74, level: "high", semantic: { status: "model" } });
  expect(fake.requests).toHaveLength(1);
});

test("坏输出、编造引用、截断、unknown 回退规则并标记，不伪装成模型成功", async () => {
  const input = { fans: 0, sign: "加微信 稳赚 带单" };
  for (const output of ["not json", { risk_level: "high", reason: "有风险", evidence: [] },
    { risk_level: "high", reason: "有风险", evidence: [{ field: "sign", quote: "原文没有这句话" }] },
    { risk_level: "unknown", reason: "无法判断", evidence: [] }]) {
    const result = await scoreAuthorWithModel(input, { client: clientFor(output).client });
    expect(result.semantic?.status).toBe("fallback");
    expect(result.score).toBe(scoreAuthor(input).score);
    expect(result.level).toBe("high");
  }
  expect((await scoreAuthorWithModel(input, { client: clientFor("{}", "length").client })).semantic?.failure).toBe("incomplete_or_refused");
});

test("网络失败不泄漏错误内容；取消仍抛出；空资料不请求模型", async () => {
  const client = { chat: { completions: { create: async () => { throw new Error("secret-provider-key"); } } } } as unknown as OpenAI;
  const result = await scoreAuthorWithModel({ sign: "加微信" }, { client });
  expect(result.semantic?.failure).toBe("request_failed");
  expect(JSON.stringify(result)).not.toContain("secret-provider-key");
  const fake = clientFor("bad");
  expect((await scoreAuthorWithModel({}, { client: fake.client })).semantic?.status).toBe("skipped");
  expect(fake.requests).toHaveLength(0);
  await expect(scoreAuthorWithModel({}, { client, signal: AbortSignal.abort() })).rejects.toThrow();
});

test("仅有作品也调用模型，证据必须绑定正确作品和字段，回执保留送入的作品", async () => {
  const input = { recent_videos: [
    { title: "先交费用再返收益", duration_s: 90, published_at: "2026-11-05T00:00:00Z" },
    { title: "普通教程", duration_s: 60, published_at: "2026-11-04T00:00:00Z" },
  ] };
  const assessment = { risk_level: "high", reason: "标题有需重点核查的话术", evidence: [
    { field: "recent_videos.title", video_index: 1, quote: "先交费用" },
    { field: "recent_videos.duration_s", video_index: 1, quote: "90" },
  ] };
  const fake = clientFor(assessment);
  const result = await scoreAuthorWithModel(input, { client: fake.client });
  expect(result).toMatchObject({ level: "high", semantic: { status: "model", prompt_version: "author-semantic/v3" } });
  expect(JSON.parse(fake.requests[0].messages[1].content).recent_videos).toEqual(result.semantic?.recent_videos);
  for (const evidence of [
    { field: "recent_videos.title", video_index: 2, quote: "先交费用" },
    { field: "recent_videos.title", quote: "先交费用" },
    { field: "recent_videos.duration_s", video_index: 1, quote: "9" },
    { field: "recent_videos.published_at", video_index: 1, quote: "2026" },
  ]) {
    const invalid = await scoreAuthorWithModel(input, { client: clientFor({ ...assessment, evidence: [evidence] }).client });
    expect(invalid.semantic?.failure).toBe("invalid_evidence");
  }
});

test("语义成功时标题由语义计分，不叠加标题词典分", async () => {
  const input = { recent_videos: [{ title: "加微信领取福利" }] };
  const fake = clientFor({ risk_level: "high", reason: "标题招揽站外", evidence: [{ field: "recent_videos.title", video_index: 1, quote: "加微信领取福利" }] });
  const result = await scoreAuthorWithModel(input, { client: fake.client });
  expect(result.score).toBe(74);
  expect(scoreAuthor(input).score).toBe(53);
});

test("同资料落盘缓存命中不重复请求；坏缓存与 TTL=0 走真实请求", async () => {
  const input = { fans: 22, sign: "加微信 稳赚 带单" };
  const assessment = { risk_level: "high", reason: "招揽并承诺收益", evidence: [{ field: "sign", quote: input.sign }] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-semantic-"));
  try {
    const first = clientFor(assessment);
    const a = await scoreAuthorWithModel(input, { client: first.client, model: "test", cacheDir: dir });
    expect(first.requests).toHaveLength(1);
    const second = clientFor({ risk_level: "clean", reason: "缓存命中时不应被调用" });
    const b = await scoreAuthorWithModel(input, { client: second.client, model: "test", cacheDir: dir });
    expect(second.requests).toHaveLength(0);
    expect(b).toMatchObject({ score: a.score, level: "high", semantic: { status: "model", cached: true } });
    const files = await fs.readdir(dir);
    if (files.length === 0) throw new Error("缓存文件未写入");
    await fs.writeFile(path.join(dir, files[0]!), "not json");
    const third = clientFor(assessment);
    const c = await scoreAuthorWithModel(input, { client: third.client, model: "test", cacheDir: dir });
    expect(third.requests).toHaveLength(1);
    expect(c.semantic?.cached).toBeUndefined();
    process.env.AUTHOR_SEMANTIC_CACHE_TTL_HOURS = "0";
    const fourth = clientFor(assessment);
    await scoreAuthorWithModel(input, { client: fourth.client, model: "test", cacheDir: dir });
    expect(fourth.requests).toHaveLength(1);
  } finally {
    delete process.env.AUTHOR_SEMANTIC_CACHE_TTL_HOURS;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
