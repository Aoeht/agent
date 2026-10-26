/**
 * Agent 运行轨迹分析报告
 *
 * 读取 .traces/*.jsonl 的结构化事件流，聚合出可用于归因的指标：
 * 前缀缓存命中率、单任务 token 成本分布、工具错误率、停止原因、压缩动作、
 * 以及按系统提示词指纹（promptHash）分组的行为漂移。
 *
 * 设计约束：trace 的 schema 随项目演进过（早期 run_end 没有 stopReason，
 * 早期 step 不上报 cachedPromptTokens），因此**每个指标都自带分母**，
 * 绝不用全量语料当分母去算只有部分事件才有的字段——那会得出看似精确实则错误的结论。
 *
 * 用法：
 *   bun run benchmarks/trace_report.ts                  # 输出 Markdown 到 stdout
 *   bun run benchmarks/trace_report.ts --json out.json  # 同时写机器可读报告
 *   bun run benchmarks/trace_report.ts --dir <路径>     # 指定 trace 目录
 *   bun run benchmarks/trace_report.ts --min-calls 5    # 工具错误率榜的最小调用数门槛
 */
import fs from "node:fs";
import path from "node:path";

// ---------- 事件模型（宽松解析：trace 是历史数据，字段可能缺） ----------

interface StepTokens {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
}

interface StepToolCall {
  name?: string;
  result?: string;
}

export interface TraceEvent {
  ts?: string;
  type?: string;
  userMessage?: string;
  promptHash?: string;
  step?: { iteration?: number; tokens?: StepTokens; toolCalls?: StepToolCall[] };
  success?: boolean;
  totalTokens?: number;
  toolCallsCount?: number;
  iterations?: number;
  cachedPromptTokens?: number;
  stopReason?: string;
  runStatus?: string;
  taskStatus?: string;
  errorMessage?: string;
  budgetStopped?: string;
  action?: string;
  tokens?: number;
  detail?: string;
  steps?: { content?: string; status?: string }[];
}

/** 一个 run = run_start 到下一个 run_start（或文件结束）之间的事件。 */
export interface TraceRun {
  file: string;
  /** false = 该组事件没有 run_start 打头（旧格式 trace 或文件被截断），不是崩溃 */
  hasStart: boolean;
  startedAt?: string | undefined;
  endedAt?: string | undefined;
  userMessage?: string | undefined;
  promptHash?: string | undefined;
  /** run_end 缺失 = 该 run 未正常收尾（崩溃 / 进程被杀 / 仍在运行） */
  terminated: boolean;
  success?: boolean | undefined;
  totalTokens?: number | undefined;
  toolCallsCount?: number | undefined;
  iterations?: number | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  budgetStopped?: string | undefined;
  steps: NonNullable<TraceEvent["step"]>[];
  compactions: { action: string; tokens: number; detail?: string | undefined }[];
}

export function parseTraceLines(text: string): { events: TraceEvent[]; badLines: number } {
  const events: TraceEvent[] = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") events.push(parsed as TraceEvent);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { events, badLines };
}

export function assembleRuns(file: string, events: TraceEvent[]): TraceRun[] {
  const runs: TraceRun[] = [];
  let current: TraceRun | null = null;

  for (const event of events) {
    if (event.type === "run_start") {
      current = {
        file,
        hasStart: true,
        startedAt: event.ts,
        userMessage: event.userMessage,
        promptHash: event.promptHash,
        terminated: false,
        steps: [],
        compactions: [],
      };
      runs.push(current);
      continue;
    }

    if (current === null) {
      // 孤儿事件组：没有 run_start 打头（旧格式 trace 或文件被截断）。
      // 仍要收进来，否则这些 step/compact 会被静默丢弃；但必须与
      // "有 run_start 却没有 run_end"区分开——只有后者才是崩溃/中断信号。
      current = { file, hasStart: false, terminated: false, steps: [], compactions: [] };
      runs.push(current);
    }

    switch (event.type) {
      case "step":
        if (event.step) current.steps.push(event.step);
        break;
      case "compact":
        current.compactions.push({
          action: event.action ?? "unknown",
          tokens: event.tokens ?? 0,
          detail: event.detail,
        });
        break;
      case "plan_update":
        break;
      case "run_end":
        current.terminated = true;
        current.endedAt = event.ts;
        current.success = event.success;
        current.totalTokens = event.totalTokens;
        current.toolCallsCount = event.toolCallsCount;
        current.iterations = event.iterations;
        current.stopReason = event.stopReason;
        current.errorMessage = event.errorMessage;
        current.budgetStopped = event.budgetStopped;
        current = null;
        break;
    }
  }
  return runs;
}

