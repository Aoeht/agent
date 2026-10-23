// RAG P0/P1 回归：分词、切块、BM25、知识缓存、Tavily client、rag_search 端到端（联网部分全部注入 mock）。
// 运行：bun run .sand-box/tests/rag.test.ts
// .env 若配了 EMBEDDING_MODEL，bun 会自动加载并让默认装配走真实 embedding 接口；测试必须密闭，这里强制纯词法（语义通道由 rag_vector.test.ts 专门测）
delete process.env.EMBEDDING_MODEL;
delete process.env.RAG_PG_URL; // 同理：不让默认装配悄悄切到 PostgreSQL，PG 路径由 rag_pg.test.ts 专门测
import fs from "node:fs/promises";
import path from "node:path";
import { tokenize } from "../src/rag/tokenizer";
import { chunkText } from "../src/rag/chunker";
import { Bm25Index } from "../src/rag/bm25";
import { KnowledgeStore, normalizeSource } from "../src/rag/knowledge_store";
import { tavilySearch, TavilyError, TavilyResponse, TavilySearchRequest } from "../src/tools/tavily_client";
import { createRagSearchTool } from "../src/tools/rag_search";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ROOT = path.resolve(".sand-box/.tmp-rag-test");
const dirFor = (name: string) => path.join(ROOT, name);

const SCAM_DOC =
  "冒充客服退款诈骗是常见的电信诈骗手法。骗子自称电商平台客服，以商品质量问题为由主动提出退款。随后诱导受害人下载会议软件开启屏幕共享，并把钱转到所谓的安全账户。";
const POLICY_DOC = "反电信网络诈骗法规定，电信业务经营者应当落实电话用户真实身份信息登记制度。银行应建立异常账户风险监测机制。";
const COOKING_DOC = "红烧肉的做法：五花肉切块焯水，加入冰糖炒出糖色，再放生抽老抽和八角小火慢炖一小时。";

function testTokenizer() {
  const tokens = tokenize("冒充客服的退款诈骗 Fake Refund");
  check(tokens.includes("客服"), "Segmenter 切偏的'客服'由二元组补回", tokens);
  check(tokens.includes("诈骗") && tokens.includes("fake") && tokens.includes("refund"), "中英文词都保留并小写", tokens);
  check(!tokens.includes("的"), "停用词被去掉", tokens);
  check(tokenize("   ").length === 0, "空白查询无词");
}

function testChunker() {
  const text = Array.from({ length: 30 }, (_, i) => `第${i}句话讲的是一个反诈知识点。`).join("");
  const chunks = chunkText(text, { maxChars: 100, overlapChars: 30 });
  check(chunks.length > 3, "长文被切成多块", chunks.length);
  check(chunks.every((c) => c.length <= 100), "每块不超过 maxChars", chunks.map((c) => c.length));
  const lastSentenceOfFirst = chunks[0]!.split("。").filter(Boolean).pop()!;
  check(chunks[1]!.includes(lastSentenceOfFirst), "相邻块按整句重叠", { first: chunks[0], second: chunks[1] });

  const longSentence = chunkText("啊".repeat(250), { maxChars: 100 });
  check(longSentence.length === 3 && longSentence.every((c) => c.length <= 100), "超长单句被硬切", longSentence.map((c) => c.length));
  check(chunkText("  \n\n ").length === 0, "空文本不产出块");
  check(chunkText("a\u0000b\u0007c")[0] === "abc", "控制字符被清理");
}

function testBm25() {
  const index = new Bm25Index([
    { id: "scam", text: SCAM_DOC },
    { id: "policy", text: POLICY_DOC },
    { id: "cook", text: COOKING_DOC },
  ]);
  const hits = index.search("客服退款诈骗案例", { minCoverage: 0.35 });
  check(hits[0]?.id === "scam", "中文查询把相关文档排第一", hits);
  check(!hits.some((h) => h.id === "cook"), "无关文档被覆盖率过滤", hits);

  const policyHits = index.search("反诈法 实名登记 银行", { minCoverage: 0 });
  check(policyHits[0]?.id === "policy", "政策类查询命中政策文档", policyHits);
  check(index.search("", {}).length === 0, "空查询不返回任何结果");
  check(index.search("量子计算", { minCoverage: 0.35 }).length === 0, "完全无关查询返回空");
}

