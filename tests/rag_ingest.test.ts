// Markdown 内部资料导入回归：标题切分、source 稳定性、幂等、dry-run、与 rag_search 的 internal 通路。
// 运行：bun run .sand-box/tests/rag_ingest.test.ts
// .env 若配了 EMBEDDING_MODEL，bun 会自动加载并让默认装配走真实 embedding 接口；测试必须密闭，这里强制纯词法（语义通道由 rag_vector.test.ts 专门测）
delete process.env.EMBEDDING_MODEL;
delete process.env.RAG_PG_URL; // 同理：不让默认装配悄悄切到 PostgreSQL，PG 路径由 rag_pg.test.ts 专门测
import fs from "node:fs/promises";
import path from "node:path";
import { KnowledgeStore, normalizeSource } from "../src/rag/knowledge_store";
import { collectSections, ingestPaths, internalSource, splitMarkdown } from "../src/rag/ingest";
import { createRagSearchTool, RagSearchOptions } from "../src/tools/rag_search";
import type { TavilyResponse, TavilySearchRequest } from "../src/tools/tavily_client";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

const ROOT = path.resolve(".sand-box/.tmp-rag-ingest");
const RULES_MD = `---
title: 平台反诈规则
version: 3
---

# 平台规则

总则：所有退款必须原路返回。

## 客服退款诈骗

冒充客服要求开启屏幕共享的，一律视为诈骗。安全账户这个说法不存在。

\`\`\`bash
# 这段是命令注释，不能被当标题
echo "诱导转账"
\`\`\`

## 刷单返利

先垫付后返利的兼职都是刷单诈骗。

# 监管政策

反电信网络诈骗法要求落实实名登记。
`;

const PLAIN_TXT = "这是一份没有标题结构的内部说明，提到虚假投资理财平台的识别要点。";
const POLICY_DOC_EXTRA = "银行业金融机构应当建立可疑交易监测机制，发现异常账户及时核实处置。";

function testSplitMarkdown() {
  const sections = splitMarkdown(RULES_MD, "平台反诈规则");
  check(sections.length === 4, "按标题切成 4 段（代码块内的 # 不算标题）", sections.map((s) => s.title));
  check(sections[0]?.title === "平台规则", "顶层标题作为段名", sections[0]?.title);
  check(sections[1]?.title === "平台规则 / 客服退款诈骗", "子标题带面包屑路径", sections[1]?.title);
  check(!sections[0]!.body.includes("title: 平台反诈规则"), "front matter 被剥离", sections[0]?.body.slice(0, 40));
  check(sections[1]!.body.includes("# 这段是命令注释"), "代码块正文原样保留", sections[1]?.body.slice(-60));

  const nested = splitMarkdown("# A\n\n## B\n\n### C\n\n正文\n", "文件");
  check(nested[nested.length - 1]?.title === "A / B / C", "三级面包屑", nested.map((s) => s.title));

  check(splitMarkdown("# A\n\n空段在下面\n\n## \n", "f")[0]?.body.includes("空段") === true, "有内容的段保留");
  check(splitMarkdown("   \n\n  ", "f").length === 0, "空文件不产段");
  check(splitMarkdown("只有正文没有标题", "说明")[0]?.title === "说明", "无标题文件用文件名兜底");
}

function testSources() {
  check(
    internalSource("docs/规则.md", "平台规则 / 客服退款诈骗", "规则") === "internal://docs/规则.md#平台规则 / 客服退款诈骗",
    "source 保留中文与章节锚点",
    internalSource("docs/规则.md", "平台规则 / 客服退款诈骗", "规则")
  );
  check(internalSource("docs/规则.md", "规则", "规则") === "internal://docs/规则.md", "整文件段用裸路径", internalSource("docs/规则.md", "规则", "规则"));
  check(internalSource("a.md", "含#号 标题", "a").includes("%23"), "标题里的 # 被转义避免歧义");
  check(
    normalizeSource("internal://docs/规则.md#平台规则 / 退款") === "internal://docs/规则.md#平台规则 / 退款",
    "internal 来源不被 URL 归一化吃掉章节"
  );
  check(
    normalizeSource("https://a.com/x/?utm_source=q#frag") === normalizeSource("https://a.com/x"),
    "http(s) 仍按锚点/utm 归一"
  );
}

