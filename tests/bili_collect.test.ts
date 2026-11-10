// tests/bili_collect.test.ts
// bili_collect 工具：fixture 快照端到端（窗口/命中评论/链接来源合并/notes/输出守护）
// 运行: bun test ./tests/bili_collect.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBiliCollectTool } from "../src/tools/bili_collect";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

const BV = "BV1AbCdEfGh2";

function fixtureSnapshot() {
  return {
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-10-24T00:00:00Z",
    video: {
      title: "高薪兼职日结",
      desc: "详情加微信 abc123",
      duration_s: 120,
      owner_name: "某人",
      owner_mid: 42,
      tags: ["生活", "职场"],
    },
    author: { mid: 42, name: "某人", fans: 12, attention: 3000, official_type: 0, sign: "接推广 微信 abc123 example.com" },
    danmaku: [
      { t: 5, text: "细节看 example点com" },
      { t: 6, text: "加微信领福利" },
      { t: 15, text: "今天天气不错" },
    ],
    comments: [
      {
        uname: "甲",
        like: 99,
        message: "看置顶 进群领取",
        replies: [{ uname: "乙", message: "点 example点com 领" }],
      },
      { uname: "丙", like: 3, message: "哈哈哈" },
    ],
    transcript: { source: "srt", srt: "1\n00:00:00,000 --> 00:00:10,000\n[说话人 0]: 主页有联系方式" },
  };
}