async function testStore() {
  const dir = dirFor("store");
  const filePath = path.join(dir, "knowledge.json");
  await fs.mkdir(dir, { recursive: true });

  // 旧格式：同一来源两条，迁移后只保留最新
  await fs.writeFile(
    filePath,
    JSON.stringify([
      { content: "旧内容", source: "https://a.com/x", timestamp: 1 },
      { content: SCAM_DOC, source: "https://a.com/x/", timestamp: 2 },
      { content: POLICY_DOC, source: "https://b.com/p", timestamp: 3 },
    ])
  );
  let clock = 1_000;
  const store = new KnowledgeStore({ filePath, ttlMs: 10_000, now: () => clock });
  const migrated = await store.list();
  check(migrated.length === 2, "旧格式迁移并按来源去重", migrated.map((d) => d.source));
  check(migrated.find((d) => d.source === "https://a.com/x")?.chunks[0]?.text.includes("冒充客服") === true, "迁移保留同源最新内容");
  check(Array.isArray(JSON.parse(await fs.readFile(filePath, "utf-8"))), "只读加载不会改写旧文件");

  check(
    normalizeSource("https://A.com/x/?utm_source=t&id=1#top") === normalizeSource("https://a.com/x?id=1"),
    "URL 归一化去掉锚点/utm/末尾斜杠/主机大小写"
  );

  const [first] = await store.upsert([{ source: "https://c.com/n?utm_medium=x", content: COOKING_DOC, trust: "web" }]);
  clock = 2_000;
  const [again] = await store.upsert([{ source: "https://c.com/n", content: COOKING_DOC, trust: "web" }]);
  check(first?.id === again?.id && (await store.list()).length === 3, "同一来源重复写入不会新增文档");
  check(again?.fetchedAt === 2_000 && again.chunks.map((c) => c.id).join() === first?.chunks.map((c) => c.id).join(), "内容未变时只刷新时间，块 id 保持稳定");

  const file = JSON.parse(await fs.readFile(filePath, "utf-8"));
  check(file.version === 2 && file.docs.length === 3, "写入后升级为 v2 格式", file.version);

  // TTL：迁移来的文档 timestamp 很旧，已过期
  clock = 11_000;
  const docs = await store.list();
  check(docs.filter((d) => store.isFresh(d)).length === 1, "过期 web 文档判定为不新鲜", docs.map((d) => d.fetchedAt));
  await store.upsert([{ source: "https://internal/kb/1", content: POLICY_DOC, trust: "internal" }]);
  const afterPrune = await store.list();
  check(afterPrune.length === 2 && afterPrune.some((d) => d.trust === "internal"), "写入时清理过期文档，internal 保留", afterPrune.map((d) => d.source));

  // 并发写入：串行化后全部保留，文件始终是合法 JSON，无残留临时文件
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.upsert([{ source: `https://p.com/${i}`, content: `${SCAM_DOC}${i}`, trust: "web" }]))
  );
  const concurrent = JSON.parse(await fs.readFile(filePath, "utf-8"));
  check(concurrent.docs.length === 10, "8 个并发写入全部落盘", concurrent.docs.length);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
  check(leftovers.length === 0, "原子写不留临时文件", leftovers);

  // 容量上限：只淘汰最旧的 web 文档
  const small = new KnowledgeStore({ filePath: path.join(dir, "small.json"), maxDocs: 2, now: () => clock++ });
  await small.upsert([{ source: "https://k/internal", content: "内部", trust: "internal" }]);
  await small.upsert([{ source: "https://k/1", content: "一", trust: "web" }]);
  await small.upsert([{ source: "https://k/2", content: "二", trust: "web" }]);
  const capped = (await small.list()).map((d) => d.source).sort();
  check(capped.join(",") === "https://k/2,https://k/internal", "超出上限淘汰最旧 web 文档", capped);

  // 坏文件：挪到旁边而不是覆盖
  const brokenPath = path.join(dir, "broken.json");
  await fs.writeFile(brokenPath, "{not json");
  const broken = new KnowledgeStore({ filePath: brokenPath });
  check((await broken.list()).length === 0, "坏文件按空库加载");
  check((await fs.readdir(dir)).some((f) => f.startsWith("broken.json.corrupt-")), "坏文件被保留为 .corrupt 备份");

  // pruneInternal：只动指定前缀下的 internal 文档，web 与 keep 名单不受影响
  const pruneDir = dirFor("prune");
  const pruneStore = new KnowledgeStore({ filePath: path.join(pruneDir, "knowledge.json") });
  await pruneStore.upsert([
    { source: "internal://docs/a.md#旧章节", content: "孤儿章节内容", trust: "internal", title: "旧章节" },
    { source: "internal://docs/a.md#新章节", content: "保留章节内容", trust: "internal", title: "新章节" },
    { source: "internal://docs/b.md", content: "另一个文件", trust: "internal" },
    { source: "https://web.example/x", content: SCAM_DOC, trust: "web" },
  ]);
  const keep = new Set([pruneStore.docId("internal://docs/a.md#新章节"), pruneStore.docId("internal://docs/b.md"), pruneStore.docId("https://web.example/x")]);
  const removedDocs = await pruneStore.pruneInternal(["internal://docs/a.md"], keep);
  check(removedDocs.length === 1 && removedDocs[0]?.source === "internal://docs/a.md#旧章节", "pruneInternal 删除前缀下的孤儿", removedDocs.map((d) => d.source));
  check((await pruneStore.list()).length === 3, "keep 名单/web/前缀外的 internal 不受影响");
  check((await pruneStore.pruneInternal([], keep)).length === 0, "空前缀不删任何东西");

  // 删除记录跨 reload 生效：孤儿不会被下一次 upsert 的读盘复活
  const reloaded = new KnowledgeStore({ filePath: path.join(pruneDir, "knowledge.json") });
  check((await reloaded.list()).length === 3, "重开进程后孤儿确实已从文件消失");
}

