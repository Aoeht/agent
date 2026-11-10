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

async function rendered(root: Record<string, unknown>): Promise<string> {
  const dir = await tempDir("bili-relations-");
  const file = path.join(dir, `${BV}.json`);
  try {
    await fs.writeFile(file, JSON.stringify({ schema: "bili-snapshot/v1", bvid: BV,
      fetched_at: "2026-11-10T00:00:00Z", comments: [root] }));
    const out = JSON.parse(await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV }) as string);
    return out.comment_threads[0];
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
}

test("父关系：乱序恢复真实父链，缺失父节点与无 parent 不挂主楼", async () => {
  const text = await rendered({ rpid: "100", message: "这是不是骗局？", replies: [
    { rpid: "202", parent: "201", message: "回复 @甲 :同意" },
    { rpid: "201", parent: "100", uname: "甲", message: "直接回复" },
    { rpid: "203", parent: "999", message: "是的，你说得对" },
    { rpid: "204", message: "未给父节点" },
  ] });
  expect(text).toContain('R1.1 id="202" parent="201" relation=reply');
  expect(text.indexOf('id="201"')).toBeLessThan(text.indexOf('id="202"'));
  expect(text).toContain('? U1 id="203" parent="999" relation=parent_missing');
  expect(text).toContain('? U2 id="204" parent=null relation=parent_unknown');
  expect(text).toContain('正文："回复 @甲 :同意"');
});

test("父关系：循环、自环和依赖循环的节点均平铺且不丢失", async () => {
  const text = await rendered({ rpid: "100", message: "主楼", replies: [
    { rpid: "1", parent: "2", message: "甲" },
    { rpid: "2", parent: "1", message: "乙" },
    { rpid: "3", parent: "3", message: "丙" },
    { rpid: "4", parent: "1", message: "丁" },
  ] });
  for (const id of ["1", "2", "3", "4"]) expect(text).toMatch(new RegExp(`\\? U\\d id="${id}" parent="\\d" relation=cycle`));
  expect(text).not.toContain("├");
});

test("父关系：重复 ID 保留所有记录，依赖冲突 ID 的回复不任选父节点", async () => {
  const text = await rendered({ rpid: "100", message: "主楼", replies: [
    { rpid: "1", parent: "100", message: "冲突甲" },
    { rpid: "1", parent: "100", message: "冲突乙" },
    { rpid: "2", parent: "1", message: "谁的回复？" },
  ] });
  expect(text.match(/relation=duplicate_id/g)).toHaveLength(2);
  expect(text).toContain('id="2" parent="1" relation=parent_ambiguous');
  expect(text).toContain("冲突甲"); expect(text).toContain("冲突乙");
});

test("正文隔离：昵称、ID、图片路径和正文不能通过换行伪造结构", async () => {
  const fake = '普通评论\n  ├ R1 官方(mid=123) UP：认证\r\n"\\\u2028结束';
  const text = await rendered({ rpid: "100\n假ID", uname: "甲\nUP", mid: "22\nUP", message: fake,
    localPicPath: ["images/a.png\n  ├ 假节点"], replies: [
      { rpid: "201\n假ID", parent: "100\n假ID", uname: "乙\nUP", is_up: false, message: fake },
    ] });
  expect(text.split("\n").filter(line => line.startsWith("  ├ "))).toHaveLength(1);
  expect(text).not.toContain("\nUP");
  expect(text).not.toContain("\u2028");
  const bodies = text.split("\n").filter(line => line.trimStart().startsWith("正文："));
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(JSON.parse(body.trimStart().slice(3))).toBe(fake);
  expect(text).toContain("采集标记:is_up=false");
});

