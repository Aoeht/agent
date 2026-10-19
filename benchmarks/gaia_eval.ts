// GAIA 基准评测骨架：加载 GAIA 元数据（JSONL / Parquet）→ 逐题驱动真实 Agent → 官方口径打分 → 汇总报告。
//
// 真实评测（.env 需配好 OPENAI_* 与 TAVILY_API_KEY）：
//   bun run benchmarks/gaia_eval.ts --data benchmarks/gaia/2023/validation/metadata.jsonl
//   HF 新版数据集是 parquet：把 --data 换成 metadata.parquet 或直接给目录均可
// 无网自检（假 LLM + 合成 fixture，验证全链路而不花真钱）：
//   bun run benchmarks/gaia_eval.ts --mock --timeout 1500
//
// 设计要点：
// 1) 直接 import 项目根目录 src/——测的就是当前那份 Agent，无构建步骤。
// 2) 每题独立 SessionStore（sessions/<task_id>.jsonl），题与题之间零历史污染。
// 3) 打分复刻官方 leaderboard scorer.py 的 quasi-exact-match：数值 / 列表 / 字符串三分支，
//    "整串归一化后精确相等"，而不是"包含即对"（最终回答里带解释句会被判错）。
// 4) 附件按 file_path 从数据集目录拷贝进 questions/<task_id>/；文件系统 MCP 的根目录 = 本次运行目录。
// 5) 每题独立超时；单题异常/超时只记该题失败，不中断整场评测。
//
// 数据准备（GAIA 验证集为 gated，需在 HF 页面同意条款并登录）：
//   hf download gaia-benchmark/GAIA --repo-type dataset --include "2023/validation/*" --local-dir benchmarks/gaia
//   元数据: benchmarks/gaia/2023/validation/metadata.jsonl（或 metadata.parquet）；附件在其旁按 file_path 相对存放。

import path from "node:path";
import fs from "node:fs/promises";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { Agent } from "../src/core/agent";
import { SessionStore } from "../src/core/session_store";
import { ToolRegistry } from "../src/core/registry";
import { createSearchWebTool } from "../src/tools/tavily_search";
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";

// =====================================================================
// 一、官方打分器移植（quasi-exact-match）
// 来源：gaia-benchmark/leaderboard scorer.py（经 camel-ai/camel gaia.py 镜像核对）
// 规则：
//   - 若 ground truth 是数字：把模型回答去掉 $ % 逗号后必须能整体转成数字并精确相等；
//   - 否则若 ground truth 含逗号/分号（列表）：两边都按 [,;] 切分，长度必须一致，
//     逐项比较（数字项按数字比，字符串项去空白+小写但保留标点）；
//   - 否则（字符串）：两边都"去全部空白 + 小写 + 去 ASCII 标点"后精确相等。
// =====================================================================

const PY_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'); // Python string.punctuation

/** 模拟 Python float()：整串解析，失败返回 null；支持 inf/nan 与首尾空白 */
function pythonFloat(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN; // Python float("nan") 合法，但 NaN != 任何值
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
  return Number(s);
}

function isFloatText(s: string): boolean {
  return pythonFloat(s) !== null;
}

/** 官方 normalize_number_str：去掉 $ % 和千分位逗号后整体转数字，失败记 Infinity（对齐 float("inf")） */
function normalizeNumberStr(s: string): number {
  const stripped = s.replace(/[$%,]/g, "");
  const v = pythonFloat(stripped);
  return v === null ? Infinity : v;
}

function splitList(s: string): string[] {
  return s.split(/[,;]/);
}

function normalizeStr(input: string, removePunct = true): string {
  const noSpaces = input.replace(/\s/g, "").toLowerCase();
  if (!removePunct) return noSpaces;
  return [...noSpaces].filter((ch) => !PY_PUNCT.has(ch)).join("");
}

export function questionScorer(modelAnswer: string, groundTruth: string): boolean {
  // 分支 1：数值 ground truth
  if (isFloatText(groundTruth)) {
    const gt = pythonFloat(groundTruth)!;
    return normalizeNumberStr(modelAnswer) === gt;
  }

  // 分支 2：列表 ground truth（含逗号或分号）
  if (groundTruth.includes(",") || groundTruth.includes(";")) {
    const gtElems = splitList(groundTruth);
    const maElems = splitList(modelAnswer);
    if (gtElems.length !== maElems.length) return false;
    return gtElems.every((gtElem, i) => {
      const maElem = maElems[i]!;
      if (isFloatText(gtElem)) return normalizeNumberStr(maElem) === pythonFloat(gtElem)!;
      return normalizeStr(maElem, false) === normalizeStr(gtElem, false);
    });
  }

  // 分支 3：字符串 ground truth
  return normalizeStr(modelAnswer) === normalizeStr(groundTruth);
}