async function testCrossProcessLock() {
  const dir = dirFor("lock");
  const filePath = path.join(dir, "knowledge.json");
  await fs.mkdir(dir, { recursive: true });
  const lockPath = `${filePath}.lock`;

  // 1. 真实子进程持锁 150ms：主进程 upsert 应等待而不是撞车，写入正常落盘
  const childScript = path.join(dir, "hold-lock.ts");
  await fs.writeFile(
    childScript,
    `import fs from "node:fs/promises";\n` +
      `const lock=${JSON.stringify(lockPath)};\n` +
      `for(let i=0;i<200;i++){try{await fs.writeFile(lock,String(process.pid),"wx");break}catch{await new Promise(r=>setTimeout(r,5));}}\n` +
      `await new Promise(r=>setTimeout(r,150));\n` +
      `await fs.rm(lock,{force:true});\n`
  );
  const store = new KnowledgeStore({ filePath });
  const child = Bun.spawn(["bun", "run", childScript]);
  await sleep(50); // 让子进程先拿到锁
  const wrote = await store.upsert([{ source: "https://lock.example/a", content: SCAM_DOC, trust: "web" }]);
  await child.exited;
  const disk = JSON.parse(await fs.readFile(filePath, "utf-8"));
  check(wrote.length === 1 && disk.docs.length === 1, "子进程持锁期间写入会等待，拿到锁后正常落盘", disk.docs?.length);
  const onDisk = (await new KnowledgeStore({ filePath }).list()).map((d) => d.source);
  check(onDisk.join() === "https://lock.example/a", "锁等待后读-改-写没有互相吞掉", onDisk);

  // 2. 锁被“别的进程”持有且未超龄：超时后报错，绝不无锁写入
  const busyPath = path.join(dir, "busy.json");
  await fs.writeFile(`${busyPath}.lock`, "999999");
  const busy = new KnowledgeStore({ filePath: busyPath, lockTimeoutMs: 80, lockRetryDelayMs: 10 });
  let threw: unknown;
  try {
    await busy.upsert([{ source: "https://busy/x", content: "x", trust: "web" }]);
  } catch (error) {
    threw = error;
  }
  check(threw instanceof Error && /占用/.test(threw.message), "锁超时报错而不是无锁写入", threw);
  const busyFileExists = await fs.stat(busyPath).then(
    () => true,
    () => false
  );
  check(!busyFileExists, "报错时没有落下半截缓存文件");
  await fs.rm(`${busyPath}.lock`, { force: true });
  await fs.rm(lockPath, { force: true });

  // 3. 超龄锁（进程崩溃残留）被抢占，写入照常完成
  const stalePath = path.join(dir, "stale.json");
  const past = new Date(Date.now() - 60_000);
  await fs.writeFile(`${stalePath}.lock`, "88888");
  await fs.utimes(`${stalePath}.lock`, past, past);
  const stale = new KnowledgeStore({ filePath: stalePath, lockRetryDelayMs: 5 });
  const saved = await stale.upsert([{ source: "https://stale/x", content: SCAM_DOC, trust: "web" }]);
  const lockStillThere = await fs.stat(`${stalePath}.lock`).then(
    () => true,
    () => false
  );
  check(saved.length === 1 && !lockStillThere, "超龄锁被抢占且用完即删");
}