async function testCollect() {
  const dir = path.join(ROOT, "corpus");
  await fs.mkdir(path.join(dir, "sub"), { recursive: true });
  await fs.mkdir(path.join(dir, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(dir, "规则.md"), RULES_MD);
  await fs.writeFile(path.join(dir, "说明.txt"), PLAIN_TXT);
  await fs.writeFile(path.join(dir, "sub", "更深.md"), "# 深度资料\n\n关于虚假投资理财平台的识别。");
  await fs.writeFile(path.join(dir, "ignore.json"), "[]");
  await fs.writeFile(path.join(dir, ".hidden", "秘密.md"), "# 不该出现\n\n隐藏目录");
  await fs.writeFile(path.join(dir, "node_modules", "lib.md"), "# 不该出现\n\n依赖目录");

  const { sections, issues } = await collectSections([dir], { rootDir: ROOT });
  check(sections.length === 6, "目录递归只收 md/txt", sections.map((s) => s.source));
  check(!sections.some((s) => s.source.includes("不该出现")), "隐藏目录与 node_modules 被跳过");
  check(issues.length === 0, "目录模式不会因无关文件报错", issues);
  check(sections.every((s) => s.source.startsWith("internal://corpus/")), "source 用相对 rootDir 的路径", sections[0]?.source);

  const explicit = await collectSections([path.join(dir, "ignore.json"), path.join(dir, "规则.md")], { rootDir: ROOT });
  check(explicit.issues.some((i) => /不支持的文件类型/.test(i.error)), "显式指定不支持的类型时记录并跳过", explicit.issues);
  check(explicit.sections.length === 4, "同批次的合法文件仍被处理", explicit.sections.length);

  const missing = await collectSections([path.join(dir, "不存在.md")], { rootDir: ROOT });
  check(missing.issues.some((i) => /不存在\.md/.test(i.file)), "路径不存在记为 issue 而不抛异常", missing.issues);
}

async function testIdempotency() {
  const dir = path.join(ROOT, "corpus");
  const cache = path.join(ROOT, "cache");
  const filePath = path.join(cache, "knowledge.json");
  const store = new KnowledgeStore({ filePath });

  const first = await ingestPaths([dir], { store, rootDir: ROOT });
  check(first.files === 3 && first.sections === 6 && first.added === 6, "首次导入 3 文件 6 段全部新增", first);
  const docs = await store.list();
  check(docs.every((d) => d.trust === "internal"), "internal 标记写入成功", docs.map((d) => d.trust));
  check(docs.every((d) => !/%E5%B9%B3/.test(d.source)), "source 未被 percent-encode", docs.map((d) => d.source));
  check(docs.some((d) => d.title === "平台规则 / 客服退款诈骗" && d.chunks.length >= 1), "标题成为可展示的 title", docs.find((d) => d.title === "平台规则 / 客服退款诈骗"));

  const second = await ingestPaths([dir], { store, rootDir: ROOT });
  check(second.added === 0 && second.updated === 0 && second.unchanged === 6, "重复导入全部未变（幂等）", second);
  check((await store.list()).length === 6, "重复导入不堆积文档");

  await fs.writeFile(path.join(dir, "说明.txt"), PLAIN_TXT + "\n补充：还包括冒充公检法的资金核查话术。");
  const third = await ingestPaths([dir], { store, rootDir: ROOT });
  check(third.updated === 1 && third.unchanged === 5, "改动一个文件只记 1 个更新", third);
  const updatedDoc = (await store.list()).find((d) => d.source === "internal://corpus/说明.txt");
  check(updatedDoc?.chunks[0]?.text.includes("公检法") === true, "更新后正文被重新切块", updatedDoc?.chunks);

  const dry = await ingestPaths([path.join(dir, "新文件.md")], { store, rootDir: ROOT, dryRun: true }).then(
    () => "resolved",
    () => "threw"
  );
  const before = JSON.stringify(await store.list());
  await fs.writeFile(path.join(dir, "新文件.md"), "# 新章节\n\n内容");
  const dryRun = await ingestPaths([dir], { store, rootDir: ROOT, dryRun: true });
  check(dry === "resolved", "路径不存在时记 issue 而不抛异常");
  check(dryRun.added === 1 && JSON.stringify(await store.list()) === before, "dry-run 统计但不写盘", dryRun);
  const real = await ingestPaths([dir], { store, rootDir: ROOT });
  check(real.added === 1 && (await store.list()).length === 7, "正式运行才写入", real);
}

async function testSyncRemovesOrphans() {
  const dir = path.join(ROOT, "sync-corpus");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "规则.md"), RULES_MD);
  const store = new KnowledgeStore({ filePath: path.join(ROOT, "sync-cache", "knowledge.json") });
  // 混入一条 web 缓存，sync 绝不能碰
  await store.upsert([{ source: "https://web.example/keep", content: POLICY_DOC_EXTRA, trust: "web" }]);

  await ingestPaths([dir], { store, rootDir: ROOT });
  check((await store.list()).length === 5, "首次导入 4 段 + 1 条 web", (await store.list()).map((d) => d.source));

  // 改标题 → 旧标题的 internal 文档变成孤儿；非 sync 导入只增不删
  await fs.writeFile(path.join(dir, "规则.md"), RULES_MD.replace("## 客服退款诈骗", "## 客服退款类诈骗"));
  await ingestPaths([dir], { store, rootDir: ROOT });
  const afterPlain = await store.list();
  check(afterPlain.length === 6 && afterPlain.some((d) => d.title === "平台规则 / 客服退款诈骗"), "非 sync 导入会留下旧标题孤儿");

  // dry-run sync：报告但不删
  const dry = await ingestPaths([dir], { store, rootDir: ROOT, dryRun: true, sync: true });
  check(dry.removed.length === 1 && dry.removed[0]?.title === "平台规则 / 客服退款诈骗", "dry-run 报告将删除的孤儿", dry.removed);
  check((await store.list()).length === 6, "dry-run 不实际删除");

  // 真 sync：孤儿被清理，web 与其它章节保留
  const real = await ingestPaths([dir], { store, rootDir: ROOT, sync: true });
  check(real.removed.length === 1 && real.removed[0]?.title === "平台规则 / 客服退款诈骗", "sync 删除孤儿章节", real.removed);
  const afterSync = await store.list();
  check(afterSync.length === 5, "sync 后回到 4 段 + 1 web", afterSync.map((d) => d.source));
  check(afterSync.some((d) => d.trust === "web" && d.source === "https://web.example/keep"), "sync 不碰 web 缓存");
  check(!afterSync.some((d) => d.title === "平台规则 / 客服退款诈骗"), "孤儿彻底消失");
  await ingestPaths([dir], { store, rootDir: ROOT, sync: true });
  check((await store.list()).length === 5, "重复 sync 幂等");

  // 两个目录一起 sync：无孤儿时不误删；删掉文件后只清该前缀
  const other = path.join(ROOT, "sync-other");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, "政策.md"), "# 政策\n\n反诈法实名登记。");
  await ingestPaths([dir, other], { store, rootDir: ROOT, sync: true });
  const before = await store.list();
  check(before.length === 6 && before.some((d) => d.source === "internal://sync-other/政策.md"), "双目录 sync 幂等，前缀外不误删", before.map((d) => d.source));
  await fs.rm(path.join(dir, "规则.md"));
  const partial = await ingestPaths([dir, other], { store, rootDir: ROOT, sync: true });
  const stillThere = await store.list();
  check(partial.removed.length === 4 && stillThere.length === 2, "删掉文件后 sync 清掉其 4 个章节", partial.removed.map((r) => r.title ?? r.source));
  check(stillThere.some((d) => d.source === "internal://sync-other/政策.md" && d.trust === "internal") && stillThere.some((d) => d.trust === "web"), "前缀外的 internal 与 web 保留");

  // sync 只指定单文件/空目录时，范围只限该路径
  await fs.writeFile(path.join(dir, "规则.md"), RULES_MD);
  await ingestPaths([path.join(dir, "规则.md")], { store, rootDir: ROOT });
  await fs.rm(path.join(dir, "规则.md"));
  await ingestPaths([path.join(dir, "规则.md")], { store, rootDir: ROOT, sync: true });
  check((await store.list()).some((d) => d.source === "internal://sync-other/政策.md"), "单文件 sync 不越界删除其它目录");
}