// ---------- 指标 ----------

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * 工具结果是 {"error": ...} 形状即视为失败。
 * 注意口径：runTool 把「工具抛异常」和「策略拒绝」都序列化成这个形状，
 * 所以这里统计的是"未成功返回"，不是纯粹的代码 bug 数。
 */
export function isToolFailure(result: string | undefined): boolean {
  if (typeof result !== "string") return false;
  try {
    const parsed = JSON.parse(result);
    return Boolean(parsed && typeof parsed === "object" && "error" in parsed);
  } catch {
    return false;
  }
}

export interface ToolStat {
  name: string;
  calls: number;
  failures: number;
  failureRate: number;
}

export interface HashGroup {
  promptHash: string;
  runs: number;
  avgTokens: number;
  avgIterations: number;
  avgToolCalls: number;
  successRate: number | null;
}

export interface TraceReport {
  generatedAt: string;
  corpus: {
    dir: string;
    files: number;
    events: number;
    badLines: number;
    /** 有 run_start 打头的 run */
    startedRuns: number;
    /** 没有 run_start 的孤儿事件组（旧格式 trace / 截断文件），不是崩溃 */
    orphanGroups: number;
    terminatedRuns: number;
    /** 有 run_start 却没有 run_end —— 真正的崩溃 / 被杀 / 仍在运行 */
    startedButUnterminated: number;
    runsWithStopReason: number;
    runsWithPromptHash: number;
    firstTs?: string | undefined;
    lastTs?: string | undefined;
  };
  prefixCache: {
    coveredSteps: number;
    totalSteps: number;
    coverage: number;
    coveredPromptTokens: number;
    coveredCachedTokens: number;
    /** 只在上报了 cachedPromptTokens 的 step 子集上计算 */
    hitRate: number | null;
  };
  tokenCost: {
    runs: number;
    total: number;
    mean: number;
    median: number;
    p95: number;
    max: number;
    promptTokens: number;
    completionTokens: number;
    promptShare: number | null;
  };
  tools: {
    distinct: number;
    calls: number;
    failures: number;
    overallFailureRate: number;
    worst: ToolStat[];
    busiest: ToolStat[];
  };
  stopReasons: { reason: string; count: number }[];
  compactions: { action: string; count: number; tokens: number }[];
  promptHashGroups: HashGroup[];
  iterations: { mean: number; median: number; p95: number; max: number; runs: number };
}