/** 读路径要能发现另一个进程（例如 `bun run rag:ingest`）刚写入的内容，而不必重启 agent */
async function testReadPathSeesExternalWrites() {
  const dir = dirFor("external");
  const filePath = path.join(dir, "knowledge.json");
  await fs.mkdir(dir, { recursive: true });

  const seed = new KnowledgeStore({ filePath });
  await seed.upsert([{ source: "https://seed.example/a", content: SCAM_DOC, trust: "web" }]);
  const reader = new KnowledgeStore({ filePath });
  check((await reader.list()).length === 1, "reader 首次加载到已有文档");

  const revisionAfterFirstLoad = reader.revision;
  check((await reader.list()).length === 1 && reader.revision === revisionAfterFirstLoad, "文件未变时不重复加载");

  // getRevision 只探测不拉全量：文件未变时 revision 稳定，调用方可据此跳过 list()
  const probedBefore = await reader.getRevision();
  check(probedBefore === revisionAfterFirstLoad, "getRevision 探测未变文件返回同一 revision", { probedBefore, revisionAfterFirstLoad });
  check((await reader.getRevision()) === probedBefore, "重复探测 revision 稳定");

  const childScript = path.join(dir, "ingest-child.ts");
  await fs.writeFile(
    childScript,
    `import { KnowledgeStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/rag/knowledge_store.ts"))};\n` +
      `const store = new KnowledgeStore({ filePath: ${JSON.stringify(filePath)} });\n` +
      `await store.upsert([{ source: "internal://docs/新资料.md", content: ${JSON.stringify(COOKING_DOC)}, trust: "internal", title: "新资料" }]);\n`
  );
  const proc = Bun.spawn(["bun", "run", childScript]);
  const code = await proc.exited;
  check(code === 0, "子进程写入成功", code);

  // 不经过 list()，探测就能发现外部写入（这是上层检索缓存判断"要不要重建"的依据）
  const probedAfter = await reader.getRevision();
  check(probedAfter > revisionAfterFirstLoad, "外部进程写入后 getRevision 发现变化", { probedAfter, before: revisionAfterFirstLoad });

  const seen = await reader.list();
  check(seen.length === 2 && seen.some((d) => d.source === "internal://docs/新资料.md"), "外部进程写入后读路径自动刷新", seen.map((d) => d.source));
  check(seen.find((d) => d.source === "internal://docs/新资料.md")?.trust === "internal", "跨进程看到的 internal 标记保留");

  // 检索链路同样立即受益：命中新资料且无需联网
  const web = fakeWeb([]);
  const hit = (await createRagSearchTool({ cacheDir: dir, webSearch: web }).execute({ query: "红烧肉 冰糖 做法", top_k: 1 })) as RagOutput;
  check(hit.results[0]?.source === "internal://docs/新资料.md" && web.calls.length === 0, "rag_search 直接命中另一进程导入的资料", { source: hit.results[0]?.source, calls: web.calls.length });

  // 外部把文件挪走：读路径按空库处理而不是崩
  await fs.rm(filePath, { force: true });
  check((await reader.list()).length === 0, "文件被外部删除后按空库加载");
}