async function testTruncationReport() {
  const dir = path.join(ROOT, "long");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "long.md"), `# 超长章节\n\n${"很长的内部说明。".repeat(200)}`);
  const store = new KnowledgeStore({ filePath: path.join(ROOT, "long", "knowledge.json"), maxContentChars: 300 });
  const report = await ingestPaths([dir], { store, rootDir: ROOT });
  check(report.truncated.length === 1 && report.truncated[0]!.chars > 300, "超过 maxContentChars 被点名", report.truncated);
  check((await store.list())[0]!.chunks.join("").length <= 300 + 40, "入库正文确实被截断");
}

interface RagOutput {
  result_count: number;
  results: { content: string; source: string; trust: string; origin: string; title?: string }[];
}

async function testSearchSeesInternal() {
  const dir = path.join(ROOT, "kb");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "规则.md"), RULES_MD);

  const calls: TavilySearchRequest[] = [];
  const webSearch = Object.assign(
    async (request: TavilySearchRequest): Promise<TavilyResponse> => {
      calls.push(request);
      throw new Error("测试不应联网");
    },
    { calls }
  );

  const cacheDir = path.join(ROOT, "kb-cache");
  const toolOptions: RagSearchOptions = { cacheDir, ttlMs: 1, webSearch };
  const tool = createRagSearchTool(toolOptions);

  // 先导入 internal，再用 ttlMs=1（web 缓存立即过期）的工具检索
  const store = new KnowledgeStore({ filePath: path.join(cacheDir, "knowledge.json"), ttlMs: 1 });
  await ingestPaths([dir], { store, rootDir: ROOT });

  const hit = (await tool.execute({ query: "客服退款 屏幕共享 安全账户", top_k: 1 })) as RagOutput;
  check(hit.result_count === 1 && calls.length === 0, "top_k 被 internal 满足时不触发联网", { count: hit.result_count, calls: calls.length });
  check(hit.results.every((r) => r.trust === "internal" && r.origin === "cache"), "结果标为 internal/来自缓存", hit.results);

  // 已知语义：本地命中数 < top_k 就会联网补足（沿用原 rag_search 设计，是否改为"仅 0 命中才联网"待产品决定）
  await tool.execute({ query: "客服退款 屏幕共享 安全账户", top_k: 3 });
  check(calls.length === 1, "本地不足 top_k 时按原设计联网补足", calls.length);
  check(
    hit.results.some((r) => r.title === "平台规则 / 客服退款诈骗"),
    "标题面包屑可用于定位章节",
    hit.results.map((r) => r.title)
  );

  const policy = (await tool.execute({ query: "反电信网络诈骗法 实名登记", top_k: 1 })) as RagOutput;
  check(policy.results[0]?.content.includes("实名登记") === true, "政策段落可被检索", policy.results[0]?.content);
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  try {
    testSplitMarkdown();
    testSources();
    await testCollect();
    await testIdempotency();
    await testSyncRemovesOrphans();
    await testTruncationReport();
    await testSearchSeesInternal();
  } finally {
    await fs.rm(ROOT, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
    if (failures > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("TEST CRASHED:", error);
    process.exitCode = 1;
  });