/** 打分器行为钉子：mock 自检开始时先跑这批用例，防止打分器悄悄改坏 */
const SCORER_CASES: Array<[gt: string, answer: string, expected: boolean]> = [
  ["42", "42", true],
  ["42", "42.0", true],
  ["42", "$42", true], // 数值：去 $ 后精确相等
  ["1234.5", "$1,234.5", true], // 数值：去 $ 与千分位逗号
  ["42", "The answer is 42", false], // 数值：不是"包含即对"，整串必须归一化成数字
  ["Charles Darwin", "charles, darwin!", true], // 字符串：小写 + 去空白 + 去标点
  ["New York City", "newyorkcity", true], // 空白被整体移除
  ["Babbage", "babbage", true],
  ["50%", "50", true], // 字符串分支：% 作为标点被去掉
  ["Mercury, Venus, Earth", "mercury; venus; earth", true], // 列表：逗号/分号等价
  ["Mercury, Venus, Earth", "venus; earth", false], // 列表长度不一致直接失败
  ["10, 20", "10,20", true], // 列表里的数值项按数值比较
];

// =====================================================================
// 二、CLI 与类型
// =====================================================================

interface CliOptions {
  data?: string | undefined;
  mock: boolean;
  model: string;
  levels?: Set<number> | undefined;
  limit?: number | undefined;
  timeoutMs: number;
  maxIterations: number;
  concurrency: number;
  outDir?: string | undefined;
  attachmentsRoot?: string | undefined;
}

function printUsage(): void {
  console.log(`GAIA 评测用法（在项目根目录执行）:
  bun run benchmarks/gaia_eval.ts --data <metadata.jsonl|目录> [选项]
  bun run benchmarks/gaia_eval.ts --mock [--timeout 1500]

选项:
  --data <path>             GAIA 元数据 JSONL（或包含它的目录）
  --mock                    假 LLM 自检模式：不联网、不花钱，跑合成 fixture 验证全链路
  --model <name>            模型名（默认 deepseek-v4-pro）
  --level <1,2,3>           只跑指定 Level
  --limit <N>               过滤后只跑前 N 题
  --timeout <ms>            单题超时（默认 300000）
  --max-iterations <N>      Agent 最大迭代次数（默认 15）
  --concurrency <N>         并发题数（默认 1）
  --out <dir>               结果目录（默认 benchmarks/gaia-runs/<时间戳>）
  --attachments-root <dir>  附件根目录（默认从 JSONL 所在目录逐级向上找 file_path）`);
}

function parseCli(argv: string[]): CliOptions {
  const o: CliOptions = { mock: false, model: "deepseek-v4-pro", timeoutMs: 300_000, maxIterations: 15, concurrency: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case "--mock": o.mock = true; break;
      case "--data": o.data = val(); break;
      case "--model": o.model = val(); break;
      case "--level": o.levels = new Set(val().split(",").map((s) => Number(s.trim()))); break;
      case "--limit": o.limit = Number(val()); break;
      case "--timeout": o.timeoutMs = Number(val()); break;
      case "--max-iterations": o.maxIterations = Number(val()); break;
      case "--concurrency": o.concurrency = Number(val()); break;
      case "--out": o.outDir = val(); break;
      case "--attachments-root": o.attachmentsRoot = val(); break;
      case "--help": case "-h": printUsage(); process.exit(0); break;
      default: console.warn(`⚠️  未知参数已忽略: ${a}`);
    }
  }
  return o;
}

interface GaiaTask {
  task_id: string;
  Question: string;
  Level: number;
  finalAnswer: string;
  file_name?: string | undefined;
  file_path?: string | undefined;
}

interface TaskRunResult {
  task: GaiaTask;
  predicted: string | null;
  correct: boolean;
  success: boolean;
  error?: string | undefined;
  tokens: number;
  toolCalls: number;
  llmCalls: number;
  durationMs: number;
  sessionFile: string;
  attachment?: { relativePath: string; copied: boolean } | undefined;
}

// =====================================================================
// 三、数据加载与附件解析
// =====================================================================

function coerceTask(raw: Record<string, unknown>): GaiaTask | null {
  const id = raw["task_id"];
  const question = raw["Question"];
  const answer = raw["Final answer"];
  const level = Number(raw["Level"]);
  if (typeof id !== "string" || typeof question !== "string" || answer === undefined) return null;
  if (!Number.isFinite(level) || level < 1) return null;
  const fileName = typeof raw["file_name"] === "string" && raw["file_name"] ? raw["file_name"] : undefined;
  const filePath = typeof raw["file_path"] === "string" && raw["file_path"] ? raw["file_path"] : undefined;
  return {
    task_id: id,
    Question: question,
    Level: level,
    finalAnswer: String(answer),
    ...(fileName ? { file_name: fileName } : {}),
    ...(filePath ? { file_path: filePath } : {}),
  };
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

async function findDataFilesUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findDataFilesUnder(p, depth + 1)));
    else if (e.name.endsWith(".jsonl") || e.name.endsWith(".parquet")) out.push(p);
  }
  return out;
}

