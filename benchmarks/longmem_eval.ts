/**
 * LongMemEval 检索协议适配：把公开数据集的多会话 haystack 喂给本项目的跨会话召回层，
 * 按官方 gold 标注（会话级 answer_session_ids、回合级 has_answer）计 Recall@k / NDCG@5 / MRR。
 *
 * 只测检索层：本项目的召回只索引每会话最新一条【长期摘要】，这里把整段原始对话当作该摘要写入，
 * 所以数字刻画的是「分块 + BM25 + 向量 + RRF」本身，不等于产品链路（先摘要再召回）的质量。
 * 方法块随报告落盘——引数字必须连方法一起引。
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MemoryRecall, type MemoryRetrievalMode } from "../src/core/memory_recall";
import { LONG_TERM_SUMMARY_PREFIX, SESSION_NAME_PREFIX } from "../src/core/session_store";
import { chunkMemorySummary } from "../src/core/memory_chunks";
import { normalizeText } from "../src/rag/chunker";
import { cosineTopK } from "../src/rag/vector_store";
import { createEmbeddingClientFromEnv, type EmbeddingClient } from "../src/rag/embeddings";

interface Turn { role: string; content: string; has_answer?: boolean }
interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

/** 检索器返回的最小单元：落在哪个会话、返回了什么正文。 */
interface Ranked { sessionId: string; text: string }
interface GoldTurn { sessionId: string; body: string }

const KS: number[] = [1, 2, 5, 10];
const TOP_K = 10;
const EXCERPT_CHARS = 600;

interface Variant { label: string; mode: MemoryRetrievalMode | "legacy" }
const VARIANTS: Variant[] = [
  { label: "keyword", mode: "keyword" },
  { label: "vector", mode: "vector" },
  { label: "hybrid", mode: "hybrid" },
  { label: "legacy-whole-session", mode: "legacy" },
];

/**
 * 会话渲染成 `[i] role: content` 逐行文本；正文预先归一，行内无换行，
 * 落盘后 MemoryRecall 读回的就是这段文本，块正文与回合正文可直接比对。
 */
export function renderSession(turns: Turn[]): { text: string; gold: string[] } {
  const lines: string[] = [];
  const gold: string[] = [];
  turns.forEach((turn, index) => {
    const body = normalizeText(turn.content);
    if (!body) return;
    lines.push(`[${index}] ${turn.role}: ${body}`);
    if (turn.has_answer === true) gold.push(body);
  });
  return { text: lines.join("\n"), gold };
}

/**
 * 回合是否被这块顶出来：块首 80 字符落在回合内，或块覆盖到回合的首/中/尾任一 60 字符窗口。
 * 只在同一会话内判定，避免短回合（如 "Okay"）跨会话误配；不足 24 字符的回合要求整段出现。
 */
export function surfaces(chunk: string, body: string): boolean {
  if (!chunk || !body) return false;
  if (chunk.length >= 80 && body.includes(chunk.slice(0, 80))) return true;
  if (body.length < 24) return chunk.includes(body);
  const mid = Math.max(0, Math.floor(body.length / 2) - 30);
  return [body.slice(0, 60), body.slice(mid, mid + 60), body.slice(-60)]
    .some(probe => probe.length >= 24 && chunk.includes(probe));
}

const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

/** 名次从 0 起，未进 top-K 记 Infinity；Recall@k = 名次 < k 的 gold 占比。 */
export function recallByRank(ranks: number[], goldCount: number): number[] {
  const sorted = [...ranks].sort((a, b) => a - b);
  return KS.map(k => sorted.filter(rank => rank < k).length / Math.max(1, goldCount));
}

