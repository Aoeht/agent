// tests/scanner_eval.test.ts
// scanner 评测：报告解析边界、打分口径（手工可算的固定对照集）、live 管道接线（假 client 走真实 delegate 白名单）。
// 运行: bun test tests/scanner_eval.test.ts
import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runScannerEval, parseScannerReport, normalizeLevel, pairOutcome, createLiveScanPredictor, loadLabels } from "../benchmarks/scanner_eval";
import { cannedCases, cannedReports, cannedExpected } from "../benchmarks/scanner/fixtures";
import { PlanStore } from "../src/core/plan_store";
import { defineTool } from "../src/core/types";
import { createScannerRegistry } from "../src/team_runtime";

describe("报告解析与归一", () => {
  test("无 JSON、坏 JSON、空文本都返回 null 而不抛错", () => {
    expect(parseScannerReport("")).toBeNull();
    expect(parseScannerReport("只有文字结论，没有代码块。")).toBeNull();
    expect(parseScannerReport("```json\n{坏掉的 json\n```")).toBeNull();
  });

  test("取最后一个 json 围栏块；忘写围栏时用 risk_level 锚点做括号配平兜底", () => {
    const lastWins = parseScannerReport([
      "先给一个作废的草稿：```json\n{\"bvid\":\"BV1\",\"risk_level\":\"low\"}\n```",
      "修正后的最终报告：```json\n{\"bvid\":\"BV2\",\"risk_level\":\"high\"}\n```",
    ].join("\n"));
    expect(lastWins?.bvid).toBe("BV2");
    expect(lastWins?.risk_level).toBe("high");

    const bare = parseScannerReport('结论如下： {"bvid":"BV3","risk_level":"medium","video":{"risk_level":"low"}} 补充说明。');
    expect(bare?.risk_level).toBe("medium");
    expect(bare?.video.risk_level).toBe("low");
  });

  test("字符串里的花括号不干扰配平；维度缺失记 unknown；中文标签归一", () => {
    const withBraces = parseScannerReport('{"summary":"正文含 } 与 { 的文本","risk_level":"low"}');
    expect(withBraces?.risk_level).toBe("low");

    const partial = parseScannerReport('{"bvid":"BV4","risk_level":"high","comments":{"risk_level":"无法判断"}}');
    expect(partial?.video.risk_level).toBe("unknown");
    expect(partial?.comments.risk_level).toBe("unknown");

    expect(normalizeLevel("高风险")).toBe("high");
    expect(normalizeLevel(" 正常 ")).toBe("clean");
    expect(normalizeLevel("存疑")).toBe("medium");
    expect(normalizeLevel("LOW")).toBe("low");
    expect(normalizeLevel("无法判断")).toBe("unknown");
    expect(normalizeLevel("天马行空")).toBe("unknown");
    expect(normalizeLevel(42)).toBe("unknown");
  });
});