async function loadTasksFromPath(dataPath: string): Promise<{ tasks: GaiaTask[]; dataFile: string; dataDir: string }> {
  const abs = path.resolve(dataPath);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) throw new Error(`数据路径不存在: ${abs}`);

  let dataFile = abs;
  if (st.isDirectory()) {
    const candidates = [
      "metadata.jsonl", "metadata.parquet",
      "validation/metadata.jsonl", "validation/metadata.parquet",
      "2023/validation/metadata.jsonl", "2023/validation/metadata.parquet",
      "test/metadata.jsonl", "test/metadata.parquet",
    ].map((rel) => path.join(abs, rel));
    for (const c of candidates) {
      if (await exists(c)) { dataFile = c; break; }
    }
    if (dataFile === abs) {
      const found = (await findDataFilesUnder(abs)).sort();
      const preferred =
        found.find((f) => path.basename(f) === "metadata.jsonl") ??
        found.find((f) => path.basename(f) === "metadata.parquet") ??
        found[0];
      if (!preferred) throw new Error(`目录里没找到 .jsonl / .parquet: ${abs}`);
      dataFile = preferred;
    }
  }

  const rows: Record<string, unknown>[] = [];
  let bad = 0;
  if (dataFile.endsWith(".parquet")) {
    for (const row of await parquetReadObjects({ file: await asyncBufferFromFile(dataFile) })) rows.push(row);
  } else {
    const raw = await fs.readFile(dataFile, "utf-8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t) as Record<string, unknown>);
      } catch {
        bad++;
      }
    }
  }

  const tasks: GaiaTask[] = [];
  for (const row of rows) {
    const task = coerceTask(row);
    task ? tasks.push(task) : bad++;
  }
  if (bad > 0) console.warn(`⚠️  跳过了 ${bad} 行无法解析的记录`);
  return { tasks, dataFile, dataDir: path.dirname(dataFile) };
}