export function ndcgAt5(ranks: number[], goldCount: number): number {
  const hits = [...ranks].sort((a, b) => a - b).filter(rank => rank < 5);
  const dcg = hits.reduce((sum, _rank, index) => sum + 1 / Math.log2(index + 2), 0);
  const ideal = Array.from({ length: Math.min(goldCount, 5) }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return dcg / Math.max(1, ideal);
}

function firstRank(items: Array<{ matched: boolean }>): number {
  const index = items.findIndex(item => item.matched);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

interface Scored { type: string; questionId: string; sessionRanks: number[]; turnRanks: number[]; sessionRecall: number[]; turnRecall: number[] | null; ndcgAt5: number; mrr: number; goldTurns: number; goldSessions: number; returnedSessions: number }

/** -1 表示未进 top-K（JSON 没有 Infinity）。 */
function serializeRanks(ranks: number[]): number[] {
  return ranks.map(rank => Number.isFinite(rank) ? rank : -1);
}

/**
 * MemoryRecall 在向量接口报错时静默降级成关键词；没有这层记账就会把降级结果当作
 * vector/hybrid 的数字报出去。沿用 benchmarks/memory_recall_eval.ts 的纪律。
 */
interface EmbedUsage { requests: number; texts: number; errors: number; firstError: string }

function countingEmbeddings(base: EmbeddingClient, usage: EmbedUsage): EmbeddingClient {
  return {
    model: base.model,
    async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
      usage.requests++;
      usage.texts += inputs.length;
      try {
        return await base.embed(inputs, signal);
      } catch (error) {
        usage.errors++;
        if (!usage.firstError) usage.firstError = (error as Error).message.slice(0, 240);
        throw error;
      }
    },
  };
}

function summarize(label: string, scored: Scored[]) {
  const types = [...new Set(scored.map(row => row.type))];
  const shape = (rows: Scored[]) => {
    const withTurns = rows.filter(row => row.turnRecall !== null);
    return {
      n: rows.length,
      turnN: withTurns.length,
      goldTurns: rows.reduce((sum, row) => sum + row.goldTurns, 0),
      /** 召回层一条都没顶出来的题占比——记忆注入直接为空，比名次更贴近产品后果 */
      emptyRate: mean(rows.map(row => row.returnedSessions === 0 ? 1 : 0)),
      sessionRecall: KS.map((k, i) => mean(rows.map(row => row.sessionRecall[i]!))),
      turnRecall: withTurns.length === 0 ? null
        : KS.map((k, i) => mean(withTurns.map(row => row.turnRecall![i]!))),
      ndcgAt5: mean(rows.map(row => row.ndcgAt5)),
      mrr: mean(rows.map(row => row.mrr)),
    };
  };
  return { label, overall: shape(scored), byType: types.map(type => ({ type, ...shape(scored.filter(row => row.type === type)) })) };
}

/**
 * 旧实现基线：整会话一向量、只索引前 4000 字符、阈值 0.35、注入只给前 600 字符。
 * 向量服务不可用时返回空结果而不是抛错终止：缺这一格由 usage/degraded 标记为不可信。
 */
async function legacyRank(embeddings: EmbeddingClient, cache: Map<string, number[]>,
  corpus: Array<{ id: string; text: string }>, query: string): Promise<Ranked[]> {
  const indexed = corpus.map(item => ({ id: item.id, head: item.text.slice(0, 4000) }));
  const missing = [...new Set([query, ...indexed.map(item => item.head)])].filter(text => !cache.has(text));
  if (missing.length) {
    try {
      const vectors = await embeddings.embed(missing);
      missing.forEach((text, index) => { if (vectors[index]) cache.set(text, vectors[index]!); });
    } catch {
      return [];
    }
  }  const queryVector = cache.get(query);
  if (!queryVector) return [];
  const items = new Map(indexed.filter(item => cache.has(item.head)).map(item => [item.id, cache.get(item.head)!] as const));
  const byId = new Map(indexed.map(item => [item.id, item.head] as const));
  return cosineTopK(queryVector, items, TOP_K, 0.35)
    .map(hit => ({ sessionId: hit.id, text: (byId.get(hit.id) ?? "").slice(0, EXCERPT_CHARS) }));
}

async function linkOrCopy(source: string, target: string): Promise<void> {
  try { await fs.link(source, target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    // 同一题目目录会被多个检索变体复用，链接已存在即等价于成功。
    if (code === "EEXIST") return;
    if (["EPERM", "ENOSYS", "EXDEV", "EACCES"].includes(code)) {
      await fs.copyFile(source, target);
      return;
    }
    throw error;
  }
}

const QUESTION_KEY = Buffer.from('"question_id"', "utf8");

/**
 * 从文件开头推出「一道题的起始字节序列」：`{` + 该文件实际的缩进/换行 + `"question_id"`。
 * JSON 字符串里的换行一定是 `\\n` 两个字符，不会出现裸换行，所以含裸换行的序列只可能出现在结构层，
 * 会话正文再怎么写都不会伪装成题目边界。
 */
function deriveSeparator(head: Buffer): Buffer | undefined {
  const key = head.indexOf(QUESTION_KEY);
  if (key < 0) return undefined;
  const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
  let start = key;
  while (start > 0 && WS.has(head[start - 1]!)) start--;
  if (head[start - 1] !== 0x7b) return undefined; // `{` 之前必须紧邻左花括号
  return head.subarray(start - 1, key + QUESTION_KEY.length);
}

/** 数据集顶层是 `[{题},{题}…]`；按推导出的题目起始序列切分，每片单独校验是不是真题目。 */
function parseElement(slice: Buffer, file: string, offset: number): Question {
  const text = slice.toString("utf8").replace(/[\s,]+$/, "");
  if (!text.endsWith("}")) throw new Error(`${file} 的题目边界异常（偏移 ${offset}）：切出的片段不以 } 结尾`);
  const parsed = JSON.parse(text) as Question;
  if (typeof parsed.question_id !== "string" || !Array.isArray(parsed.haystack_sessions)) {
    throw new Error(`${file} 的题目边界异常（偏移 ${offset}）：切出的片段不是题目对象`);
  }
  return parsed;
}

/**
 * 流式读数据集：longmemeval_m 有 2.7GB，超过 V8 单字符串上限，整包 JSON.parse 也会把 15GB 内存的机器打爆。
 * 边读边算 sha256（引数字要能核对文件），只把选中的题目留在内存里。
 */
export async function readQuestions(
  file: string,
  select: (question: Question, index: number) => boolean
): Promise<{ questions: Question[]; sha256: string; total: number }> {
  const hash = createHash("sha256");
  const questions: Question[] = [];
  let separator: Buffer | undefined;
  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  let total = 0;
  let bytes = 0;
  for await (const piece of createReadStream(file)) {
    const chunk = piece as Buffer;
    hash.update(chunk);
    bytes += chunk.length;
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    if (!separator) {
      separator = deriveSeparator(pending);
      if (!separator) continue; // 头部还没读够一个键名
      const open = pending.indexOf(separator);
      if (open < 0) throw new Error(`${file} 里 "question_id" 前面不是 { + 空白，不是预期的题目数组`);
      pendingStart += open;
      pending = pending.subarray(open);
    }
    for (;;) {
      const next = pending.indexOf(separator, 1);
      if (next < 0) break;
      const question = parseElement(pending.subarray(0, next), file, pendingStart);
      if (select(question, total)) questions.push(question);
      total++;
      pending = pending.subarray(next);
      pendingStart += next;
    }
  }
  if (!separator) throw new Error(`${file} 不是预期的题目数组：全文没出现 { + 空白 + "question_id" 的起始序列`);
  const tail = pending.toString("utf8").replace(/\][\s]*$/, "").replace(/[\s,]+$/, "");
  if (tail.length > 0) {
    const question = parseElement(Buffer.from(tail, "utf8"), file, pendingStart);
    if (select(question, total)) questions.push(question);
    total++;
  }
  if (total === 0) throw new Error(`${file} 里没解析出任何题目（已读 ${bytes} 字节）`);
  return { questions, sha256: hash.digest("hex").slice(0, 16), total };
}

async function main(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!flag.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(flag.slice(2), next);
      i++;
    } else args.set(flag.slice(2), "1");
  }
  if (args.has("help")) {
    console.log("用法：bun run benchmarks/longmem_eval.ts --dataset <path> [--mode keyword|real] [--limit N | --per-type N] [--coverage 0~1] [--estimate] [--output dir]\n"
      + "--mode keyword（缺省）零 API 调用；--mode real 需要 EMBEDDING_* 并产生 embedding 费用，缓存落在 <output>/cache 下复用。\n"
      + "注意：数据集按题型成组排列，抽样请用 --per-type N（每型各取 N 题），--limit N 只会取到前几型。\n"
      + "real 模式还受向量侧车 maxEntries=4000 限制：单次运行的候选块总数超过它就开始逐题重嵌，别拿全量跑真实向量。");
    return;
  }
  const dataset = args.get("dataset") ?? "work/lme/longmemeval_oracle";
  const limitRaw = args.get("limit");
  const limit = limitRaw === undefined ? Number.POSITIVE_INFINITY : Number(limitRaw);
  if (Number.isFinite(limit) && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("--limit 需要正整数");
  const perTypeRaw = args.get("per-type");
  const perType = perTypeRaw === undefined ? 0 : Number(perTypeRaw);
  if (perType < 0 || !Number.isSafeInteger(perType)) throw new Error("--per-type 需要正整数");
  // 按题型成组的数据集里，--limit 只覆盖前几型；--per-type 保证六型都有样本。
  const typeCounts = new Map<string, number>();
  let taken = 0;
  const selected = await readQuestions(dataset, (question) => {
    if (taken >= limit) return false;
    if (perType > 0) {
      const count = typeCounts.get(question.question_type) ?? 0;
      if (count >= perType) return false;
      typeCounts.set(question.question_type, count + 1);
    }
    taken++;
    return true;
  });
  const questions = selected.questions;
  if (questions.length === 0) throw new Error(`抽样为空：limit=${limitRaw ?? "全部"} per-type=${perTypeRaw ?? "0"}`);
  const output = path.resolve(args.get("output") ?? "work/longmem-eval");
  // 关键词覆盖度门（MemoryRecall 默认 0.2）：0 表示不过滤，用来把「名次不够」和「被门槛拒掉」分开。
  const minKeywordCoverage = Number(args.get("coverage") ?? "0.2");
  if (!Number.isFinite(minKeywordCoverage) || minKeywordCoverage < 0 || minKeywordCoverage > 1) {
    throw new Error("--coverage 需要 0~1 之间的数");
  }
  const wantReal = args.get("mode") === "real";
  const embeddings = wantReal ? createEmbeddingClientFromEnv() : undefined;
  if (wantReal && !embeddings) throw new Error("--mode real 需要配置 EMBEDDING_MODEL 与服务地址/Key");

  // 会话级素材：每个唯一 id 只落盘一份，题目目录用硬链接指向它（同 inode → 侧车缓存跨题复用）。
  const texts = new Map<string, string>();
  const names = new Map<string, string>();
  const gold = new Map<string, GoldTurn[]>();
  for (const question of questions) {
    question.haystack_session_ids.forEach((sessionId, index) => {
      const id = sanitize(sessionId);
      if (texts.has(id)) return;
      const turns = question.haystack_sessions[index] ?? [];
      const rendered = renderSession(turns);
      texts.set(id, rendered.text);
      names.set(id, question.haystack_dates[index] ?? sessionId);
      gold.set(id, rendered.gold.map(body => ({ sessionId: id, body })));
    });
  }
  const chunkTotal = [...texts.values()].reduce((sum, text) => sum + chunkMemorySummary("x", text).length, 0);
  if (args.has("estimate")) {
    console.log(`会话池 ${texts.size} 个（${[...texts.values()].reduce((s, t) => s + t.length, 0)} 字符）→ 约 ${chunkTotal} 个块`
      + `；题目 ${questions.length} 道。real 模式待嵌入文本 ≈ ${chunkTotal}（块，按内容哈希去重后可能更少）+ ${questions.length}（查询）。`);
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longmem-eval-"));
  const poolDir = path.join(root, "pool");
  await fs.mkdir(poolDir, { recursive: true });
  await Promise.all([...texts.entries()].map(async ([sessionId, text]) => {
    const records = [
      { role: "user", content: `${SESSION_NAME_PREFIX}${names.get(sessionId)}` },
      { role: "user", content: `${LONG_TERM_SUMMARY_PREFIX}${text}` },
    ];
    await fs.writeFile(path.join(poolDir, `${sessionId}.jsonl`),
      records.map(record => JSON.stringify(record)).join("\n") + "\n");
  }));

  const runs: Array<ReturnType<typeof summarize> & { embedding: EmbedUsage | null; degraded: boolean }> = [];
  const perQuestion: Record<string, Scored[]> = {};
  for (const variant of VARIANTS) {
    if (variant.mode !== "keyword" && !embeddings) continue;
    const scored: Scored[] = [];
    const usage: EmbedUsage = { requests: 0, texts: 0, errors: 0, firstError: "" };
    const client = embeddings ? countingEmbeddings(embeddings, usage) : undefined;
    const legacyCache = new Map<string, number[]>();
    for (const question of questions) {
      const sessionIds = [...new Set(question.haystack_session_ids.map(sanitize))].filter(id => texts.has(id));
      const goldSessions = [...new Set(question.answer_session_ids.map(sanitize))].filter(id => texts.has(id));
      const goldTurns = sessionIds.flatMap(id => gold.get(id) ?? []);
      let ranked: Ranked[] = [];
      if (variant.mode === "legacy") {
        ranked = await legacyRank(client!, legacyCache,
          sessionIds.map(id => ({ id, text: texts.get(id)! })), question.question);
      } else {
        const dir = path.join(root, "q", question.question_id);
        await fs.mkdir(dir, { recursive: true });
        await Promise.all(sessionIds.map(id => linkOrCopy(
          path.join(poolDir, `${id}.jsonl`), path.join(dir, `${id}.jsonl`))));
        const recall = new MemoryRecall({
          sessionDir: dir, cacheDir: path.join(output, "cache"),
          embeddings: client ?? null, mode: variant.mode, topK: TOP_K, minKeywordCoverage,
        });
        ranked = (await recall.recall(question.question, {})).map(hit => ({ sessionId: hit.sessionId, text: hit.summary }));
      }
      // 会话级名次按「去重后的会话出现顺序」计（每会话只占一个名次），回合级按块顺序计。
      const sessionOrder = [...new Set(ranked.map(hit => hit.sessionId))];
      const sessionRanks = goldSessions.map(sessionId => {
        const position = sessionOrder.indexOf(sessionId);
        return position < 0 ? Number.POSITIVE_INFINITY : position;
      });
      const turnRanks = goldTurns.map(turn => firstRank(
        ranked.map(hit => ({ matched: hit.sessionId === turn.sessionId && surfaces(hit.text, turn.body) }))));
      const best = Math.min(...sessionRanks);
      scored.push({
        type: question.question_type,
        questionId: question.question_id,
        sessionRanks,
        turnRanks,
        sessionRecall: recallByRank(sessionRanks, goldSessions.length),
        turnRecall: goldTurns.length === 0 ? null : recallByRank(turnRanks, goldTurns.length),
        ndcgAt5: ndcgAt5(sessionRanks, goldSessions.length),
        mrr: Number.isFinite(best) ? 1 / (best + 1) : 0,
        goldTurns: goldTurns.length,
        goldSessions: goldSessions.length,
        returnedSessions: sessionOrder.length,
      });
    }
    runs.push({ ...summarize(variant.label, scored), embedding: client ? usage : null, degraded: usage.errors > 0 });
    perQuestion[variant.label] = scored;
  }
  const degradedRuns = runs.filter(run => run.degraded).map(run => run.label);

  const report = {
    protocol: "LongMemEval retrieval（会话级 answer_session_ids；回合级 has_answer，同会话内块-正文重合判定）",
    dataset: { file: dataset, sha256: selected.sha256, questions: questions.length, questionsInFile: selected.total },
    retrieval: { depth: KS, chunkChars: 500, maxChunksPerSession: 2, minKeywordCoverage,
      minSimilarity: embeddings ? 0.45 : "n/a",
      rerank: "none", judge: "none（仅检索层，不测答题正确率）", vectorCache: "各变体共用 <output>/cache（按模型+块文本哈希命中，向量与混合只嵌一次）" },
    embeddingModel: embeddings?.model ?? null,
    embeddingUsage: runs.map(run => ({ label: run.label, ...run.embedding })),
    pool: { sessions: texts.size, chunks: chunkTotal },
    degradedRuns,
    measuredAt: new Date().toISOString(),
    runs,
  };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(path.join(output, "rows.json"),
    JSON.stringify(Object.fromEntries(Object.entries(perQuestion).map(([label, rows]) => [label,
      rows.map(row => ({ ...row, sessionRanks: serializeRanks(row.sessionRanks), turnRanks: serializeRanks(row.turnRanks) }))])),
      null, 2) + "\n");

  const quad = (value: number[] | null) => value === null ? "—" : value.map(item => item.toFixed(3)).join(" ");
  const rate = (value: number) => value.toFixed(3);
  const firstRows = perQuestion[runs[0]?.label ?? "keyword"] ?? [];
  const unjudged = firstRows.filter(row => row.goldTurns === 0).map(row => row.questionId);
  const types = [...new Set(runs.flatMap(run => run.byType.map(type => type.type)))];
  const pick = (label: string, type: string, column: "sessionRecall" | "turnRecall", k: number) => {
    const found = runs.find(run => run.label === label)?.byType.find(row => row.type === type)?.[column]?.[k];
    return found === undefined ? "—" : found.toFixed(3);
  };
  const pickOne = (label: string, type: string) => {
    const found = runs.find(run => run.label === label)?.byType.find(row => row.type === type)?.emptyRate;
    return found === undefined ? "—" : found.toFixed(3);
  };
  const decorate = (run: (typeof runs)[number]) => run.label + (run.degraded ? " ⚠向量接口有失败" : "");
  console.log([
    "# LongMemEval 检索协议 · 本项目跨会话召回层", "",
    `数据集 ${dataset}（sha256 ${report.dataset.sha256}…），抽样 ${questions.length} 题；会话池 ${texts.size} 个 / ${chunkTotal} 块；embedding=${report.embeddingModel ?? "未启用"}。`,
    `方法：原始对话整段作为该会话的【长期摘要】写入 → 走真实 MemoryRecall（chunk 500 字、每会话至多 2 块、检索深度 ${KS.join("/")}${embeddings ? "、相似度下限 0.45" : ""}、无重排、无 judge），语料按题目各自的 haystack 限定。`,
    `口径：会话级名次按去重后的会话顺序（每会话占一个名次，gold=answer_session_ids）；回合级名次按块顺序，gold=has_answer 回合，判定规则为同会话内块与回合正文重合（块首 80 字落在回合内，或块覆盖回合首/中/尾任一 60 字窗口）。`,
    `「零结果」= 召回层一条都没顶出来（记忆注入为空）的题占比；oracle 的 single-session 题只给 1 个候选会话，零结果完全由过滤门造成，可直接读作「该题型被门槛拒掉的概率」。`,
    `${unjudged.length}/${questions.length} 题在所选抽样内无任何 has_answer 标注，不参与回合级均值（见表内"回合可判"列）。本表只测检索层，产品链路是先摘要再召回，二者不可混引；也不等于答题正确率。`, "",
    `| 方案 | 题数 | 回合可判 | 零结果 | 会话 R@1/2/5/10 | 回合 R@1/2/5/10 | NDCG@5 | MRR |`,
    `|---|---:|---:|---:|---|---|---:|---:|`,
    ...runs.map(run => `| ${decorate(run)} | ${run.overall.n} | ${run.overall.turnN} | ${rate(run.overall.emptyRate)} | ${quad(run.overall.sessionRecall)} | ${quad(run.overall.turnRecall)} | ${run.overall.ndcgAt5.toFixed(3)} | ${run.overall.mrr.toFixed(3)} |`),
    "",
    ...(embeddings ? [`向量调用计数（请求 / 文本 / 失败）：`,
      ...runs.filter(run => run.embedding).map(run => `- ${decorate(run)}：${run.embedding!.requests} / ${run.embedding!.texts} / ${run.embedding!.errors}`
        + (run.embedding!.errors ? ` → ${run.embedding!.firstError}` : "（无失败）"))] : []),
    "", "## 分题型 · 会话级 Recall@5", "",
    `| 题型 | ${runs.map(decorate).join(" | ")} |`, `|---|${runs.map(() => "---:").join("|")}|`,
    ...types.map(type => `| ${type} | ${runs.map(run => pick(run.label, type, "sessionRecall", 2)).join(" | ")} |`),
    "", "## 分题型 · 回合级 Recall@5", "",
    `| 题型 | ${runs.map(decorate).join(" | ")} |`, `|---|${runs.map(() => "---:").join("|")}|`,
    ...types.map(type => `| ${type} | ${runs.map(run => pick(run.label, type, "turnRecall", 2)).join(" | ")} |`),
    "", "## 分题型 · 零结果率（越低越好）", "",
    `| 题型 | ${runs.map(decorate).join(" | ")} |`, `|---|${runs.map(() => "---:").join("|")}|`,
    ...types.map(type => `| ${type} | ${runs.map(run => pickOne(run.label, type)).join(" | ")} |`),
  ].join("\n"));
  console.log(`\n报告已保存：${output}（逐题名次见 rows.json，-1 = 未进 top-K）`);
  // 向量接口失败会让 vector/hybrid 静默退化成关键词，这种表不许当向量结果引用。
  if (degradedRuns.length) {
    console.log(`\n❌ ${degradedRuns.join("、")} 存在 embedding 失败，其数字按关键词降级计，不可作为向量/混合结果引用。`);
    process.exitCode = 1;
  }
  await fs.rm(root, { recursive: true, force: true });
}

if (import.meta.main) await main(process.argv.slice(2));