async function testTavilyClient() {
  const savedKey = process.env.TAVILY_API_KEY;
  try {
    delete process.env.TAVILY_API_KEY;
    const missing = await rejects(tavilySearch({ query: "q", maxResults: 1 }, async () => new Response("{}")));
    check(missing instanceof TavilyError && /TAVILY_API_KEY/.test(missing.message), "缺 key 直接报错而非发 Bearer undefined", missing);

    process.env.TAVILY_API_KEY = "test-key";
    let sentBody: Record<string, unknown> = {};
    let sentAuth = "";
    const ok = await tavilySearch({ query: "q", maxResults: 2, includeRawContent: true }, async (_url, init) => {
      sentBody = JSON.parse(String(init.body));
      sentAuth = new Headers(init.headers).get("Authorization") ?? "";
      return Response.json({ results: [{ title: "t", url: "https://x", content: "c", raw_content: "raw", score: 0.9 }, { url: "https://y" }] });
    });
    check(sentAuth === "Bearer test-key" && sentBody.include_raw_content === "text", "请求带 key 与 raw_content", { sentAuth, sentBody });
    check(ok.results[0]?.rawContent === "raw" && ok.results[1]?.content === "", "响应字段归一（缺失字段补空）", ok);

    const httpError = await rejects(tavilySearch({ query: "q", maxResults: 1 }, async () => new Response("quota exceeded", { status: 432 })));
    check(httpError instanceof TavilyError && /432/.test(httpError.message) && /quota/.test(httpError.message), "非 2xx 抛出带状态码的错误", httpError);

    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const timedOut = await rejects(tavilySearch({ query: "q", maxResults: 1, timeoutMs: 30 }, hang));
    check(timedOut instanceof TavilyError && /超时/.test(timedOut.message), "请求超时被翻译成检索错误", timedOut);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const aborted = await rejects(tavilySearch({ query: "q", maxResults: 1, signal: controller.signal }, hang));
    check(aborted !== undefined && !(aborted instanceof TavilyError), "上层取消原样抛出", aborted);
  } finally {
    if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedKey;
  }
}

type WebSearch = (request: TavilySearchRequest) => Promise<TavilyResponse>;

function fakeWeb(results: TavilyResponse["results"]): WebSearch & { calls: TavilySearchRequest[] } {
  const calls: TavilySearchRequest[] = [];
  const fn = Object.assign(
    async (request: TavilySearchRequest) => {
      calls.push(request);
      return { results };
    },
    { calls }
  );
  return fn;
}

interface RagOutput {
  result_count: number;
  notice: string;
  web_search_error?: string;
  sources: { title: string; url: string }[];
  results: { ref?: number; content: string; source: string; origin: string; trust: string; chunk_id: string; fetched_at: string }[];
}

