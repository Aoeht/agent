// benchmarks/trace_view.ts
/**
 * 单条委派轨迹的人读查看器：把一个 delegate-*.jsonl 按轮次打印。
 * 每轮（step）= 一次 LLM 调用：模型文本输出、工具调用参数与结果、token 用量；
 * 工具耗时/成败来自 tool_start/tool_end 事件（按 callId 关联）；结尾输出 run_end 汇总。
 *
 * 用法：
 *   bun run benchmarks/trace_view.ts <delegate-xxx.jsonl>            # 直接给文件
 *   bun run benchmarks/trace_view.ts <BV号|关键字> [--dir <目录>]     # 在目录里找最新的匹配轨迹
 *   bun run benchmarks/trace_view.ts <文件> --full                    # 不截断工具结果
 *   bun run benchmarks/trace_view.ts <文件> --max 1200                # 自定义截断长度（默认 400 字）
 *
 * trace 的 schema 随项目演进过：缺失字段一律降级显示，不抛错。
 */
import fs from "node:fs/promises";
import path from "node:path";

interface TraceEvent {
  ts?: string;
  type?: string;
  userMessage?: string;
  promptHash?: string;
  step?: {
    iteration?: number;
    tokens?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedPromptTokens?: number };
    llmContent?: string;
    finishReason?: string;
    refusal?: string | null;
    toolCalls?: Array<{ id?: string; name?: string; arguments?: string; result?: unknown }>;
  };
  callId?: string;
  name?: string;
  arguments?: string;
  durationMs?: number;
  ok?: boolean;
  steps?: unknown[];
  success?: boolean;
  runStatus?: string;
  taskStatus?: string;
  stopReason?: string;
  totalTokens?: number;
  cachedPromptTokens?: number;
  toolCallsCount?: number;
  iterations?: number;
  task?: { goal?: string };
}

function parseArgs(argv: string[]) {
  const options = { target: "", dir: "", full: false, max: 400 };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--full") options.full = true;
    else if (arg === "--dir") options.dir = argv[++i] ?? "";
    else if (arg === "--max") {
      const value = Number(argv[++i]);
      if (Number.isSafeInteger(value) && value > 0) options.max = value;
    } else positional.push(arg);
  }
  options.target = positional[0] ?? "";
  return options;
}

async function resolveTraceFile(target: string, dir: string): Promise<string> {
  // 直接给文件/目录：优先按路径解析（目录取最新的 .jsonl）
  try {
    const stat = await fs.stat(target);
    if (stat.isFile()) return path.resolve(target);
    if (stat.isDirectory()) {
      const newest = (await fs.readdir(target))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .pop();
      if (newest) return path.resolve(target, newest);
      throw new Error(`目录里没有 .jsonl 轨迹：${target}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("目录里没有")) throw error;
    /* 不是路径，按关键字搜索 */
  }
  const searchDir = path.resolve(dir || ".agent-sessions/delegates");
  const files = (await fs.readdir(searchDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(searchDir, f))
    .sort();
  // 从新到旧找文件名或内容命中关键字的轨迹
  for (const file of files.reverse()) {
    if (path.basename(file).includes(target)) return file;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (text.includes(target)) return file;
  }
  throw new Error(`没找到匹配 ${target} 的轨迹（目录：${searchDir}）`);
}

function clip(text: string, max: number, full: boolean): string {
  const t = text.trim();
  if (full || t.length <= max) return t;
  return `${t.slice(0, max)}…（省略 ${t.length - max} 字）`;
}

type StepTokens = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
};

function formatTokens(tokens: StepTokens | undefined): string {
  if (!tokens) return "";
  const total = tokens.totalTokens ?? 0;
  const cached = tokens.cachedPromptTokens ?? 0;
  return `${total.toLocaleString()} tokens${cached ? `（缓存 ${cached.toLocaleString()}）` : ""}`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.target) {
  console.error("用法：bun run benchmarks/trace_view.ts <文件|BV号|关键字> [--dir 目录] [--full] [--max N]");
  process.exit(1);
}
const file = await resolveTraceFile(args.target, args.dir);
const raw = await fs.readFile(file, "utf8");
const events: TraceEvent[] = [];
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch { /* 半截行跳过 */ }
}

// callId → 工具耗时/成败（tool_start/end 单独事件）
const toolMeta = new Map<string, { durationMs?: number; ok?: boolean }>();
for (const e of events) {
  if (e.type === "tool_start" && e.callId) toolMeta.set(e.callId, {});
  if (e.type === "tool_end" && e.callId) {
    toolMeta.set(e.callId, {
      ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
      ...(e.ok === undefined ? {} : { ok: e.ok }),
    });
  }
}

const out: string[] = [];
const start = events.find((e) => e.type === "run_start");
const end = events.find((e) => e.type === "run_end");
out.push(`══ 轨迹：${path.relative(process.cwd(), file)} ══`);
if (start) {
  out.push(`开始：${start.ts ?? "?"}  promptHash=${start.promptHash ?? "?"}`);
  out.push(`任务：${(start.userMessage ?? "").replace(/\n/g, " ").slice(0, 500)}`);
}

for (const e of events) {
  if (e.type === "plan_update" && Array.isArray(e.steps) && e.steps.length) {
    out.push(`\n── 计划更新 ──`);
    for (const step of e.steps as Array<Record<string, unknown>>) {
      const desc = (step.description ?? step.title ?? step.text ?? JSON.stringify(step)) as string;
      out.push(`   [${String(step.status ?? "?")}] ${desc}`);
    }
    continue;
  }
  if (e.type !== "step" || !e.step) continue;
  const s = e.step;
  const header = `\n── 轮 ${s.iteration ?? "?"} · ${formatTokens(s.tokens)} · ${s.finishReason ?? "?"}` +
    (s.refusal ? " · 拒答" : "");
  out.push(header);
  if (s.llmContent?.trim()) out.push(`  模型：${clip(s.llmContent, args.max, args.full).replace(/\n/g, "\n         ")}`);
  for (const call of s.toolCalls ?? []) {
    const meta = call.id ? toolMeta.get(call.id) : undefined;
    const timing = meta?.durationMs !== undefined ? ` (${meta.durationMs}ms${meta.ok === false ? " 失败" : ""})` : "";
    out.push(`  → ${call.name ?? "?"} ${clip(call.arguments ?? "{}", 300, true)}${timing}`);
    if (call.result !== undefined) {
      const resultText = typeof call.result === "string" ? call.result : JSON.stringify(call.result);
      out.push(`    结果：${clip(resultText ?? "", args.max, args.full).replace(/\n/g, "\n          ")}`);
    }
  }
}

if (end) {
  out.push(
    `\n══ 结束：${end.taskStatus ?? end.runStatus ?? "?"} · 停止原因 ${end.stopReason ?? "?"} · ` +
    `工具 ${end.toolCallsCount ?? "?"} 次 · ${(end.totalTokens ?? 0).toLocaleString()} tokens` +
    `${end.cachedPromptTokens ? `（缓存 ${end.cachedPromptTokens.toLocaleString()}）` : ""} · 轮数 ${end.iterations ?? "?"} ══`,
  );
}
console.log(out.join("\n"));