test("bili_collect：证据聚合端到端", async () => {
  const dir = await tempDir("bili-collect-");
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify(fixtureSnapshot()));
  const tool = createBiliCollectTool({ datasetDir: dir });

  const out = JSON.parse((await tool.execute({ bvid: `https://www.bilibili.com/video/${BV}/` })) as string);

  expect(out.bvid).toBe(BV);
  expect(out.snapshot_fetched_at).toBe("2026-10-24T00:00:00Z");
  expect(out.video.title).toBe("高薪兼职日结");
  expect(out.author.fans).toBe(12);
  expect(out.author.official).toBe("无认证");
  expect(out.notes).toHaveLength(0);
  expect(out.data_coverage.transcript.coverage_ratio).toBeCloseTo(10 / 120);
  expect(out.data_coverage.transcript.longest_gap.duration_s).toBe(110);
  expect(out.contact_associations.associations.find((item: { kind: string }) => item.kind === "wechat").sources)
    .toEqual(["desc", "author_sign"]);

  // 标题/简介命中
  const titleTerms = out.title_desc_hits.map((h: { term: string }) => h.term);
  expect(titleTerms).toEqual(expect.arrayContaining(["高薪", "兼职"]));
  // 风险窗口：弹幕（链接+加微信）与字幕（联系方式）都落在 0~10s
  expect(out.risk_windows).toHaveLength(1);
  expect(out.risk_windows[0]).toMatchObject({ start_s: 0, end_s: 10, has_link: true });
  expect(out.risk_windows[0].score_breakdown.transcript).toBeGreaterThan(0);
  expect(out.risk_windows[0].score_breakdown.danmaku).toBeGreaterThan(0);
  expect(out.risk_windows[0].score).toBeCloseTo(
    out.risk_windows[0].score_breakdown.transcript + out.risk_windows[0].score_breakdown.danmaku
      + out.risk_windows[0].score_breakdown.density,
  );
  // 全量评论：命中就地标注，楼中楼链接（混淆变体已还原）
  expect(out.comments).toHaveLength(2);
  expect(out.comment_stats).toEqual({ count: 2, pinned_count: 0, reply_count: 1 });
  const flagged = out.comments.find((c: { hits?: string[] }) => c.hits?.includes("进群"));
  expect(flagged.hits).toContain("进群");
  expect(flagged.replies[0].links).toContain("example.com");
  // 旧字段已移除
  expect(out.flagged_comments).toBeUndefined();
  expect(out.top_comments).toBeUndefined();
  // 链接来源合并：弹幕与评论里的同一主机合成一条，来源并集；两处都是混淆形态
  const link = out.links.find((l: { normalized: string }) => l.normalized === "example.com");
  expect(link).toBeDefined();
  expect(link.sources).toEqual(expect.arrayContaining(["author_sign", "danmaku", "comment"]));
  expect(link.kind).toBe("domain");
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：置顶评论强制入列并带评论图路径", async () => {
  const dir = await tempDir("bili-collect-pinned-");
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-10-24T00:00:00Z",
    video: { title: "教程", desc: "", duration_s: 60 },
    author: { mid: 42, name: "某人" },
    comments: [
      {
        like: 0,
        is_pinned: true,
        message: "置顶：加微信 abc123 领资料",
        localPicPath: ["images/BV1AbCdEfGh2/pin.jpg"],
        pics: ["http://example.com/pin.jpg"],
      },
      { like: 999, message: "普通高赞评论" },
      {
        like: 5,
        message: "带图评论",
        localPicPath: ["images/BV1AbCdEfGh2/a.jpg"],
      },
    ],
  }));
  const tool = createBiliCollectTool({ datasetDir: dir });
  const out = JSON.parse((await tool.execute({ bvid: BV })) as string);
  // 置顶评论赞数为 0 也照样全量输出，并带置顶标记与评论图路径
  expect(out.comments).toHaveLength(3);
  expect(out.comment_stats).toEqual({ count: 3, pinned_count: 1, reply_count: 0 });
  expect(out.comments.find((c: { is_pinned?: boolean }) => c.is_pinned)).toMatchObject({
    is_pinned: true,
    image_count: 1,
    local_images: ["images/BV1AbCdEfGh2/pin.jpg"],
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：快照缺失给可读错误；最小快照缺维度进 notes", async () => {
  const tool = createBiliCollectTool({ datasetDir: tmpdir() });
  const missing = (await tool.execute({ bvid: BV })) as string;
  expect(missing).toContain("快照不存在");
  expect(missing).toContain("dataset");

  const dir = await tempDir("bili-collect-min-");
  await fs.writeFile(
    path.join(dir, `${BV}.json`),
    JSON.stringify({ schema: "bili-snapshot/v1", bvid: BV, fetched_at: "2026-10-24T00:00:00Z" }),
  );
  const minimal = JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  expect(minimal.risk_windows).toHaveLength(0);
  expect(minimal.notes.join("\n")).toContain("video");
  expect(minimal.notes.join("\n")).toContain("author");
  expect(minimal.notes.join("\n")).toContain("弹幕");
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：输出超长时压缩弹幕/字幕摘录并留痕，评论不动", async () => {
  const dir = await tempDir("bili-collect-big-");
  const snapshot = fixtureSnapshot();
  // 60 条超长弹幕分布在 6 个分离时间段，把证据撑过 OUTPUT_CHAR_LIMIT
  snapshot.danmaku = Array.from({ length: 60 }, (_, i) => ({
    t: Math.floor(i / 10) * 100 + (i % 10),
    text: `加微信领取超大福利包${"很长的弹幕内容".repeat(200)}`,
  }));
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify(snapshot));
  const tool = createBiliCollectTool({ datasetDir: dir });
  const raw = (await tool.execute({ bvid: BV })) as string;
  expect(raw.length).toBeLessThan(28_000);
  const out = JSON.parse(raw); // 压缩后仍是可解析 JSON
  expect(out.size_trimmed).toBe(true);
  for (const w of out.risk_windows) {
    for (const hit of w.danmaku_hits) expect(hit.text.length).toBeLessThanOrEqual(101);
    expect(w.transcript_excerpt.length).toBeLessThanOrEqual(201);
  }
  // 唯一的裁剪对象是风险窗口里的弹幕/字幕摘录；评论全量原样
  expect(out.comments).toHaveLength(2);
  expect(out.comments[0].message).toBe("看置顶 进群领取");
  expect(out.comments[0].replies[0].message).toBe("点 example点com 领");
  expect(out.comment_stats).toEqual({ count: 2, pinned_count: 0, reply_count: 1 });
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：评论全量输出，长文/楼中楼/时间点都不截断", async () => {
  const dir = await tempDir("bili-collect-all-");
  const longMain = `超长评论${"内容".repeat(200)}`; // 404 字，远超旧 160 字截断
  const longReply = `楼中楼${"回复".repeat(150)}`; // 302 字，远超旧 200 字截断
  const comments = Array.from({ length: 20 }, (_, i) => ({
    uname: `u${i}`,
    like: i,
    t: i * 3,
    message: i === 0 ? longMain : `普通评论 ${i}`,
    ...(i === 0 ? { is_pinned: true, replies: [{ uname: "r", message: longReply }] } : {}),
  }));
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-10-24T00:00:00Z",
    comments,
  }));
  const out = JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  expect(out.size_trimmed).toBeUndefined();
  expect(out.comments).toHaveLength(20); // 旧实现只留前 15 条
  expect(out.comment_stats).toEqual({ count: 20, pinned_count: 1, reply_count: 1 });
  expect(out.comments[0]).toMatchObject({ uname: "u0", like: 0, t: 0, is_pinned: true, message: longMain });
  expect(out.comments[0].replies[0].message).toBe(longReply);
  expect(out.comments[19]).toMatchObject({ uname: "u19", message: "普通评论 19", t: 57 });
  await fs.rm(dir, { recursive: true, force: true });
});