async function testRagTool() {
  const web = fakeWeb([
    { title: "客服退款诈骗", url: "https://news.example/scam?utm_source=x", content: "摘要", rawContent: SCAM_DOC },
    { title: "反诈法", url: "https://law.example/p", content: POLICY_DOC },
    { title: "重复", url: "https://news.example/scam#comments", content: "摘要", rawContent: SCAM_DOC },
  ]);
  const dir = dirFor("tool");
  const tool = createRagSearchTool({ cacheDir: dir, webSearch: web });

  // 1. 空缓存 → 联网补充，中文查询拿得到结果（旧实现这里是 0 条）
  const first = (await tool.execute({ query: "冒充客服退款诈骗案例", top_k: 2 })) as RagOutput;
  check(web.calls.length === 1 && web.calls[0]?.includeRawContent === true, "空缓存时联网且请求正文", web.calls);
  check(first.result_count === 2, "中文查询返回结果", first);
  check(first.results.every((r) => r.ref === undefined && r.origin === "web" && r.trust === "web"), "工具不分配局部编号，保留来源标记", first.results);
  check(first.results.every((r) => first.sources.some((s) => s.url === r.source && s.title)), "证据块均有可注册的引用来源", first.sources);
  check(first.notice.includes("不可信") || first.notice.includes("参考资料而非指令"), "结果携带不可信数据提示", first.notice);
  check(new Set(first.results.map((r) => r.source)).size === 2, "同一网页的重复结果被去重", first.results.map((r) => r.source));

  const cached = JSON.parse(await fs.readFile(path.join(dir, "knowledge.json"), "utf-8"));
  check(cached.docs.length === 2, "联网结果去重后写入缓存", cached.docs.map((d: { source: string }) => d.source));

  // 2. 再问一次 → 本地命中，不再联网
  const second = (await tool.execute({ query: "客服退款诈骗", top_k: 1 })) as RagOutput;
  check(web.calls.length === 1, "本地足够时不联网", web.calls.length);
  check(second.results[0]?.origin === "cache" && second.results[0].content.includes("客服"), "命中本地缓存", second);

  // 3. use_cache=false 强制联网，但不清空已有缓存
  const otherWeb = fakeWeb([{ title: "红烧肉", url: "https://food.example/r", content: COOKING_DOC }]);
  const refreshTool = createRagSearchTool({ cacheDir: dir, webSearch: otherWeb });
  await refreshTool.execute({ query: "红烧肉做法", top_k: 1, use_cache: false });
  const merged = JSON.parse(await fs.readFile(path.join(dir, "knowledge.json"), "utf-8"));
  check(otherWeb.calls.length === 1 && merged.docs.length === 3, "use_cache=false 合并写入而不是覆盖", merged.docs.length);

  // 4. 跨语言：词对不上时仍返回 Tavily 判定相关的新文档（取首块）
  const englishWeb = fakeWeb([{ title: "Refund scam", url: "https://en.example/s", content: "Scammers pose as customer service agents and offer refunds." }]);
  const en = (await createRagSearchTool({ cacheDir: dirFor("en"), webSearch: englishWeb }).execute({ query: "退款诈骗", top_k: 1 })) as RagOutput;
  check(en.result_count === 1 && en.results[0]?.source === "https://en.example/s", "跨语言新结果不会被阈值吞掉", en);

  // 5. 联网失败：无本地结果时显式报错，有部分本地结果时带错误说明返回
  const failingWeb: WebSearch = async () => {
    throw new TavilyError("Tavily API error: 500");
  };
  const failEmpty = await rejects(createRagSearchTool({ cacheDir: dirFor("fail"), webSearch: failingWeb }).execute({ query: "诈骗" }));
  check(failEmpty instanceof Error && /联网检索失败/.test(failEmpty.message), "无结果且联网失败时报错而不是返回空", failEmpty);

  const partial = (await createRagSearchTool({ cacheDir: dir, webSearch: failingWeb }).execute({ query: "客服退款诈骗", top_k: 5 })) as RagOutput;
  check(partial.result_count > 0 && partial.web_search_error?.includes("500") === true, "部分本地结果 + web_search_error", partial);

  // 6. 取消信号透传给联网检索，并原样向上抛出
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const abortingWeb: WebSearch = async (request) => {
    seenSignal = request.signal;
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  };
  const aborted = await rejects(
    createRagSearchTool({ cacheDir: dirFor("abort"), webSearch: abortingWeb }).execute({ query: "诈骗" }, { signal: controller.signal })
  );
  check(seenSignal === controller.signal && (aborted as Error)?.name === "AbortError", "取消信号透传并向上抛出", aborted);

  // 7. TTL：缓存过期后不再命中，触发联网刷新
  let clock = 0;
  const ttlWeb = fakeWeb([{ title: "t", url: "https://ttl.example/a", content: SCAM_DOC }]);
  const ttlTool = createRagSearchTool({ cacheDir: dirFor("ttl"), webSearch: ttlWeb, ttlMs: 100, now: () => clock });
  await ttlTool.execute({ query: "客服退款诈骗", top_k: 1 });
  await ttlTool.execute({ query: "客服退款诈骗", top_k: 1 });
  clock = 1_000;
  await ttlTool.execute({ query: "客服退款诈骗", top_k: 1 });
  check(ttlWeb.calls.length === 2, "未过期走缓存，过期后重新联网", ttlWeb.calls.length);

  // 8. 参数校验
  const emptyQuery = await rejects(tool.execute({ query: "   " }));
  check(emptyQuery instanceof Error, "空查询被拒绝", emptyQuery);
}

async function main() {
  await fs.rm(ROOT, { recursive: true, force: true });
  try {
    testTokenizer();
    testChunker();
    testBm25();
    await testStore();
    await testCrossProcessLock();
    await testReadPathSeesExternalWrites();
    await testTavilyClient();
    await testRagTool();
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