/** 附件定位：先试 --attachments-root，再从元数据文件所在目录逐级向上找 <root>/<file_path> */
async function resolveAttachment(task: GaiaTask, dataDir: string, overrideRoot?: string): Promise<string | null> {
  const filePath = task.file_path;
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return (await exists(filePath)) ? filePath : null;

  const roots: string[] = [];
  if (overrideRoot) roots.push(path.resolve(overrideRoot));
  for (let dir = path.resolve(dataDir); ; dir = path.dirname(dir)) {
    roots.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const root of roots) {
    const candidate = path.join(root, filePath);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// =====================================================================
// 四、Mock 自检：假 LLM（真实 HTTP）+ 合成 fixture + 脚本化答案
// =====================================================================

const DEFAULT_FIXTURE = path.join(import.meta.dir, "gaia_fixture", "fixture.jsonl");
const HANG = "__HANG__";

// 每个 task_id 的脚本回答（跑 fixture 用；__HANG__ 表示永不返回，用来验证超时链路）
const MOCK_SCRIPT: Record<string, string> = {
  "mock-num-001": "$42", // 数值归一化后正确
  "mock-str-002": "charles, darwin.", // 字符串归一化后正确
  "mock-file-003": "opensesame", // 附件题，直接答对
  "mock-list-004": "mercury; venus; earth", // 列表分支正确
  "mock-hard-005": "The train travels at an average speed of 80 km/h.", // 官方口径判错（带解释句）
  "mock-timeout-006": HANG,
};

interface MockLlm {
  port: number;
  requestLog: Array<{ taskId: string | null; messages: Array<{ role: string; content?: unknown }> }>;
  callsByTask: Map<string, number>;
  toolExecutions: { count: number };
  stop: () => void;
}

function completion(message: Record<string, unknown>, finishReason: string): Response {
  return Response.json({
    id: "chatcmpl-gaia-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

function startMockLlm(tasks: GaiaTask[]): MockLlm {
  const requestLog: MockLlm["requestLog"] = [];
  const callsByTask = new Map<string, number>();
  const state = { stopping: false };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });

      const body = (await req.json()) as { messages?: Array<{ role: string; content?: unknown }> };
      const messages = body.messages ?? [];
      let lastUser = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "user" && typeof m.content === "string") { lastUser = m.content; break; }
      }
      const task = tasks.find((t) => lastUser.includes(t.Question));
      const taskId = task?.task_id ?? null;
      requestLog.push({ taskId, messages });
      const key = taskId ?? "?";
      const count = callsByTask.get(key) ?? 0;
      callsByTask.set(key, count + 1);

      const script = task ? (MOCK_SCRIPT[task.task_id] ?? task.finalAnswer) : "mock";

      if (script === HANG) {
        // 卡住不返回，等评测侧超时取消；stop() 后立即退出循环，避免拖住进程
        const t0 = Date.now();
        while (!state.stopping && Date.now() - t0 < 30_000) await Bun.sleep(200);
        return completion({ role: "assistant", content: "(hang placeholder)" }, "stop");
      }
      if (count === 0) {
        // 第一轮先要一次工具，把 工具回环 + 结果回填 + 第二轮回答 完整走一遍
        return completion(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_mock_${requestLog.length}`,
                type: "function",
                function: { name: "search_web", arguments: JSON.stringify({ query: lastUser.slice(0, 60) }) },
              },
            ],
          },
          "tool_calls"
        );
      }
      return completion({ role: "assistant", content: script }, "stop");
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("假 LLM 服务未能绑定端口");
  return {
    port,
    requestLog,
    callsByTask,
    toolExecutions: { count: 0 },
    stop: () => { state.stopping = true; server.stop(true); },
  };
}

function registerMockSearchTool(registry: ToolRegistry, counter: { count: number }): void {
  registry.register(
    {
      name: "search_web",
      description: "（自检用）假联网搜索，返回固定文本",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: async (args) => {
        counter.count++;
        return { answer: "mock 搜索结果", query: (args as { query?: string }).query ?? "" };
      },
    },
    { replace: true }
  );
}

// =====================================================================
// 五、运行器
// =====================================================================

function buildSystemPrompt(runDir: string): string {
  return `你是参加测试的通用 AI 助手，需要通过联网检索与本地文件分析回答难题。

【运行环境与规则】
1. 当前系统: Windows
2. 工作区根目录: "${runDir}"（所有文件操作必须在该目录内；题目附件放在 questions/<task_id>/ 子目录）
3. 需要事实、数字或最新信息时，必须先调用工具（search_web 联网搜索）核实，不要凭记忆猜测。
4. 最终回答必须只包含答案本身：一个数字、一个单词或一个短语；答案是数字时只输出数字本身，是列表时用逗号分隔。不要任何解释、前缀或额外句子。
5. 每道题相互独立，不要引用或假设任何历史对话。`;
}

async function runOneTask(
  task: GaiaTask,
  opts: {
    model: string;
    systemPrompt: string;
    maxIterations: number;
    tools: ToolRegistry;
    timeoutMs: number;
    runDir: string;
    sessionsDir: string;
    dataDir: string;
    attachmentsRoot?: string | undefined;
    globalSignal: AbortSignal;
  }
): Promise<TaskRunResult> {
  const started = Date.now();
  const relDir = `questions/${task.task_id}`;
  const absDir = path.join(opts.runDir, "questions", task.task_id);
  let attachment: TaskRunResult["attachment"];
  let note = "";

  if (task.file_path) {
    const fileName = task.file_name ?? path.basename(task.file_path);
    try {
      const srcPath = await resolveAttachment(task, opts.dataDir, opts.attachmentsRoot);
      if (srcPath) {
        await fs.mkdir(absDir, { recursive: true });
        await fs.copyFile(srcPath, path.join(absDir, fileName));
        attachment = { relativePath: `${relDir}/${fileName}`, copied: true };
        note = `\n\n【附件】本题所需文件已放到工作区相对路径 "${relDir}/${fileName}"，请读取后作答。`;
      } else {
        attachment = { relativePath: `${relDir}/${fileName}`, copied: false };
        note = `\n\n【提示】本题原始附件缺失（未找到 ${task.file_path}），请结合题干与工具检索作答。`;
        console.warn(`⚠️  附件未找到: ${task.file_path}（${task.task_id}）`);
      }
    } catch (e) {
      attachment = { relativePath: `${relDir}/${fileName}`, copied: false };
      note = `\n\n【提示】本题附件准备失败，请结合题干与工具检索作答。`;
      console.warn(`⚠️  附件准备失败: ${task.file_path}（${task.task_id}）`, e instanceof Error ? e.message : e);
    }
  }

  const userMessage = `${task.Question}${note}`;
  const controller = new AbortController();
  const onGlobalAbort = () => controller.abort();
  opts.globalSignal.addEventListener("abort", onGlobalAbort);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs);

  const store = new SessionStore({ dir: opts.sessionsDir, sessionId: task.task_id });
  const agent = new Agent({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    maxIterations: opts.maxIterations,
    tools: opts.tools,
    sessionStore: store,
  });

  let predicted: string | null = null;
  let success = false;
  let error: string | undefined;
  let tokens = 0;
  let toolCalls = 0;
  let llmCalls = 0;

  try {
    const r = await agent.run(userMessage, { signal: controller.signal });
    predicted = r.finalAnswer;
    success = r.success;
    tokens = r.totalTokens;
    toolCalls = r.toolCallsCount;
    llmCalls = r.steps.length;
  } catch (e) {
    error = timedOut
      ? `超时（${opts.timeoutMs}ms）已取消`
      : opts.globalSignal.aborted
        ? "收到中断信号"
        : e instanceof Error
          ? `${e.name}: ${e.message}`
          : String(e);
  } finally {
    clearTimeout(timer);
    opts.globalSignal.removeEventListener("abort", onGlobalAbort);
  }

  if (!error && !success && predicted === null) {
    error = opts.globalSignal.aborted || controller.signal.aborted
      ? "被取消"
      : `maxIterations(${opts.maxIterations}) 用尽仍未给出结论`;
  }

  return {
    task,
    predicted,
    correct: !error && questionScorer(predicted ?? "", task.finalAnswer),
    success,
    ...(error ? { error } : {}),
    tokens,
    toolCalls,
    llmCalls,
    durationMs: Date.now() - started,
    sessionFile: store.filePath,
    ...(attachment ? { attachment } : {}),
  };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        await worker(items[i]!, i);
      }
    })
  );
}

// =====================================================================
// 六、汇总与报告
// =====================================================================

interface Summary {
  total: number;
  correct: number;
  accuracy: number;
  byLevel: Map<number, { total: number; correct: number }>;
  avgTokens: number;
  avgToolCalls: number;
  avgDurationMs: number;
}

function buildSummary(results: TaskRunResult[]): Summary {
  const byLevel = new Map<number, { total: number; correct: number }>();
  for (const r of results) {
    const s = byLevel.get(r.task.Level) ?? { total: 0, correct: 0 };
    s.total++;
    if (r.correct) s.correct++;
    byLevel.set(r.task.Level, s);
  }
  const correct = results.filter((r) => r.correct).length;
  const sum = (f: (r: TaskRunResult) => number) => results.reduce((acc, r) => acc + f(r), 0);
  return {
    total: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    byLevel,
    avgTokens: results.length ? sum((r) => r.tokens) / results.length : 0,
    avgToolCalls: results.length ? sum((r) => r.toolCalls) / results.length : 0,
    avgDurationMs: results.length ? sum((r) => r.durationMs) / results.length : 0,
  };
}

const clip = (s: string | null, n = 70): string => {
  const t = s ?? "(空)";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function printSummary(results: TaskRunResult[], summary: Summary, wallMs: number, outDir: string): void {
  console.log("\n================ GAIA 评测汇总 ================");
  console.log(`总题数 ${summary.total}  正确 ${summary.correct}  准确率 ${(summary.accuracy * 100).toFixed(1)}%`);
  for (const level of [...summary.byLevel.keys()].sort((a, b) => a - b)) {
    const s = summary.byLevel.get(level)!;
    console.log(`  Level ${level}: ${s.correct}/${s.total} = ${((s.correct / s.total) * 100).toFixed(1)}%`);
  }
  console.log(
    `平均: ${summary.avgTokens.toFixed(0)} tokens/题, ${summary.avgToolCalls.toFixed(2)} 次工具调用/题, ${(summary.avgDurationMs / 1000).toFixed(1)}s/题; 总耗时 ${(wallMs / 1000).toFixed(1)}s`
  );
  const failed = results.filter((r) => !r.correct);
  if (failed.length > 0) {
    console.log("失败题目:");
    for (const r of failed) {
      console.log(`  - ${r.task.task_id} (L${r.task.Level})${r.error ? ` [${r.error}]` : ""}`);
      console.log(`      期望: ${clip(r.task.finalAnswer)}`);
      console.log(`      实际: ${clip(r.predicted)}`);
    }
  }
  console.log(`结果目录: ${outDir}`);
}

function renderSummaryMd(cfg: { dataPath: string; model: string; mock: boolean }, results: TaskRunResult[], summary: Summary, wallMs: number): string {
  const lines: string[] = [
    "# GAIA 评测报告",
    "",
    `- 数据集: ${cfg.dataPath}`,
    `- 模型: ${cfg.model}${cfg.mock ? "（mock 自检）" : ""}`,
    `- 总耗时: ${(wallMs / 1000).toFixed(1)}s`,
    `- 总体: ${summary.correct}/${summary.total} = ${(summary.accuracy * 100).toFixed(1)}%`,
    `- 平均: ${summary.avgTokens.toFixed(0)} tokens/题，${summary.avgToolCalls.toFixed(2)} 次工具调用/题，${(summary.avgDurationMs / 1000).toFixed(1)}s/题`,
    "",
    "| Level | 正确/总数 | 准确率 |",
    "|---|---|---|",
  ];
  for (const level of [...summary.byLevel.keys()].sort((a, b) => a - b)) {
    const s = summary.byLevel.get(level)!;
    lines.push(`| ${level} | ${s.correct}/${s.total} | ${((s.correct / s.total) * 100).toFixed(1)}% |`);
  }
  lines.push("", "## 失败题目", "");
  const failed = results.filter((r) => !r.correct);
  if (failed.length === 0) lines.push("（无）");
  else {
    lines.push("| task_id | Level | 期望 | 实际 | 说明 |", "|---|---|---|---|---|");
    for (const r of failed) {
      const md = (s: string | null) => (s ?? "（空）").replace(/\|/g, "\\|");
      lines.push(`| ${r.task.task_id} | ${r.task.Level} | ${md(r.task.finalAnswer)} | ${md(r.predicted)} | ${r.error ?? ""} |`);
    }
  }
  return lines.join("\n") + "\n";
}

// =====================================================================
// 七、Mock 自检断言
// =====================================================================

class Checker {
  passed = 0;
  failed = 0;
  assert(condition: boolean, label: string): void {
    console.log(`${condition ? "✅" : "❌"} ${label}`);
    condition ? this.passed++ : this.failed++;
    if (!condition) process.exitCode = 1;
  }
}

async function mockSelfCheck(
  results: TaskRunResult[],
  mock: MockLlm,
  outDir: string,
  summary: Summary,
  opts: { dataDir: string; attachmentsRoot?: string | undefined }
): Promise<void> {
  console.log("\n—— Mock 自检断言 ——");
  // 已知会红的两类（与本仓库的功能改动无关，是测试台自身口径没对齐，先记在这里避免被当成回归）：
  // 1) 断言①对 mock-hard-005 要求"predicted === 脚本值"，而它的脚本值（见 MOCK_SCRIPT）**故意**带上解释句
  //    好让官方打分器判错 —— 断言与 fixture 意图矛盾，"预测 == 脚本"必然失败。
  // 2) 超时题：`agent.run` 的取消分支（src/core/agent.ts 的外部取消）是**静默返回** success:false +
  //    finalAnswer:null，不抛异常，而本文件的 error 赋值只发生在 catch 里（评测侧超时那段）；
  //    同时 HANG 假 LLM 等的是 `state.stopping`，普通超时并不置位它，于是它照样返回 "(hang placeholder)"。
  //    这两点合力造成"超时题被取消（无错误）"与"超时题会话只有 1 条"两条断言失败。
  const ck = new Checker();
  const allTasks = results.map((r) => r.task);
  const scriptOf = (r: TaskRunResult) => MOCK_SCRIPT[r.task.task_id] ?? r.task.finalAnswer;
  const nonHang = results.filter((r) => scriptOf(r) !== HANG);
  const hangResults = results.filter((r) => scriptOf(r) === HANG);

  // 1. 预测结果与脚本一致（超时题为 null）
  ck.assert(
    results.every((r) => (scriptOf(r) === HANG ? r.predicted === null : r.predicted === scriptOf(r))),
    "每题最终回答与脚本一致（超时题为空）"
  );

  // 2. 打分复演：得分数应与"用官方打分器预演脚本答案"的结果吻合
  const expectedCorrect = results.filter((r) => questionScorer(scriptOf(r), r.task.finalAnswer)).length;
  ck.assert(summary.correct === expectedCorrect, `总正确数 = 打分器预演值（${summary.correct}/${results.length}）`);
  for (const level of [...summary.byLevel.keys()].sort((a, b) => a - b)) {
    const s = summary.byLevel.get(level)!;
    const exp = results.filter((r) => r.task.Level === level && questionScorer(scriptOf(r), r.task.finalAnswer)).length;
    ck.assert(s.correct === exp, `Level ${level} 正确数 = 预演值（${s.correct}/${s.total}）`);
  }

  // 3. 工具回环：每道正常题都应经历"要工具 → 回填 → 再回答"（≥2 次 LLM 调用）
  ck.assert(
    nonHang.every((r) => (mock.callsByTask.get(r.task.task_id) ?? 0) >= 2),
    `正常题都走了工具回环（${nonHang.length} 题 ≥2 次 LLM 调用）`
  );
  ck.assert(mock.toolExecutions.count === nonHang.length, `假搜索工具恰好被调用 ${nonHang.length} 次（实际 ${mock.toolExecutions.count}）`);

  // 4. 会话隔离：本题历史含本题题面、不含其他题题面
  // （解析 JSONL 后按文本比对：真实题面含换行/引号，落盘时被 JSON 转义，原文匹配会误报）
  let isolationOk = true;
  for (const r of results) {
    const raw = await fs.readFile(r.sessionFile, "utf-8").catch(() => "");
    const texts: string[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const m = JSON.parse(t) as { content?: unknown };
        if (typeof m.content === "string") texts.push(m.content);
      } catch { /* 解析不了的行忽略，靠"缺少题面"提示兜底 */ }
    }
    if (!texts.some((t) => t.startsWith(r.task.Question))) { isolationOk = false; console.log(`   缺少本题题面: ${r.task.task_id}`); }
    for (const other of allTasks) {
      if (other.task_id !== r.task.task_id && texts.some((t) => t.includes(other.Question))) {
        isolationOk = false;
        console.log(`   ${r.task.task_id} 的历史混入了 ${other.task_id} 的题面`);
      }
    }
  }
  ck.assert(isolationOk, "每题独立 SessionStore，历史互不污染");

  // 5. 附件：本题集里带 file_path 的题都应复制成功且内容一致（过滤后无附件题则跳过）
  const withFile = allTasks.filter((t) => t.file_path);
  if (withFile.length === 0) {
    console.log("ℹ️  本次运行没有附件题，跳过附件断言");
  } else {
    let attachOk = true;
    for (const t of withFile) {
      const r = results.find((x) => x.task.task_id === t.task_id)!;
      const src = await resolveAttachment(t, opts.dataDir, opts.attachmentsRoot);
      if (src === null) {
        // 数据集本地缺附件：只要求如实标记未复制
        attachOk = attachOk && r.attachment?.copied !== true;
        continue;
      }
      attachOk = attachOk && r.attachment?.copied === true;
      // 逐字节比对源文件与复制件（附件可能是二进制，不能按文本读）
      const dest = path.join(outDir, r.attachment?.relativePath ?? "");
      const [srcBytes, destBytes] = await Promise.all([
        fs.readFile(src).catch(() => null),
        fs.readFile(dest).catch(() => null),
      ]);
      attachOk = attachOk && srcBytes !== null && destBytes !== null && Buffer.compare(srcBytes, destBytes) === 0;
      if (r.attachment?.copied) {
        const firstReq = mock.requestLog.find((q) => q.taskId === t.task_id);
        const lastMsg = firstReq?.messages[firstReq.messages.length - 1];
        attachOk = attachOk && typeof lastMsg?.content === "string" && lastMsg.content.includes(r.attachment.relativePath);
      }
    }
    ck.assert(attachOk, `附件已复制进 questions/<task_id>/ 并与源文件字节一致（${withFile.length} 题）`);
  }

  // 6. 超时链路：卡住的题被取消、记超时错误、且其会话文件只有 user 一条（写入器半场修复的下游保障）
  if (hangResults.length > 0) {
    const r = hangResults[0]!;
    ck.assert(r.error !== undefined && r.error.includes("超时"), `卡住的题被超时取消（${r.error ?? "无错误"}）`);
    const raw = await fs.readFile(r.sessionFile, "utf-8").catch(() => "");
    const lines = raw.trim() ? raw.trim().split("\n") : [];
    ck.assert(lines.length === 1, `超时题的会话文件只有 1 条（user 提问），实际 ${lines.length} 条`);
  }

  // 7. 产物落盘
  ck.assert(await exists(path.join(outDir, "results.json")), "results.json 已写出");
  ck.assert(await exists(path.join(outDir, "summary.md")), "summary.md 已写出");

  console.log(`\n自检结果: ${ck.passed} 通过, ${ck.failed} 失败`);
}

// =====================================================================
// 八、主流程
// =====================================================================

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const dataPath = cli.data ?? (cli.mock ? DEFAULT_FIXTURE : undefined);
  if (!dataPath) {
    printUsage();
    throw new Error("缺少 --data（或使用 --mock 跑自检）");
  }

  const { tasks: allTasks, dataFile, dataDir } = await loadTasksFromPath(dataPath);
  let selected = allTasks;
  if (cli.levels) selected = selected.filter((t) => cli.levels!.has(t.Level));
  if (cli.limit !== undefined) selected = selected.slice(0, cli.limit);
  if (selected.length === 0) throw new Error("过滤后没有可跑的题目");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.resolve(cli.outDir ?? path.join(import.meta.dir, "gaia-runs", stamp));
  const sessionsDir = path.join(runDir, "sessions");
  await fs.mkdir(path.join(runDir, "questions"), { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });

  const levelCounts = new Map<number, number>();
  for (const t of selected) levelCounts.set(t.Level, (levelCounts.get(t.Level) ?? 0) + 1);

  console.log("================ GAIA 评测 ================");
  console.log(`数据集: ${dataFile}`);
  console.log(`题目: ${selected.length} 题 (${[...levelCounts.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l}:${n}`).join(", ")})`);
  console.log(`模型: ${cli.model}${cli.mock ? "（mock 自检，假 LLM）" : ""}`);
  console.log(`单题超时: ${cli.timeoutMs}ms, maxIterations: ${cli.maxIterations}, 并发: ${cli.concurrency}`);
  console.log(`结果目录: ${runDir}`);

  // mock 自检先钉住打分器行为
  if (cli.mock) {
    console.log("\n—— 打分器行为钉子（SCORER_CASES）——");
    const ck = new Checker();
    for (const [gt, answer, expected] of SCORER_CASES) {
      const got = questionScorer(answer, gt);
      ck.assert(got === expected, `gt="${gt}" answer="${answer}" → ${expected}`);
    }
  }

  const globalAbort = new AbortController();
  const onSigint = () => { console.log("\n⏹️  收到中断信号，正在取消在途任务..."); globalAbort.abort(); };
  process.on("SIGINT", onSigint);

  let mock: MockLlm | undefined;
  let mcp: McpClientManager | undefined;
  // 本次评测全链路共用的工具注册表：mock/真实 search_web、MCP filesystem 工具都注册进它，
  // 经 runOneTask 显式传给 Agent——不再依赖全局单例
  const tools = new ToolRegistry();
  const results: Array<TaskRunResult | undefined> = new Array(selected.length);
  const startedAt = Date.now();

  try {
    if (cli.mock) {
      // 假 LLM：本地起一个 OpenAI 兼容端点，Agent 仍然走真实 HTTP 链路
      mock = startMockLlm(allTasks);
      registerMockSearchTool(tools, mock.toolExecutions);
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mock.port}/v1`;
      process.env.OPENAI_API_KEY = "gaia-mock-key";
      console.log(`假 LLM 已就绪: http://127.0.0.1:${mock.port}/v1`);
    } else {
      if (!process.env.OPENAI_API_KEY) throw new Error("缺少 OPENAI_API_KEY（.env 里配置真实模型凭据后再跑）");
      tools.register(createSearchWebTool()); // search_web 走真实 Tavily
      if (!process.env.TAVILY_API_KEY) console.warn("⚠️  未设置 TAVILY_API_KEY，search_web 调用将以错误结果返回");
      // 文件系统 MCP：根目录限定为本次运行目录，附件都在其 questions/ 下
      const manager = new McpClientManager(new McpAdapter({
        registry: tools,
        allowedRoots: [runDir],
        requestTimeoutMs: 120_000,
        maxResultChars: 20_000,
      }));
      try {
        await manager.addServer({
          id: "filesystem",
          transport: "stdio",
          command: "npx",
          args: ["--no-install", "@modelcontextprotocol/server-filesystem", runDir],
          roots: [runDir],
          requestTimeoutMs: 60_000,
        });
        mcp = manager;
        console.log(`文件系统 MCP 已挂载（根 ${runDir}），当前工具总数: ${tools.size}`);
      } catch (e) {
        console.warn("⚠️  文件系统 MCP 启动失败，本次不带文件工具继续:", e instanceof Error ? e.message : e);
        await manager.closeAll().catch(() => {});
      }
    }

    const systemPrompt = buildSystemPrompt(runDir);
    await runPool(selected, cli.concurrency, async (task, i) => {
      const r = await runOneTask(task, {
        model: cli.model,
        systemPrompt,
        maxIterations: cli.maxIterations,
        tools,
        timeoutMs: cli.timeoutMs,
        runDir,
        sessionsDir,
        dataDir,
        attachmentsRoot: cli.attachmentsRoot,
        globalSignal: globalAbort.signal,
      });
      results[i] = r;
      const line = `${r.correct ? "✅" : "❌"} [${i + 1}/${selected.length}] ${task.task_id} (L${task.Level}) ${(r.durationMs / 1000).toFixed(1)}s${r.error ? ` [${r.error}]` : ""}`;
      console.log(line);
      if (!r.correct) {
        console.log(`     期望: ${clip(task.finalAnswer)}`);
        console.log(`     实际: ${clip(r.predicted)}`);
      }
    });
  } finally {
    process.off("SIGINT", onSigint);
    mock?.stop();
    if (mcp) await mcp.closeAll().catch(() => {});
  }

  const filled = results.filter((r): r is TaskRunResult => r !== undefined);
  const wallMs = Date.now() - startedAt;
  const summary = buildSummary(filled);
  printSummary(filled, summary, wallMs, runDir);

  const report = {
    config: {
      dataPath: dataFile,
      model: cli.model,
      mock: cli.mock,
      levels: cli.levels ? [...cli.levels].sort((a, b) => a - b) : null,
      limit: cli.limit ?? null,
      timeoutMs: cli.timeoutMs,
      maxIterations: cli.maxIterations,
      concurrency: cli.concurrency,
      runDir,
    },
    summary: {
      total: summary.total,
      correct: summary.correct,
      accuracy: summary.accuracy,
      byLevel: Object.fromEntries([...summary.byLevel.entries()].sort((a, b) => a[0] - b[0])),
      avgTokens: summary.avgTokens,
      avgToolCalls: summary.avgToolCalls,
      avgDurationMs: summary.avgDurationMs,
    },
    tasks: filled.map((r) => ({
      task_id: r.task.task_id,
      level: r.task.Level,
      question: r.task.Question,
      expected: r.task.finalAnswer,
      predicted: r.predicted,
      correct: r.correct,
      error: r.error ?? null,
      tokens: r.tokens,
      toolCalls: r.toolCalls,
      llmCalls: r.llmCalls,
      durationMs: r.durationMs,
      sessionFile: path.relative(runDir, r.sessionFile).replace(/\\/g, "/"),
      attachment: r.attachment ?? null,
    })),
  };
  await fs.writeFile(path.join(runDir, "results.json"), JSON.stringify(report, null, 2), "utf-8");
  await fs.writeFile(
    path.join(runDir, "summary.md"),
    renderSummaryMd({ dataPath: dataFile, model: cli.model, mock: cli.mock }, filled, summary, wallMs),
    "utf-8"
  );

  if (cli.mock && mock) await mockSelfCheck(filled, mock, runDir, summary, { dataDir, attachmentsRoot: cli.attachmentsRoot });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