describe("打分口径（固定对照集，数字手工推演）", () => {
  test("pairOutcome 四象限与弃权映射", () => {
    expect(pairOutcome("high", "medium")).toBe("tp");
    expect(pairOutcome("medium", "high")).toBe("tp");
    expect(pairOutcome("clean", "high")).toBe("fp");
    expect(pairOutcome("low", "medium")).toBe("fp");
    expect(pairOutcome("clean", "low")).toBe("tn");
    expect(pairOutcome("low", "clean")).toBe("tn");
    expect(pairOutcome("high", "low")).toBe("fn");
    expect(pairOutcome("medium", "unknown")).toBe("abstain");
    expect(pairOutcome("unknown", "unknown")).toBe("correct-abstain");
    expect(pairOutcome("unknown", "clean")).toBe("gold-unknown-predicted");
  });

  test("canned 集聚合值与 fixtures 注释的推演一致", async () => {
    const report = await runScannerEval(cannedCases, async (c) => ({ raw: cannedReports[c.id] ?? "" }), { mode: "canned" });

    expect(report.totalCases).toBe(6);
    expect(report.reportMissing).toBe(1);
    expect(report.micro.tp).toBe(cannedExpected.counts.tp);
    expect(report.micro.fp).toBe(cannedExpected.counts.fp);
    expect(report.micro.tn).toBe(cannedExpected.counts.tn);
    expect(report.micro.fn).toBe(cannedExpected.counts.fn);
    expect(report.micro.abstain).toBe(cannedExpected.counts.abstain);
    expect(report.micro.goldUnknownPredicted).toBe(cannedExpected.counts.goldUnknownPredicted);
    expect(report.micro.correctAbstain).toBe(cannedExpected.counts.correctAbstain);
    expect(report.micro.precision).toBeCloseTo(cannedExpected.micro.precision, 10);
    expect(report.micro.recall).toBeCloseTo(cannedExpected.micro.recall, 10);
    expect(report.micro.f1).toBeCloseTo(cannedExpected.micro.f1, 10);
    expect(report.micro.abstainRate).toBeCloseTo(cannedExpected.micro.abstainRate, 10);
    expect(report.micro.exactMatchRate).toBeCloseTo(cannedExpected.micro.exactMatchRate, 10);
    expect(report.micro.mae).toBeCloseTo(cannedExpected.micro.mae, 10);

    expect(report.dimensions.overall!.tp).toBe(3);
    expect(report.dimensions.overall!.tn).toBe(2);
    expect(report.dimensions.overall!.abstain).toBe(1);
    expect(report.dimensions.overall!.precision).toBeCloseTo(cannedExpected.overall.precision, 10);
    expect(report.dimensions.overall!.abstainRate).toBeCloseTo(cannedExpected.overall.abstainRate, 10);
    expect(report.dimensions.overall!.exactMatchRate).toBeCloseTo(cannedExpected.overall.exactMatchRate, 10);
    expect(report.dimensions.overall!.mae).toBeCloseTo(cannedExpected.overall.mae, 10);

    // 分类别：引流诈骗漏报一条（B.comments）→ R=3/4；解析失败类全部弃权 → P/R 为 null
    const fraud = report.perCategory.find(row => row.category === "引流诈骗")!;
    expect(fraud.precision).toBeCloseTo(1, 10);
    expect(fraud.recall).toBeCloseTo(0.75, 10);
    const failed = report.perCategory.find(row => row.category === "解析失败")!;
    expect(failed.precision).toBeNull();
    expect(failed.recall).toBeNull();
  });

  test("报告缺失的用例整例弃权，不算误报也不算漏报", async () => {
    const missing = cannedCases.find(c => c.id === "BVNULL006")!;
    const report = await runScannerEval([missing], async () => ({ raw: "没有任何 JSON" }), { mode: "canned" });
    for (const dimension of ["video", "author", "comments", "overall"] as const) {
      expect(report.dimensions[dimension]!.abstain).toBe(1);
      expect(report.dimensions[dimension]!.precision).toBeNull();
      expect(report.dimensions[dimension]!.recall).toBeNull();
    }
  });
});