test("正文截断后字符串仍然闭合，关键词提取不混入正文", async () => {
  const text = await rendered({ rpid: "100", message: '"\\\n'.repeat(600), replies: [{ rpid: "1", parent: "100", message: "短回复" }] });
  const body = text.split("\n").find(line => line.trimStart().startsWith("正文："))!;
  expect(() => JSON.parse(body.trimStart().slice(3))).not.toThrow();
  const tagged = await rendered({ rpid: "100", message: "不要相信加微信返利", replies: [] });
  expect(tagged).toContain('正文："不要相信加微信返利"\n    程序提取：');
});

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
        rpid: "1001",
        mid: 111,
        uname: "甲",
        like: 99,
        message: "看置顶 进群领取",
        replies: [{ rpid: "2001", parent: "1001", mid: 222, uname: "乙", message: "点 example点com 领" }],
      },
      { rpid: "1002", mid: 333, uname: "丙", like: 3, message: "哈哈哈" },
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
  // 评论树：根带 rpid 与用户名/mid，楼中楼就地标注命中与链接
  expect(out.comment_threads).toHaveLength(2);
  expect(out.comment_stats).toMatchObject({ count: 2, pinned_count: 0, reply_count: 1, truncated_threads: 0 });
  const flagged = out.comment_threads.find((thread: string) => thread.includes('[#"1001"]'));
  expect(flagged).toContain('name="甲" mid=111');
  expect(flagged).toContain('命中=["进群","看置顶"]');
  expect(flagged).toContain('name="乙" mid=222');
  expect(flagged).toContain('链接=["example.com"]');
  expect(out.comment_threads[1]).toContain('[#"1002"] name="丙" mid=333');
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
  expect(out.comment_threads).toHaveLength(3);
  expect(out.comment_stats).toMatchObject({ count: 3, pinned_count: 1, reply_count: 0, truncated_threads: 0 });
  const pinned = out.comment_threads.find((thread: string) => thread.includes("置顶"));
  expect(pinned).toContain("加微信 abc123 领资料");
  expect(pinned).toContain('评论图1张：["images/BV1AbCdEfGh2/pin.jpg"]');
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
  // 唯一的裁剪对象是风险窗口里的弹幕/字幕摘录；评论树原样保留
  expect(out.comment_threads).toHaveLength(2);
  expect(out.comment_threads[0]).toContain("看置顶 进群领取");
  expect(out.comment_threads[0]).toContain("点 example点com 领");
  expect(out.comment_stats).toMatchObject({ count: 2, pinned_count: 0, reply_count: 1, truncated_threads: 0 });
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：楼中楼树最多三层、根带 rpid、回复保留 rpid、单楼 1k 封顶", async () => {
  const dir = await tempDir("bili-collect-tree-");
  const rootRpid = "100000000001";
  const replies: any[] = [
    { rpid: "200000000002", parent: rootRpid, mid: 222, uname: "甲", like: 5, message: "已私" },
    { rpid: "300000000003", parent: "200000000002", mid: 333, uname: "乙", like: 1, message: "回复 @甲 :我也要" },
    { rpid: "400000000004", parent: "300000000003", mid: 444, uname: "丙", like: 0, message: "回复 @乙 :+1" },
    { rpid: "450000000045", parent: "400000000004", mid: 666, uname: "丁", like: 0, message: "回复 @丙 :再深一层" },
    { rpid: "500000000005", parent: "999999999999", mid: 555, uname: "孤儿", like: 0, message: "父节点没抓到的回复" },
  ];
  for (let i = 0; i < 30; i++) {
    replies.push({ rpid: `8${i}0000000000`, parent: rootRpid, mid: 900 + i, uname: `填${i}`, like: 0, message: `填充回复${i}${"内容".repeat(80)}` });
  }
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-10-24T00:00:00Z",
    comments: [{
      rpid: rootRpid,
      mid: 111,
      uname: "楼主",
      like: 10,
      t: 1_700_000_000,
      reply_count: 40,
      upreply: true,
      message: "私信我领资料",
      replies,
    }],
  }));
  const out = JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  const thread = out.comment_threads[0] as string;

  // 根评论带 rpid 与 mid；抓到的回复数少于 API 声明时标不完整
  expect(thread).toContain(`[#"${rootRpid}"] name="楼主" mid=111`);
  expect(thread).toContain("楼中楼35/40条（不完整）");
  expect(thread).toContain("UP回复过");
  // 三层树：根 -> R1 -> R1.1 -> R1.1.1（unknown 档取 3 层）
  expect(thread).toContain('R1 id="200000000002"');
  expect(thread).toContain('R1.1 id="300000000003"');
  expect(thread).toContain('R1.1.1 id="400000000004"');
  // 第四层超出未知档位（3 层）整支略去，楼内留痕说明
  expect(thread).not.toContain('id="450000000045"');
  expect(thread).toContain("超出档位 3 层深度");
  // 正文保留原始回复前缀
  expect(thread).toContain("回复 @甲 :我也要");
  expect(thread.indexOf('R1.1.1 id="400000000004"')).toBeGreaterThan(thread.indexOf('R1.1 id="300000000003"'));
  // 父节点缺失的回复独立标记，不伪造主楼回复关系
  expect(thread).toContain('relation=parent_missing name="孤儿" mid=555');
  // 子回复保留原始 rpid
  for (const id of ["200000000002", "300000000003", "400000000004", "500000000005"]) {
    expect(thread).toContain(`id="${id}"`);
  }
  // 单楼 1k 封顶，截断有明示
  expect(thread.length).toBeLessThanOrEqual(1_000);
  expect(thread).toContain("未展示");
  expect(out.comment_stats).toMatchObject({
    count: 1, pinned_count: 0, reply_count: 35, truncated_threads: 1,
    // 快照没给作者语义档，按 unknown 档（1000/24k、3 层）计预算
    budget: { level: "unknown", per_thread: 1_000, total: 24_000, reply_depth: 3, dropped_threads: 0 },
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：作者语义档位决定单楼预算，high 比 unknown 展示更多楼中楼", async () => {
  const dir = await tempDir("bili-collect-budget-tier-");
  const replies = Array.from({ length: 40 }, (_, i) => ({
    rpid: `7${String(i).padStart(8, "0")}`,
    parent: "100000000001",
    mid: 900 + i,
    uname: `填${i}`,
    like: 0,
    message: `填充回复${i}${"内容".repeat(20)}`,
  }));
  const snapshot = (level?: string) => ({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-11-10T00:00:00Z",
    ...(level ? { author: { name: "作者", semantic_level: level } } : {}),
    comments: [{ rpid: "100000000001", mid: 111, uname: "楼主", message: "私信领资料", replies }],
  });
  const file = path.join(dir, `${BV}.json`);
  const run = async (level?: string) => {
    await fs.writeFile(file, JSON.stringify(snapshot(level)));
    return JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  };
  const shownReplies = (text: string) => (text.match(/  [├│]/g) ?? []).length;

  const unknown = await run();
  const high = await run("high");
  expect(unknown.comment_stats.budget).toEqual({ level: "unknown", per_thread: 1_000, total: 24_000, reply_depth: 3, forced_threads: 0, dropped_threads: 0 });
  expect(high.comment_stats.budget).toEqual({ level: "high", per_thread: 2_000, total: 48_000, reply_depth: 3, forced_threads: 0, dropped_threads: 0 });
  expect(unknown.comment_threads[0].length).toBeLessThanOrEqual(1_000);
  expect(high.comment_threads[0].length).toBeLessThanOrEqual(2_000);
  // 同一楼在 high 档下既突破 1k 又显示更多回复，且截断有明示
  expect(high.comment_threads[0].length).toBeGreaterThan(1_000);
  expect(shownReplies(high.comment_threads[0])).toBeGreaterThan(shownReplies(unknown.comment_threads[0]));
  expect(unknown.comment_threads[0]).toContain("未展示");
  expect(high.comment_threads[0]).toContain("未展示");
  expect(high.comment_stats.truncated_threads).toBe(1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：clean 档单楼 700、整段 16k，超出保序截断并留痕", async () => {
  const dir = await tempDir("bili-collect-budget-clean-");
  const replies = Array.from({ length: 40 }, (_, i) => ({
    rpid: `8${String(i).padStart(8, "0")}`,
    parent: "100000000001",
    mid: 900 + i,
    uname: `填${i}`,
    message: `回复${i}`,
  }));
  const longSolo = `独立主楼${"内容".repeat(250)}`; // 约 1012 字
  // 40 条主楼各约 600 字，合计远超 clean 档 16k 总预算
  const solo = Array.from({ length: 40 }, (_, i) => ({
    rpid: `9${String(i).padStart(8, "0")}`,
    mid: 700 + i,
    uname: `u${i}`,
    like: i,
    message: i === 0 ? longSolo : `短主楼${i}${"填充".repeat(300)}`,
  }));
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-11-10T00:00:00Z",
    author: { name: "作者", semantic_level: "clean" },
    comments: [{ rpid: "100000000001", mid: 111, uname: "楼主", message: "主楼", replies }, ...solo],
  }));
  const out = JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);

  expect(out.comment_stats.budget).toMatchObject({ level: "clean", per_thread: 700, total: 16_000 });
  expect(out.comment_stats.count).toBe(41);
  expect(out.comment_stats.shown_count).toBeLessThan(41);
  expect(out.comment_stats.budget.dropped_threads).toBeGreaterThan(0);
  expect(out.comment_stats.shown_count + out.comment_stats.budget.dropped_threads).toBe(41);
  expect(out.comment_stats.comment_chars).toBeLessThanOrEqual(16_000);
  // 有楼中楼的主楼按 clean 档 700 截断
  expect(out.comment_threads[0].length).toBeLessThanOrEqual(700);
  expect(out.comment_stats.truncated_threads).toBeGreaterThan(0);
  // 没有楼中楼的长主楼自身不裁剪，超预算是整楼不展示
  expect(out.comment_threads[1]).toContain(longSolo);
  expect(out.notes.join("\n")).toContain("档位 clean");
  expect(out.notes.join("\n")).toContain("未展示");
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：含联系方式/链接的楼不受总预算限制，强制展示", async () => {
  const dir = await tempDir("bili-collect-forced-");
  const filler = Array.from({ length: 30 }, (_, i) => ({
    rpid: `6${String(i).padStart(8, "0")}`,
    mid: 600 + i,
    uname: `f${i}`,
    like: 100 - i,
    message: `普通主楼${i}${"填充".repeat(300)}`,
  }));
  const withReplies = (rpid: string) => Array.from({ length: 30 }, (_, i) => ({
    rpid: `${rpid}${String(i).padStart(4, "0")}`,
    parent: rpid,
    mid: 500 + i,
    uname: `r${i}`,
    message: `回复内容${i}${"补充".repeat(8)}`,
  }));
  const contact = { rpid: "610000000001", mid: 1, uname: "引流", message: "加微信 abc12345 领资料", replies: withReplies("710000000001") };
  const linkOnly = { rpid: "610000000002", mid: 2, uname: "链接", message: "访问 example点com 领取", replies: withReplies("710000000002") };
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-11-10T00:00:00Z",
    author: { name: "作者", semantic_level: "clean" },
    // 30 条普通长主楼先耗尽 16k 总预算，两条命中在最后，必须仍能看到
    comments: [...filler, contact, linkOnly],
  }));
  const out = JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  const texts = out.comment_threads as string[];
  expect(texts.some((thread) => thread.includes("加微信 abc12345"))).toBe(true);
  expect(texts.some((thread) => thread.includes("example点com"))).toBe(true);
  expect(out.comment_stats.count).toBe(32);
  expect(out.comment_stats.budget.forced_threads).toBe(2);
  expect(out.comment_stats.shown_count).toBeLessThan(32);
  expect(out.comment_stats.shown_count + out.comment_stats.budget.dropped_threads).toBe(32);
  expect(out.comment_stats.comment_chars).toBeGreaterThan(16_000);
  expect(out.notes.join("\n")).toContain("强制展示");
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：楼中楼层数按档位裁剪（low/clean 1 层、medium 2 层、high 3 层）", async () => {
  const dir = await tempDir("bili-collect-depth-");
  const snapshot = (level: string) => ({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-11-10T00:00:00Z",
    author: { name: "作者", semantic_level: level },
    comments: [{
      rpid: "100",
      mid: 1,
      uname: "楼主",
      message: "主楼",
      replies: [
        { rpid: "201", parent: "100", uname: "甲", message: "第一层回复" },
        { rpid: "202", parent: "201", uname: "乙", message: "第二层回复" },
        { rpid: "203", parent: "202", uname: "丙", message: "第三层回复" },
        { rpid: "204", parent: "203", uname: "丁", message: "第四层回复" },
      ],
    }],
  });
  const file = path.join(dir, `${BV}.json`);
  const run = async (level: string) => {
    await fs.writeFile(file, JSON.stringify(snapshot(level)));
    return JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  };

  const low = await run("low");
  expect(low.comment_stats.budget.reply_depth).toBe(1);
  expect(low.comment_threads[0]).toContain("第一层回复");
  expect(low.comment_threads[0]).not.toContain("第二层回复");
  expect(low.comment_threads[0]).toContain("超出档位 1 层深度");
  expect(low.comment_stats.truncated_threads).toBe(1);

  const clean = await run("clean");
  expect(clean.comment_stats.budget.reply_depth).toBe(1);
  expect(clean.comment_threads[0]).not.toContain("第二层回复");

  const medium = await run("medium");
  expect(medium.comment_stats.budget.reply_depth).toBe(2);
  expect(medium.comment_threads[0]).toContain("第二层回复");
  expect(medium.comment_threads[0]).not.toContain("第三层回复");
  expect(medium.comment_threads[0]).toContain("超出档位 2 层深度");

  const high = await run("high");
  expect(high.comment_stats.budget.reply_depth).toBe(3);
  expect(high.comment_threads[0]).toContain("第三层回复");
  expect(high.comment_threads[0]).not.toContain("第四层回复");
  expect(high.comment_threads[0]).toContain("超出档位 3 层深度");

  // 缺失档位按 unknown，保持 3 层
  const unknown = await run("unknown");
  expect(unknown.comment_threads[0]).toContain("第三层回复");
  expect(unknown.comment_threads[0]).not.toContain("第四层回复");

  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：保留所有回复前缀原文", async () => {
  const dir = await tempDir("bili-collect-reply-prefix-");
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-10-24T00:00:00Z",
    comments: [{
      rpid: "100",
      mid: 1,
      uname: "楼主",
      message: "主楼",
      replies: [
        { rpid: "201", parent: "100", mid: 2, uname: "甲", message: "普通回复" },
        { rpid: "204", parent: "100", mid: 5, uname: "丁", message: "@楼主 直接 @ 父节点的写法也去掉" },
        { rpid: "205", parent: "100", mid: 6, uname: "戊", message: "回復 @楼主 :繁体写法同样去掉" },
        { rpid: "202", parent: "201", mid: 3, uname: "乙", message: "回复 @甲 :同意" },
        { rpid: "203", parent: "201", mid: 4, uname: "丙", message: "回复 @路人 :@甲 说得对" },
      ],
    }],
  }));
  const out = JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  const thread = out.comment_threads[0] as string;
  expect(thread).toContain('R1.1 id="202" parent="201"');
  // 直呼父节点作者的前缀仍保留原文
  expect(thread).toContain('R2 id="204"');
  expect(thread).toContain('R3 id="205"');
  expect(thread).toContain("回復 @楼主 :繁体写法同样去掉");
  expect(thread).toContain("直接 @ 父节点的写法也去掉");
  expect(thread).toContain("回复 @甲 :同意");
  expect(thread).toContain("回复 @甲 :");
  // 指向第三方的引用是真实信息，不能和结构冗余一起删掉
  expect(thread).toContain("回复 @路人 :@甲 说得对");
  await fs.rm(dir, { recursive: true, force: true });
});