export function buildReport(dir: string, files: { name: string; text: string }[], minCalls: number): TraceReport {
  let events = 0;
  let badLines = 0;
  const allRuns: TraceRun[] = [];
  const timestamps: string[] = [];

  for (const file of files) {
    const parsed = parseTraceLines(file.text);
    events += parsed.events.length;
    badLines += parsed.badLines;
    for (const event of parsed.events) if (event.ts) timestamps.push(event.ts);
    allRuns.push(...assembleRuns(file.name, parsed.events));
  }

  timestamps.sort();

  // 前缀缓存：分母必须是"上报了该字段的 step"
  let coveredSteps = 0;
  let totalSteps = 0;
  let coveredPromptTokens = 0;
  let coveredCachedTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  const toolMap = new Map<string, { calls: number; failures: number }>();
  const stopMap = new Map<string, number>();
  const compactMap = new Map<string, { count: number; tokens: number }>();
  const hashMap = new Map<string, { runs: number; tokens: number; iters: number; tools: number; success: number; successKnown: number }>();

  const tokenSamples: number[] = [];
  const iterSamples: number[] = [];

  for (const run of allRuns) {
    for (const step of run.steps) {
      totalSteps++;
      const tk = step.tokens;
      if (!tk) continue;
      promptTokens += tk.promptTokens ?? 0;
      completionTokens += tk.completionTokens ?? 0;
      if (typeof tk.cachedPromptTokens === "number") {
        coveredSteps++;
        coveredPromptTokens += tk.promptTokens ?? 0;
        coveredCachedTokens += tk.cachedPromptTokens;
      }
      for (const call of step.toolCalls ?? []) {
        const name = call.name ?? "<unknown>";
        const rec = toolMap.get(name) ?? { calls: 0, failures: 0 };
        rec.calls++;
        if (isToolFailure(call.result)) rec.failures++;
        toolMap.set(name, rec);
      }
    }

    for (const c of run.compactions) {
      const rec = compactMap.get(c.action) ?? { count: 0, tokens: 0 };
      rec.count++;
      rec.tokens += c.tokens;
      compactMap.set(c.action, rec);
    }

    if (run.terminated) {
      if (typeof run.totalTokens === "number") tokenSamples.push(run.totalTokens);
      if (typeof run.iterations === "number") iterSamples.push(run.iterations);
      if (run.stopReason) stopMap.set(run.stopReason, (stopMap.get(run.stopReason) ?? 0) + 1);
    }

    if (run.promptHash && run.terminated) {
      const g = hashMap.get(run.promptHash) ?? { runs: 0, tokens: 0, iters: 0, tools: 0, success: 0, successKnown: 0 };
      g.runs++;
      g.tokens += run.totalTokens ?? 0;
      g.iters += run.iterations ?? 0;
      g.tools += run.toolCallsCount ?? 0;
      if (typeof run.success === "boolean") {
        g.successKnown++;
        if (run.success) g.success++;
      }
      hashMap.set(run.promptHash, g);
    }
  }

  const toolStats: ToolStat[] = [...toolMap.entries()].map(([name, v]) => ({
    name,
    calls: v.calls,
    failures: v.failures,
    failureRate: v.calls ? v.failures / v.calls : 0,
  }));
  const totalCalls = toolStats.reduce((sum, t) => sum + t.calls, 0);
  const totalFailures = toolStats.reduce((sum, t) => sum + t.failures, 0);

  const promptHashGroups: HashGroup[] = [...hashMap.entries()]
    .map(([promptHash, g]) => ({
      promptHash,
      runs: g.runs,
      avgTokens: g.runs ? Math.round(g.tokens / g.runs) : 0,
      avgIterations: g.runs ? g.iters / g.runs : 0,
      avgToolCalls: g.runs ? g.tools / g.runs : 0,
      successRate: g.successKnown ? g.success / g.successKnown : null,
    }))
    .sort((a, b) => b.runs - a.runs || b.avgTokens - a.avgTokens);

  const terminatedRuns = allRuns.filter((r) => r.terminated).length;
  const startedRuns = allRuns.filter((r) => r.hasStart).length;

  return {
    generatedAt: new Date().toISOString(),
    corpus: {
      dir,
      files: files.length,
      events,
      badLines,
      startedRuns,
      orphanGroups: allRuns.length - startedRuns,
      terminatedRuns,
      startedButUnterminated: allRuns.filter((r) => r.hasStart && !r.terminated).length,
      runsWithStopReason: allRuns.filter((r) => r.stopReason).length,
      runsWithPromptHash: allRuns.filter((r) => r.promptHash).length,
      firstTs: timestamps[0],
      lastTs: timestamps[timestamps.length - 1],
    },
    prefixCache: {
      coveredSteps,
      totalSteps,
      coverage: totalSteps ? coveredSteps / totalSteps : 0,
      coveredPromptTokens,
      coveredCachedTokens,
      hitRate: coveredPromptTokens ? coveredCachedTokens / coveredPromptTokens : null,
    },
    tokenCost: {
      runs: tokenSamples.length,
      total: tokenSamples.reduce((a, b) => a + b, 0),
      mean: tokenSamples.length ? Math.round(tokenSamples.reduce((a, b) => a + b, 0) / tokenSamples.length) : 0,
      median: Math.round(percentile(tokenSamples, 50)),
      p95: Math.round(percentile(tokenSamples, 95)),
      max: tokenSamples.length ? Math.max(...tokenSamples) : 0,
      promptTokens,
      completionTokens,
      promptShare: promptTokens + completionTokens ? promptTokens / (promptTokens + completionTokens) : null,
    },
    tools: {
      distinct: toolStats.length,
      calls: totalCalls,
      failures: totalFailures,
      overallFailureRate: totalCalls ? totalFailures / totalCalls : 0,
      worst: toolStats
        .filter((t) => t.calls >= minCalls)
        .sort((a, b) => b.failureRate - a.failureRate || b.calls - a.calls)
        .slice(0, 10),
      busiest: [...toolStats].sort((a, b) => b.calls - a.calls).slice(0, 10),
    },
    stopReasons: [...stopMap.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    compactions: [...compactMap.entries()]
      .map(([action, v]) => ({ action, count: v.count, tokens: v.tokens }))
      .sort((a, b) => b.count - a.count),
    promptHashGroups,
    iterations: {
      runs: iterSamples.length,
      mean: iterSamples.length ? iterSamples.reduce((a, b) => a + b, 0) / iterSamples.length : 0,
      median: percentile(iterSamples, 50),
      p95: percentile(iterSamples, 95),
      max: iterSamples.length ? Math.max(...iterSamples) : 0,
    },
  };
}

// ---------- 渲染 ----------

const pct = (v: number | null, digits = 1) => (v === null ? "n/a" : `${(v * 100).toFixed(digits)}%`);
const num = (v: number) => v.toLocaleString("en-US");

export function renderMarkdown(r: TraceReport): string {
  const L: string[] = [];
  L.push("# Agent 运行轨迹分析报告");
  L.push("");
  L.push(`- 生成时间：${r.generatedAt}`);
  L.push(`- trace 目录：\`${r.corpus.dir}\``);
  if (r.corpus.firstTs && r.corpus.lastTs) L.push(`- 时间跨度：${r.corpus.firstTs.slice(0, 10)} → ${r.corpus.lastTs.slice(0, 10)}`);
  L.push("");

  L.push("## 1. 语料与 schema 覆盖");
  L.push("");
  L.push("| 项 | 值 |");
  L.push("|---|---:|");
  L.push(`| trace 文件 | ${r.corpus.files} |`);
  L.push(`| 事件总数 | ${num(r.corpus.events)} |`);
  L.push(`| 解析失败行 | ${r.corpus.badLines} |`);
  L.push(`| 有 run_start 的 run | ${r.corpus.startedRuns} |`);
  L.push(`| 正常收尾（有 run_end） | ${r.corpus.terminatedRuns} |`);
  L.push(`| **started 但未收尾**（崩溃/被杀/仍在跑） | ${r.corpus.startedButUnterminated} |`);
  L.push(`| 孤儿事件组（无 run_start，旧格式/截断） | ${r.corpus.orphanGroups} |`);
  L.push(`| 带 stopReason 的 run | ${r.corpus.runsWithStopReason} |`);
  L.push(`| 带 promptHash 的 run | ${r.corpus.runsWithPromptHash} |`);
  L.push("");
  L.push("> 「孤儿事件组」是没有 `run_start` 打头的事件序列（早期 trace 格式或文件被截断），");
  L.push("> 它们仍参与 step / 工具 / 压缩统计，但**不计入未收尾**——只有 started 却没有 run_end 才是中断信号。");
  L.push("");
  L.push("> trace schema 随项目演进过：早期 `run_end` 不含 `stopReason`，早期 `step` 不上报 `cachedPromptTokens`。");
  L.push("> 下列每个指标都只在自己的覆盖子集上计算，分母已显式标注，不要跨指标直接比较。");
  L.push("");

  L.push("## 2. 前缀缓存命中");
  L.push("");
  const c = r.prefixCache;
  L.push(`覆盖：${c.coveredSteps} / ${c.totalSteps} 个 step（${pct(c.coverage)}）上报了 \`cachedPromptTokens\`。`);
  L.push("");
  if (c.hitRate === null) {
    L.push("**无可计算样本**：没有任何 step 上报缓存字段。");
  } else {
    L.push("| 指标 | 值 |");
    L.push("|---|---:|");
    L.push(`| 覆盖子集 prompt token | ${num(c.coveredPromptTokens)} |`);
    L.push(`| 其中命中缓存 | ${num(c.coveredCachedTokens)} |`);
    L.push(`| **命中率（仅覆盖子集）** | **${pct(c.hitRate, 2)}** |`);
    L.push("");
    L.push(`> 命中率的分母是**上报了缓存字段的 ${c.coveredSteps} 个 step**，不是全部 ${c.totalSteps} 个。`);
    L.push(`> 覆盖率仅 ${pct(c.coverage)}，样本偏小，结论用于观测趋势而非精确核算。`);
  }
  L.push("");

  L.push("## 3. 单任务 token 成本");
  L.push("");
  const t = r.tokenCost;
  L.push(`样本：${t.runs} 个正常收尾且带 totalTokens 的 run。`);
  L.push("");
  L.push("| 指标 | token |");
  L.push("|---|---:|");
  L.push(`| 合计 | ${num(t.total)} |`);
  L.push(`| 均值 | ${num(t.mean)} |`);
  L.push(`| 中位数 | ${num(t.median)} |`);
  L.push(`| p95 | ${num(t.p95)} |`);
  L.push(`| 最大 | ${num(t.max)} |`);
  L.push("");
  L.push(`逐 step 累计：prompt ${num(t.promptTokens)} / completion ${num(t.completionTokens)}` +
    (t.promptShare === null ? "" : `，prompt 占 ${pct(t.promptShare)}。`));
  L.push("");
  L.push(`> 均值 ${num(t.mean)} 与中位数 ${num(t.median)} 差距${t.mean > t.median * 2 ? "显著" : "有限"}，` +
    `说明成本分布${t.mean > t.median * 2 ? "长尾明显，少数重任务拉高均值——预算配置应看 p95 而非均值" : "相对集中"}。`);
  L.push("");

  L.push("## 4. 迭代次数分布");
  L.push("");
  const it = r.iterations;
  L.push(`样本 ${it.runs} 个 run：均值 ${it.mean.toFixed(1)}，中位数 ${it.median}，p95 ${it.p95}，最大 ${it.max}。`);
  L.push("");

  L.push("## 5. 工具可靠性");
  L.push("");
  L.push(`${r.tools.distinct} 个工具，共 ${num(r.tools.calls)} 次调用，${r.tools.failures} 次未成功返回（${pct(r.tools.overallFailureRate)}）。`);
  L.push("");
  L.push("> 口径：结果为 `{\"error\": ...}` 形状即计入。`runTool` 把工具异常与策略拒绝都序列化成该形状，");
  L.push("> 因此这是「未成功返回率」，不等于代码缺陷数——策略拒绝属于预期的安全行为。");
  L.push("");
  L.push("### 未成功返回率最高");
  L.push("");
  L.push("| 工具 | 调用 | 失败 | 失败率 |");
  L.push("|---|---:|---:|---:|");
  for (const s of r.tools.worst) L.push(`| \`${s.name}\` | ${s.calls} | ${s.failures} | ${pct(s.failureRate)} |`);
  L.push("");
  L.push("### 调用量最高");
  L.push("");
  L.push("| 工具 | 调用 | 失败 | 失败率 |");
  L.push("|---|---:|---:|---:|");
  for (const s of r.tools.busiest) L.push(`| \`${s.name}\` | ${s.calls} | ${s.failures} | ${pct(s.failureRate)} |`);
  L.push("");

  L.push("## 6. 停止原因");
  L.push("");
  if (!r.stopReasons.length) {
    L.push("无样本（没有 run_end 带 stopReason）。");
  } else {
    const total = r.stopReasons.reduce((a, b) => a + b.count, 0);
    L.push(`样本：${total} 个带 stopReason 的 run（占 ${r.corpus.terminatedRuns} 个正常收尾 run 的 ${pct(r.corpus.terminatedRuns ? total / r.corpus.terminatedRuns : null)}）。`);
    L.push("");
    L.push("| 停止原因 | 次数 | 占比 |");
    L.push("|---|---:|---:|");
    for (const s of r.stopReasons) L.push(`| \`${s.reason}\` | ${s.count} | ${pct(s.count / total)} |`);
    L.push("");
    const abnormal = r.stopReasons.filter((s) => !["answer", "verified_answer"].includes(s.reason));
    if (abnormal.length) {
      const n = abnormal.reduce((a, b) => a + b.count, 0);
      L.push(`> 非正常收尾 ${n} / ${total}（${pct(n / total)}）：${abnormal.map((s) => `\`${s.reason}\`×${s.count}`).join("、")}。`);
    }
  }
  L.push("");

  L.push("## 7. 上下文压缩动作");
  L.push("");
  if (!r.compactions.length) {
    L.push("无记录。");
  } else {
    L.push("| 动作 | 次数 | 节省/涉及 token |");
    L.push("|---|---:|---:|");
    for (const s of r.compactions) L.push(`| \`${s.action}\` | ${s.count} | ${num(s.tokens)} |`);
    L.push("");
    const failed = r.compactions.find((s) => s.action === "summary_failed" || s.action === "memory_failed");
    if (failed) L.push(`> ⚠️ 出现 ${failed.count} 次 \`${failed.action}\`，摘要/记忆链路曾降级，值得回查对应时间点的 trace。`);
  }
  L.push("");

  L.push("## 8. 提示词指纹与行为漂移");
  L.push("");
  if (!r.promptHashGroups.length) {
    L.push("无样本（没有 run 同时带 promptHash 与 run_end）。");
  } else {
    L.push(`共 ${r.promptHashGroups.length} 个不同的系统提示词指纹。同一指纹内提示词逐字节相同，`);
    L.push(`因此跨指纹的均值差异可归因于"提示词改版 + 任务构成变化"，而不是随机波动。`);
    L.push("");
    L.push("| promptHash | run 数 | 平均 token | 平均迭代 | 平均工具调用 | 成功率 |");
    L.push("|---|---:|---:|---:|---:|---:|");
    for (const g of r.promptHashGroups) {
      L.push(`| \`${g.promptHash}\` | ${g.runs} | ${num(g.avgTokens)} | ${g.avgIterations.toFixed(1)} | ${g.avgToolCalls.toFixed(1)} | ${pct(g.successRate, 0)} |`);
    }
    L.push("");
    const withTokens = r.promptHashGroups.filter((g) => g.runs >= 2);
    if (withTokens.length >= 2) {
      const lo = withTokens.reduce((a, b) => (a.avgTokens < b.avgTokens ? a : b));
      const hi = withTokens.reduce((a, b) => (a.avgTokens > b.avgTokens ? a : b));
      L.push(`> 平均 token 跨度：\`${lo.promptHash}\` ${num(lo.avgTokens)} → \`${hi.promptHash}\` ${num(hi.avgTokens)}` +
        `（${(hi.avgTokens / Math.max(1, lo.avgTokens)).toFixed(0)}×）。`);
      L.push(`> ⚠️ 该跨度混合了两个变量：提示词改版本身，以及不同时期任务复杂度不同。`);
      L.push(`> 指纹只解决"能不能归因到某一版规则"，不能单独证明改版导致成本变化——要下这个结论需要固定任务集做 A/B。`);
    }
  }
  L.push("");

  return L.join("\n");
}

// ---------- CLI ----------

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const dir = path.resolve(argValue(args, "--dir") ?? ".traces");
  const jsonOut = argValue(args, "--json");
  const minCalls = Number(argValue(args, "--min-calls") ?? "5");

  if (!fs.existsSync(dir)) {
    console.error(`trace 目录不存在：${dir}`);
    process.exit(1);
  }
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  if (!names.length) {
    console.error(`目录下没有 .jsonl 文件：${dir}`);
    process.exit(1);
  }
  const files = names.map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8") }));

  const report = buildReport(dir, files, Number.isFinite(minCalls) ? minCalls : 5);
  console.log(renderMarkdown(report));

  if (jsonOut) {
    const target = path.resolve(jsonOut);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(report, null, 2), "utf8");
    console.error(`\n已写入 ${target}`);
  }
}

if (import.meta.main) main();