describe("标注文件加载", () => {
  test("中文标签归一；缺 id / 缺 gold 报错；缺 category 记未分类", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scanner-labels-"));
    const file = path.join(dir, "labels.json");
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      cases: [
        { id: "BV1", category: "引流诈骗", gold: { video: "高风险", author: "正常", comments: "low", overall: "high" } },
        { id: "BV2", gold: { video: "clean", author: "clean", comments: "clean", overall: "clean" }, notes: "n" },
      ],
    }));
    const labels = await loadLabels(file);
    expect(labels[0]!.gold.video).toBe("high");
    expect(labels[0]!.gold.author).toBe("clean");
    expect(labels[1]!.category).toBe("未分类");
    expect(labels[1]!.notes).toBe("n");
    await fs.writeFile(file, JSON.stringify({ version: 1, cases: [{ category: "x", gold: {} }] }));
    expect(loadLabels(file)).rejects.toThrow("缺少 id");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("live 管道接线（假 client 走真实 delegate 白名单与发现库）", () => {
  test("scanner 子代理跑完：报告落盘、发现库隔离落盘、三维度 dedupe_key 齐全", async () => {
    const bvid = "BVWFIX000001";
    const reportJson = '{"bvid":"' + bvid + '","risk_level":"medium","confidence":0.6,' +
      '"video":{"risk_level":"medium"},"author":{"risk_level":"clean"},"comments":{"risk_level":"无法判断"},"links":[],"unresolved":[]}';
    const steps = [
      { toolCalls: [{ name: "bili_collect", arguments: JSON.stringify({ bvid }) }] },
      {
        toolCalls: [{
          name: "ingest_findings",
          arguments: JSON.stringify({
            subject: bvid,
            source: "scan_video",
            findings: [
              { summary: "视频维度：命中夸大收益话术", verdict: "medium", dedupe_key: `${bvid}:video` },
              { summary: "作者维度：无风险信号", verdict: "clean", dedupe_key: `${bvid}:author` },
              { summary: "评论维度：数据缺失", verdict: "无法判断", dedupe_key: `${bvid}:comments` },
            ],
          }),
        }],
      },
      { content: "综合判断中风险。\n```json\n" + reportJson + "\n```" },
    ];
    const requests: any[] = [];
    const client: any = {
      chat: {
        completions: {
          create: async (params: any) => {
            requests.push(params);
            const step = steps[requests.length - 1]!;
            if (!step) throw new Error(`意外的第 ${requests.length} 次模型请求`);
            return {
              choices: [{
                message: {
                  ...(step.content !== undefined ? { content: step.content } : { content: null }),
                  ...(step.toolCalls
                    ? { tool_calls: step.toolCalls.map((tc, index) => ({ id: `call_${index}`, type: "function", function: { name: tc.name, arguments: tc.arguments } })) }
                    : {}),
                },
                finish_reason: step.toolCalls ? "tool_calls" : "stop",
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          },
        },
      },
    };

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scanner-live-"));
    const workDir = path.join(root, "work");
    const datasetDir = path.join(root, "dataset");
    await fs.mkdir(datasetDir, { recursive: true });
    const fakeBiliCollect = defineTool({
      name: "bili_collect",
      description: "假证据预处理：返回合成证据",
      schema: z.object({ bvid: z.string() }),
      parallelSafe: true,
      execute: async () => JSON.stringify({ bvid, risk_windows: [], flagged_comments: [], links: [], notes: ["合成证据，无真实数据"] }),
    });
    const fakeRagSearch = defineTool({
      name: "rag_search",
      description: "假知识库检索：无命中",
      schema: z.object({ query: z.string() }),
      parallelSafe: true,
      execute: async () => "无命中",
    });

    const predictor = createLiveScanPredictor({
      datasetDir, workDir, model: "m",
      client,
      budget: { maxTotalTokens: 100_000, maxToolCalls: 10, maxWallClockMs: 30_000 },
      tools: { biliCollect: fakeBiliCollect, ragSearch: fakeRagSearch },
    });

    // 白名单接线正确：scanner 注册表里有领域四件套 + 计划工具，没有写类/委派工具
    const scannerRegistry = createScannerRegistry(predictor.registry, new PlanStore());
    for (const name of ["bili_collect", "inspect_link", "rag_search", "ingest_findings", "update_plan"]) {
      expect(scannerRegistry.get(name)).toBeDefined();
    }
    expect(scannerRegistry.get("run_script")).toBeUndefined();

    const outcome = await predictor({ id: bvid, category: "接线测试", gold: { video: "medium", author: "clean", comments: "unknown", overall: "medium" } });

    // 回执经围栏回注，解析出的报告与子代理输出一致
    expect(outcome.raw).toContain("委派完成：scanner");
    expect(outcome.raw).toContain("UNTRUSTED_MCP_DATA");
    expect(outcome.report?.risk_level).toBe("medium");
    expect(outcome.report?.video.risk_level).toBe("medium");
    expect(outcome.report?.author.risk_level).toBe("clean");
    expect(outcome.report?.comments.risk_level).toBe("unknown");

    // 报告与原始回执落盘，replay 模式可复算
    const persisted = JSON.parse(await fs.readFile(path.join(workDir, "reports", `${bvid}.json`), "utf-8"));
    expect(persisted.risk_level).toBe("medium");
    expect(await fs.readFile(path.join(workDir, "raw", `${bvid}.txt`), "utf-8")).toContain("risk_level");

    // 发现库落在评测工作目录（不碰真实 .agent-data），三条 dedupe_key 与 source/subject 契约一致
    const findings = (await fs.readFile(path.join(workDir, "findings.jsonl"), "utf-8")).trim().split("\n").map(line => JSON.parse(line));
    expect(findings).toHaveLength(3);
    expect(new Set(findings.map((f: any) => f.dedupe_key))).toEqual(new Set([`${bvid}:video`, `${bvid}:author`, `${bvid}:comments`]));
    for (const finding of findings) {
      expect(finding.source).toBe("scan_video");
      expect(finding.subject).toBe(bvid);
    }

    // 子代理跑在 scanner 系统提示词下
    const childSystem = requests[0]!.messages[0].content as string;
    expect(childSystem).toContain("诈骗风险扫描");
    expect(childSystem).toContain("采证≠终判");

    await fs.rm(root, { recursive: true, force: true });
  });
});