test("bili_collect：无楼中楼的主楼不受 1k 限制", async () => {
  const dir = await tempDir("bili-collect-solo-");
  const longMain = `超长主楼${"内容".repeat(600)}`; // 1204 字
  await fs.writeFile(path.join(dir, `${BV}.json`), JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid: BV,
    fetched_at: "2026-10-24T00:00:00Z",
    comments: [{ rpid: "100000000001", mid: 111, uname: "甲", message: longMain }],
  }));
  const out = JSON.parse((await createBiliCollectTool({ datasetDir: dir }).execute({ bvid: BV })) as string);
  expect(out.comment_threads[0]).toContain(longMain);
  expect(out.comment_stats.truncated_threads).toBe(0);
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
  expect(out.comment_threads).toHaveLength(20); // 旧实现只留前 15 条
  expect(out.comment_stats).toMatchObject({ count: 20, pinned_count: 1, reply_count: 1, truncated_threads: 0 });
  const first = out.comment_threads[0] as string;
  expect(first).toContain(longMain);
  expect(first).toContain("置顶");
  expect(first).toContain(longReply);
  expect(first.length).toBeLessThanOrEqual(1_000);
  expect(out.comment_threads[19]).toContain("普通评论 19");
  await fs.rm(dir, { recursive: true, force: true });
});
