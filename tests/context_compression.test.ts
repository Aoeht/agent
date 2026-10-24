// tests/context_compression.test.ts
// 上下文压缩链路的单元与集成测试：
//   - 工具结果截断/落盘（tool_outputs）
//   - ContextManager 降级阶梯：原样 → 占位符 → 丢旧工具组 → 滚动摘要；摘要失败的降级；钉住前缀
//   - SessionStore 的【长期摘要】元记录（落盘、读取、compact 保留）
//   - Agent 集成：run 结束 fold 长期摘要（含工具观察）、下个 run 注入为钉住前缀
// 运行: bun test ./tests/context_compression.test.ts
import { test, expect, describe } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { ContextManager } from "../src/core/context_manager";
import { SessionStore } from "../src/core/session_store";
import { Agent } from "../src/core/agent";
import { ToolRegistry } from "../src/core/registry";
import { defineTool } from "../src/core/types";
import { processToolOutput } from "../src/core/tool_outputs";
import { renderCitationBlock } from "../src/core/citations";
import type { Message } from "../src/core/types";
import type { CompactEvent } from "../src/core/events";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

/** 摘要类调用的固定应答（8 节里给一节就够断言用） */
const SUMMARY_REPLY = "## 任务与目标\n测试摘要内容";

function makeSummaryClient(reply = SUMMARY_REPLY, options: { failSummary?: boolean } = {}): {
  client: any;
  summaryCalls: any[];
} {
  const summaryCalls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: any) => {
          if (!params.tools) {
            summaryCalls.push(params);
            if (options.failSummary) throw new Error("summary endpoint down");
            return {
              choices: [{ message: { content: reply } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          return {
            choices: [{ message: { content: "好的" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };
  return { client, summaryCalls };
}

function rolesOf(messages: Message[]): string[] {
  return messages.map((m) => m.role);
}

function textOf(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => ("text" in p ? p.text : "")).join("");
  return "";
}

function toolCallMessage(id: string): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "search", arguments: '{"q":"测试"}' } }],
  };
}

/** 内容有变化的文本：重复的中文短语会被 o200k 词表压得很小，没法稳定撑起 token 量 */
function longText(prefix: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `${prefix}第${i}行：不同的内容片段 ${i * 7} 与补充说明${i}。`).join(
    ""
  );
}

/** 典型越界场景：一组长对话 + 两个工具组（旧的输出巨大，最新的很小） */
function overloadedMessages(): Message[] {
  return [
    { role: "system", content: "系统规则" },
    { role: "user", content: longText("第一问：背景资料", 120) },
    toolCallMessage("t1"),
    { role: "tool", tool_call_id: "t1", content: `旧工具输出。${longText("抓取正文", 80)}` },
    { role: "user", content: "第二问：接着查" },
    toolCallMessage("t2"),
    { role: "tool", tool_call_id: "t2", content: "新输出：很小" },
  ];
}

/** 引用块本身超过观察截断长度：验证摘要观察先剥块头，正文不会被来源清单挤出窗口 */
function citationHeavyMessages(): Message[] {
  const block = renderCitationBlock(
    Array.from({ length: 6 }, (_, i) => ({
      index: i + 1,
      title: `来源${i + 1}：${"很长的来源标题".repeat(10)}`,
      url: `https://example.test/${"x".repeat(180)}/${i}`,
      tool: "rag_search",
    }))
  );
  return [
    { role: "system", content: "系统规则" },
    { role: "user", content: "只问一句：查一下" },
    toolCallMessage("g1"),
    { role: "tool", tool_call_id: "g1", content: `${block}\n\n旧观察正文：第一组结果 ${longText("旧细节", 60)}` },
    toolCallMessage("g2"),
    // 最新一组自己就超大 → 阶梯 2 也放不下，只能进阶梯 3
    { role: "tool", tool_call_id: "g2", content: `最新结果。${longText("大输出", 200)}` },
  ];
}

// ───────────────────────── 工具结果截断/落盘 ─────────────────────────

describe("processToolOutput", () => {
  const countTokens = (text: string) => Math.ceil(text.length / 2); // 确定性假 tokenizer

  test("短结果原样保留", async () => {
    const out = await processToolOutput("短输出", "search", {
      maxTokens: 100,
      offloadTokens: 1000,
      countTokens,
    });
    expect(out.content).toBe("短输出");
    expect(out.truncated).toBe(false);
  });

  test("中等结果头尾截断并标注省略量", async () => {
    const raw = "A".repeat(600) + "M".repeat(600) + "Z".repeat(600);
    const out = await processToolOutput(raw, "search", { maxTokens: 300, offloadTokens: 100000, countTokens });
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("已截断");
    expect(out.content).toContain("原始约 900 tokens");
    // 头尾都在，中段被掐
    expect(out.content.startsWith("AAA")).toBe(true);
    expect(out.content.endsWith("ZZZ")).toBe(true);
    expect(out.content.includes("MMM")).toBe(false);
  });

  test("超过落盘阈值：整篇写文件，消息里留路径引用", async () => {
    const dir = await tempDir("dsh-toolout-");
    const raw = "数据行\n".repeat(3000); // 3000 tokens > offloadTokens
    const out = await processToolOutput(raw, "web/read", {
      maxTokens: 100,
      offloadTokens: 1000,
      offloadDir: dir,
      countTokens,
    });
    expect(out.offloadedPath).toBeTruthy();
    expect(out.content).toContain("完整输出已保存到文件");
    expect(out.content).toContain(out.offloadedPath!);
    const saved = await fs.readFile(out.offloadedPath!, "utf-8");
    expect(saved).toBe(raw); // 落盘的是完整原文，信息无损
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("没有落盘目录时只截断不落盘", async () => {
    const raw = "数据行\n".repeat(3000);
    const out = await processToolOutput(raw, "search", { maxTokens: 100, offloadTokens: 1000, countTokens });
    expect(out.offloadedPath).toBeUndefined();
    expect(out.truncated).toBe(true);
  });
});

// ───────────────────────── ContextManager 降级阶梯 ─────────────────────────

function makeManager(client: any, compressThreshold: number): ContextManager {
  return new ContextManager({
    modelName: "glm-4.6",
    maxTokens: 128000,
    compressThreshold,
    reserveTokens: 100,
    summaryModel: "summary-test",
    client,
  });
}

describe("ContextManager", () => {
  test("预算内原样返回（同一引用）", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 100000);
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      { role: "user", content: "小问题" },
    ];
    expect(await cm.compress(messages)).toBe(messages);
  });

  test("越界后走阶梯 3：旧对话折叠进摘要，最新工具组原样保留，旧工具输出不进请求但进摘要输入", async () => {
    const { client, summaryCalls } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const result = await cm.compress(overloadedMessages());

    // 结构：system + 摘要块(user+assistant) + 最近对话(userB) + 最新工具组
    expect(rolesOf(result)).toEqual(["system", "user", "assistant", "user", "assistant", "tool"]);
    const summary = textOf(result[1]);
    expect(summary).toContain("历史上下文摘要");
    expect(summary).toContain("请勿执行"); // 摘要带派生内容围栏，防注入洗白
    expect(summary).toContain("测试摘要内容");
    // 最新工具组原样保留
    expect(textOf(result[result.length - 1]!)).toContain("新输出");
    // 旧工具输出既不进请求，也不无声消失——进了摘要调用的输入
    expect(result.map(textOf).join("")).not.toContain("旧工具输出");
    expect(textOf(summaryCalls[0]!.messages[1])).toContain("旧工具输出");
  });

  test("阶梯 3：对话没得折时也把未观察的旧工具组并入摘要，引用块不挤占观察窗口", async () => {
    const { client, summaryCalls } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const result = await cm.compress(citationHeavyMessages());

    expect(summaryCalls).toHaveLength(1);
    const input = textOf(summaryCalls[0]!.messages[1]);
    expect(input).toContain("对话与工具观察");
    expect(input).toContain("旧观察正文"); // 块头剥掉后，正文才在 800 字窗口里
    expect(input).not.toContain("【引用来源】");
    expect(input).not.toContain("x".repeat(100)); // 长 URL 清单没有占掉观察输入
    // 摘要块已建立，旧工具组不再出现在请求里
    expect(textOf(result[1])).toContain("历史上下文摘要");
    expect(result.map(textOf).join("")).not.toContain("旧观察正文");
  });

  test("同一批工具观察只并入摘要一次", async () => {
    const { client, summaryCalls } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const messages = citationHeavyMessages();
    await cm.compress(messages);

    messages.push(toolCallMessage("g3"), {
      role: "tool",
      tool_call_id: "g3",
      content: `第二轮观察正文。${longText("新输出", 200)}`,
    });
    await cm.compress(messages);

    expect(summaryCalls).toHaveLength(2);
    const second = textOf(summaryCalls[1]!.messages[1]);
    expect(second).toContain("现有摘要");
    expect(second).toContain("大输出"); // g2 这轮从最新组变成待观察
    expect(second).not.toContain("旧观察正文"); // g1 上一轮已并入，不重复喂
  });

  test("钉住前缀永不折叠，且排在摘要块之前", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const pinned: Message[] = [
      { role: "user", content: "【长期记忆摘要】用户偏好：简洁回答。" },
      { role: "assistant", content: "收到，我已了解以上长期记忆摘要。" },
    ];
    cm.setPinnedPrefix(pinned);
    // 钉住前缀必须真实存在于 messages 里（Agent 会在 history 之前注入），按对象身份识别
    const messages: Message[] = [{ role: "system", content: "系统规则" }, ...pinned, ...overloadedMessages().slice(1)];
    const result = await cm.compress(messages);

    expect(textOf(result[1])).toContain("长期记忆摘要");
    expect(textOf(result[2])).toContain("收到，我已了解");
    expect(textOf(result[3])).toContain("历史上下文摘要"); // 摘要块跟在钉住前缀后
  });

  test("阶梯 3 复核：最新工具组自己超预算时裁输出，头尾保留且不改原消息", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const events: CompactEvent[] = [];
    cm.onCompact = (event) => events.push(event);
    const raw = `HEAD_START。${longText("大输出", 200)}TAIL_END`;
    const toolMsg: Message = { role: "tool", tool_call_id: "c1", content: raw };
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      { role: "user", content: "当前问题：查一下" },
      toolCallMessage("c1"),
      toolMsg,
    ];

    const result = await cm.compress(messages);

    const clipped = result.find((m) => m.role === "tool")!;
    const clippedText = textOf(clipped);
    expect(clippedText.length).toBeLessThan(raw.length);
    expect(clippedText.startsWith("HEAD_START")).toBe(true);
    expect(clippedText.endsWith("TAIL_END")).toBe(true);
    expect(clippedText).toContain("此处省略约");
    // 只改本次表示：append-only 的历史消息不能被就地截断
    expect(toolMsg.content).toBe(raw);
    // 当前问题与调用仍完整保留
    expect(result.map(textOf).join("")).toContain("当前问题");
    const clipEvent = events.find((e) => e.action === "stage3_clip");
    expect(clipEvent?.detail).toContain("裁剪 1 条最新工具输出");
    expect(clipEvent!.tokens).toBeGreaterThan(0);
  });

  test("阶梯 3 复核：裁完工具仍超预算时从旧到新丢未折叠对话，最近问题保留", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const events: CompactEvent[] = [];
    cm.onCompact = (event) => events.push(event);
    const pinned: Message[] = [
      { role: "user", content: `【长期记忆摘要】${longText("长期记忆", 120)}` },
      { role: "assistant", content: "收到，我已了解以上长期记忆摘要。" },
    ];
    cm.setPinnedPrefix(pinned);
    const toolMsg: Message = {
      role: "tool",
      tool_call_id: "z1",
      content: `最新工具输出。${longText("大输出", 150)}`,
    };
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      ...pinned,
      { role: "user", content: `旧问题：${longText("旧背景", 150)}` },
      { role: "user", content: "中间问题：简短" },
      { role: "user", content: "最近问题：简短" },
      toolCallMessage("z1"),
      toolMsg,
    ];

    const result = await cm.compress(messages);
    const joined = result.map(textOf).join("");

    expect(joined).toContain("长期记忆摘要");
    expect(joined).toContain("最近问题");
    expect(joined).not.toContain("中间问题"); // 最新的未折叠轮之外都被丢掉
    expect(joined).not.toContain("旧问题");
    expect(textOf(result.find((m) => m.role === "tool"))).toContain("此处省略约");
    expect(toolMsg.content).not.toContain("此处省略约");
    const clipEvent = events.find((e) => e.action === "stage3_clip")!;
    expect(clipEvent.detail).toContain("丢弃 1 条更早对话");
    expect(clipEvent.messages).toBe(1);
  });

  test("阶梯 3 表示装得下时不发 stage3_clip", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const events: CompactEvent[] = [];
    cm.onCompact = (event) => events.push(event);
    await cm.compress(overloadedMessages());
    expect(events.some((e) => e.action === "stage3_clip")).toBe(false);
  });

  test("阶梯 1 占位符保留引用块：旧输出正文省略，编号→来源映射还在", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 800);
    const block = renderCitationBlock([{ index: 1, title: "旧来源", url: "https://old.example/", tool: "search_web" }]);
    const oldBody = longText("旧正文", 120);
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      { role: "user", content: "问题" },
      toolCallMessage("s1"),
      { role: "tool", tool_call_id: "s1", content: `${block}\n\n${oldBody}` },
      toolCallMessage("s2"),
      { role: "tool", tool_call_id: "s2", content: "最新输出：很小" },
    ];

    const result = await cm.compress(messages);
    const joined = result.map(textOf).join("");

    expect(joined).toContain("工具输出已省略");
    expect(joined).toContain("[1] 旧来源（https://old.example/）");
    expect(joined).not.toContain("旧正文第0行"); // 正文确实被省了
    expect(joined).not.toContain("【引用来源索引】"); // 块还在原位，无需再做索引
    expect(joined).toContain("最新输出");
  });

  test("阶梯 2 丢整组后，旧组的引用编号转成索引块保留", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 600);
    const block = renderCitationBlock([{ index: 1, title: "旧来源", url: "https://old.example/", tool: "search_web" }]);
    // 占位符省不掉巨型参数：只有整组丢掉（阶梯 2）才装得下
    const hugeArgs = JSON.stringify({ q: longText("参数", 120) });
    const oldOwner: Message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: hugeArgs } }],
    };
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      { role: "user", content: "问题" },
      oldOwner,
      { role: "tool", tool_call_id: "t1", content: `${block}\n\n旧输出正文：简短` },
      toolCallMessage("t2"),
      { role: "tool", tool_call_id: "t2", content: "最新输出：很小" },
    ];

    const result = await cm.compress(messages);
    const joined = result.map(textOf).join("");

    expect(joined).not.toContain("参数第0行");
    expect(joined).not.toContain("旧输出正文");
    expect(joined).toContain("【引用来源索引】");
    expect(joined).toContain("[1] 旧来源（https://old.example/）");
    expect(joined).toContain("最新输出");
    // 索引块插在 system 之后、对话之前
    expect(result[0]!.role).toBe("system");
    expect(textOf(result[1])).toContain("【引用来源索引】");
  });

  test("阶梯 3 索引块：只列已不可见的编号，最新组已展示的不重复", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const oldBlock = renderCitationBlock([
      { index: 1, title: "旧一", url: "https://old.example/1", tool: "search_web" },
      { index: 2, title: "旧二", url: "https://old.example/2", tool: "search_web" },
    ]);
    const latestBlock = renderCitationBlock([
      { index: 2, title: "新二", url: "https://old.example/2", tool: "search_web" },
      { index: 3, title: "新三", url: "https://new.example/3", tool: "search_web" },
    ]);
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      { role: "user", content: "问题" },
      toolCallMessage("g1"),
      { role: "tool", tool_call_id: "g1", content: `${oldBlock}\n\n旧观察正文：简短` },
      toolCallMessage("g2"),
      { role: "tool", tool_call_id: "g2", content: `${latestBlock}\n\n${longText("大输出", 200)}` },
    ];

    const result = await cm.compress(messages);
    const digest = result.find((m) => textOf(m).startsWith("【引用来源索引】"));

    expect(digest).toBeDefined();
    expect(textOf(digest)).toContain("[1] 旧一（https://old.example/1）");
    expect(textOf(digest)).not.toContain("[2] 旧二"); // 最新组已经展示了 [2]
    expect(textOf(digest)).not.toContain("[3] 新三"); // 最新组自己带着 [3]
    expect(result.map(textOf).join("")).not.toContain("旧观察正文");
  });

  test("阶梯 3 裁剪最新工具输出时整块保留引用块", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 500);
    const block = renderCitationBlock([{ index: 1, title: "当前来源", url: "https://now.example/", tool: "search_web" }]);
    const body = `HEAD_START。${longText("大输出", 200)}TAIL_END`;
    const messages: Message[] = [
      { role: "system", content: "系统规则" },
      { role: "user", content: "当前问题" },
      toolCallMessage("c1"),
      { role: "tool", tool_call_id: "c1", content: `${block}\n\n${body}` },
    ];

    const result = await cm.compress(messages);
    const tool = result.find((m) => m.role === "tool")!;
    const content = textOf(tool);

    expect(content.startsWith("【引用来源】")).toBe(true);
    expect(content).toContain("[1] 当前来源（https://now.example/）");
    expect(content).toContain("此处省略约");
    expect(content.endsWith("TAIL_END")).toBe(true);
  });

  test("摘要调用失败不抛错也不丢消息：返回阶梯 2 的无损表示，连续失败后硬截断兜底", async () => {
    const { client } = makeSummaryClient(undefined, { failSummary: true });
    const cm = makeManager(client, 500);
    const messages = overloadedMessages();

    const first = await cm.compress(messages);
    expect(first.map(textOf).join("")).not.toContain("历史上下文摘要");
    expect(first.map(textOf).join("")).toContain("第一问"); // 摘要失败不折叠，普通对话都还在
    expect(first.map(textOf).join("")).not.toContain("旧工具输出"); // 无损阶梯仍然生效

    // 连续 3 次失败后放弃 LLM 摘要：硬截断更早对话，保证请求能进窗口
    await cm.compress(messages);
    await cm.compress(messages);
    const fourth = await cm.compress(messages);
    expect(fourth.map(textOf).join("")).not.toContain("第一问");
    expect(textOf(fourth[fourth.length - 1]!)).toContain("新输出"); // 最新工具组仍保留
  });

  test("emergency 模式跳过阶梯判断直接深压，摘要失败则硬截断", async () => {
    const { client } = makeSummaryClient(undefined, { failSummary: true });
    const cm = makeManager(client, 500);
    const result = await cm.compress(overloadedMessages(), { emergency: true });
    expect(result.map(textOf).join("")).not.toContain("第一问");
    expect(textOf(result[result.length - 1]!)).toContain("新输出");
  });

  test("真实 usage 校准估算：actual 远大于 estimate 时提前触发压缩", async () => {
    const { client } = makeSummaryClient();
    const cm = makeManager(client, 1000);
    const small: Message[] = [
      { role: "system", content: "系统规则" },
      { role: "user", content: "短问题" },
    ];
    expect(await cm.compress(small)).toBe(small); // 估算远低于 1000

    // 模拟估算盲区：真实 prompt 是估算的 2.5 倍（图片/工具 schema 没被算进去）
    cm.recordPromptUsage(small, 2500);
    // 校准后 2500 > 1000 → 触发折叠（messages 里有对话可折叠）
    const result = await cm.compress(overloadedMessages());
    expect(textOf(result[1])).toContain("历史上下文摘要");
  });

  test("摘要瞬时失败（429）会退避重试，恢复后不降级", async () => {
    let attempts = 0;
    const client: any = {
      chat: {
        completions: {
          create: async (params: any) => {
            if (!params.tools) {
              attempts++;
              if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
              return {
                choices: [{ message: { content: "## 任务与目标\n重试后的摘要" } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            return { choices: [{ message: { content: "好的" } }] };
          },
        },
      },
    };
    const cm = makeManager(client, 500);
    const result = await cm.compress(overloadedMessages());

    expect(attempts).toBe(2);
    expect(textOf(result[1])).toContain("重试后的摘要");
  });

  test("摘要模型不可用（404）时回退主模型一次", async () => {
    const models: string[] = [];
    const client: any = {
      chat: {
        completions: {
          create: async (params: any) => {
            if (!params.tools) {
              models.push(params.model);
              if (params.model === "summary-test") {
                throw Object.assign(new Error("model not found"), { status: 404 });
              }
              return {
                choices: [{ message: { content: "## 任务与目标\n主模型兜底摘要" } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            return { choices: [{ message: { content: "好的" } }] };
          },
        },
      },
    };
    const cm = makeManager(client, 500);
    const result = await cm.compress(overloadedMessages());

    expect(models).toEqual(["summary-test", "glm-4.6"]);
    expect(textOf(result[1])).toContain("主模型兜底摘要");
  });
});

// ───────────────────────── SessionStore 长期摘要 ─────────────────────────

describe("SessionStore 长期摘要", () => {
  test("记录后 load 带回；不进 messages；compact 保留最新一条", async () => {
    const dir = await tempDir("dsh-lts-");
    const store = new SessionStore({ dir, sessionId: "t" });
    await store.append({ role: "user", content: "问题" });
    await store.append({ role: "assistant", content: "回答" });
    await store.recordLongTermSummary("## 任务与目标\n第一版");
    await store.recordLongTermSummary("## 任务与目标\n第二版"); // 每次更新都追加

    const loaded = await store.load();
    expect(loaded.longTermSummary).toBe("## 任务与目标\n第二版");
    expect(loaded.messages.map((m) => m.content)).toEqual(["问题", "回答"]); // 元记录不进上下文

    await store.compact(0); // 连对话都不留，长期摘要也得活下来
    const after = await store.load();
    expect(after.longTermSummary).toBe("## 任务与目标\n第二版");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("空摘要不落盘", async () => {
    const dir = await tempDir("dsh-lts-");
    const store = new SessionStore({ dir, sessionId: "t" });
    await store.recordLongTermSummary("   ");
    const raw = await fs.readFile(store.filePath, "utf-8").catch(() => "");
    expect(raw).not.toContain("【长期摘要】");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ───────────────────────── Agent 集成：截断、fold、注入 ─────────────────────────

describe("Agent 上下文压缩集成", () => {
  function makeAgentClient() {
    const requests: any[] = [];
    let mainCalls = 0;
    const client: any = {
      chat: {
        completions: {
          create: async (params: any) => {
            requests.push(params);
            if (!params.tools?.length) {
              // 摘要类调用（长期摘要 fold）
              return {
                choices: [{ message: { content: "## 任务与目标\n长期记忆测试" } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            mainCalls++;
            if (mainCalls === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        { id: "call1", type: "function", function: { name: "dummy", arguments: "{}" } },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
              };
            }
            return {
              choices: [{ message: { content: "最终答案" } }],
              usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
            };
          },
        },
      },
    };
    return { client, requests };
  }

  function bigToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "dummy",
        description: "返回超大结果的测试工具",
        schema: z.object({}),
        execute: async () =>
          Array.from({ length: 300 }, (_, i) => `第${i}行：网页抓取正文，含数字 12345 与一些中文内容。`).join("\n"),
      })
    );
    return registry;
  }

  test("超大工具结果截断落盘；fold 转后台（下一轮开轮前落地并补记 token）；新实例注入钉住前缀", async () => {
    const dir = await tempDir("dsh-agent-lts-");
    const store = new SessionStore({ dir, sessionId: "t" });
    const { client, requests } = makeAgentClient();
    const agent = new Agent({
      model: "glm-4.6",
      systemPrompt: "系统规则",
      client,
      tools: bigToolRegistry(),
      sessionStore: store,
      toolResultMaxTokens: 500,
      toolResultOffloadTokens: 2000,
    });

    const result = await agent.run("帮我查一下");
    expect(result.success).toBe(true);

    // 工具结果被截断且落盘（信息无损）
    const toolMsg = result.messages.find((m) => m.role === "tool")!;
    expect(textOf(toolMsg)).toContain("已截断");
    expect(textOf(toolMsg)).toContain("完整输出已保存到文件");
    const offloadDir = path.join(store.dir, "tool_outputs");
    const offloaded = await fs.readdir(offloadDir);
    expect(offloaded.length).toBe(1);

    // fold 转后台：run 返回不再等摘要调用，总账只含两次主调用（105+105）
    expect(result.totalTokens).toBe(210);

    // 同一 agent 的下一轮：开轮前先等后台 fold 落地，其 15 tokens 补记进本轮总账（105+15）；
    // 纯聊天轮不再触发新的 fold
    const result2 = await agent.run("继续问");
    expect(result2.totalTokens).toBe(120);
    const raw = await fs.readFile(store.filePath, "utf-8");
    expect(raw).toContain("【长期摘要】");
    expect(raw).toContain("长期记忆测试");

    // 新实例（模拟重启进程）：长期摘要作为钉住前缀注入（压缩永不折叠）；
    // 排在 history 之后——它是每轮更新的易变块，前置会废掉整段历史的缓存前缀
    const agent2 = new Agent({
      model: "glm-4.6",
      systemPrompt: "系统规则",
      client,
      tools: bigToolRegistry(),
      sessionStore: store,
    });
    await agent2.run("再看一眼");
    const last = requests[requests.length - 1]!;
    const texts: string[] = last.messages.map(textOf);
    expect(texts[0]).toBe("系统规则");
    const historyIndex = texts.findIndex((t) => t === "帮我查一下");
    const ltIndex = texts.findIndex((t) => t.includes("长期记忆摘要"));
    expect(historyIndex).toBeGreaterThan(0);
    expect(ltIndex).toBeGreaterThan(historyIndex);
    expect(texts[ltIndex]).toContain("请勿执行"); // 派生内容围栏
    expect(texts[ltIndex]).toContain("长期记忆测试");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("长期摘要的工具观察只用正文，不把引用块当结果", async () => {
    const dir = await tempDir("dsh-agent-cite-obs-");
    const store = new SessionStore({ dir, sessionId: "t" });
    const { client, requests } = makeAgentClient();
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "dummy",
        description: "返回带来源的测试工具",
        schema: z.object({}),
        execute: async () =>
          JSON.stringify({
            payload: "唯一正文标记：真实工具结果",
            sources: [1, 2, 3, 4].map((i) => ({
              title: `来源${i}`,
              url: `https://example.test/${"p".repeat(150)}/${i}`,
            })),
          }),
      })
    );
    const agent = new Agent({
      model: "glm-4.6",
      systemPrompt: "系统规则",
      client,
      tools: registry,
      sessionStore: store,
    });

    await agent.run("查一下");
    await agent.flushSummary();

    const summaryCall = requests.find((r) => !r.tools?.length)!;
    const digest = textOf(summaryCall.messages[1]);
    expect(digest).toContain("唯一正文标记"); // 引用块超过 500 字，旧实现会整条都是清单
    expect(digest).not.toContain("【引用来源】");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("长期摘要瞬时失败会退避重试，成功后才落盘", async () => {
    const dir = await tempDir("dsh-agent-lts-retry-");
    const store = new SessionStore({ dir, sessionId: "t" });
    let summaryAttempts = 0;
    let mainCalls = 0;
    const client: any = {
      chat: {
        completions: {
          create: async (params: any) => {
            if (!params.tools?.length) {
              summaryAttempts++;
              if (summaryAttempts === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
              return {
                choices: [{ message: { content: "## 任务与目标\n重试后长期摘要" } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              };
            }
            mainCalls++;
            if (mainCalls === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [{ id: "c1", type: "function", function: { name: "dummy", arguments: "{}" } }],
                    },
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
              };
            }
            return {
              choices: [{ message: { content: "最终答案" } }],
              usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
            };
          },
        },
      },
    };
    const agent = new Agent({
      model: "glm-4.6",
      systemPrompt: "系统规则",
      client,
      tools: bigToolRegistry(),
      sessionStore: store,
    });

    await agent.run("查一下");
    expect(await agent.flushSummary()).toBe(15);
    expect(summaryAttempts).toBe(2);
    const raw = await fs.readFile(store.filePath, "utf-8");
    expect(raw).toContain("重试后长期摘要");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("纯聊天轮（无工具调用）不 fold 长期摘要", async () => {
    const dir = await tempDir("dsh-agent-chat-");
    const store = new SessionStore({ dir, sessionId: "t" });
    const { client } = makeAgentClient();
    const agent = new Agent({
      model: "glm-4.6",
      systemPrompt: "系统规则",
      client,
      tools: new ToolRegistry(),
      sessionStore: store,
    });
    await agent.run("你好");
    const raw = await fs.readFile(store.filePath, "utf-8");
    expect(raw).not.toContain("【长期摘要】");
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * 摘要调用挂起可控的 client：started 在摘要请求发出时 resolve；
   * release() 放行并返回 15 tokens；传入的 signal abort 时 reject（模拟 SDK 取消）。
   */
  function makeGatedSummaryClient() {
    let mainCalls = 0;
    let releaseRef: (() => void) | undefined;
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((r) => (notifyStarted = r));
    const client: any = {
      chat: {
        completions: {
          create: async (params: any, options?: { signal?: AbortSignal }) => {
            if (!params.tools?.length) {
              notifyStarted();
              return new Promise((resolve, reject) => {
                const onAbort = () => reject(new Error("This operation was aborted"));
                if (options?.signal?.aborted) {
                  onAbort();
                  return;
                }
                options?.signal?.addEventListener("abort", onAbort, { once: true });
                releaseRef = () => {
                  options?.signal?.removeEventListener("abort", onAbort);
                  resolve({
                    choices: [{ message: { content: "## 任务与目标\n后台摘要落地" } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                  });
                };
              });
            }
            mainCalls++;
            if (mainCalls === 1) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [{ id: "c1", type: "function", function: { name: "dummy", arguments: "{}" } }],
                    },
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
              };
            }
            return {
              choices: [{ message: { content: "最终答案" } }],
              usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
            };
          },
        },
      },
    };
    return { client, started, release: () => releaseRef?.() };
  }

  test("run 返回不等后台 fold；flushSummary 等它写盘并回报 token 成本", async () => {
    const dir = await tempDir("dsh-agent-flush-");
    const store = new SessionStore({ dir, sessionId: "t" });
    const { client, started, release } = makeGatedSummaryClient();
    const agent = new Agent({
      model: "glm-4.6",
      systemPrompt: "系统规则",
      client,
      tools: bigToolRegistry(),
      sessionStore: store,
    });

    // run 已返回而摘要调用还挂着——这正是 REPL 提示符不被拖住的前提
    const result = await agent.run("帮我查一下");
    expect(result.totalTokens).toBe(210);
    await started;
    expect(await fs.readFile(store.filePath, "utf-8")).not.toContain("后台摘要落地");

    release();
    expect(await agent.flushSummary()).toBe(15);
    expect(await fs.readFile(store.filePath, "utf-8")).toContain("后台摘要落地");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("shutdown 中止在飞的 fold：报告跳过、摘要不落盘、不抛不吊", async () => {
    const dir = await tempDir("dsh-agent-shut-");
    const store = new SessionStore({ dir, sessionId: "t" });
    const { client, started } = makeGatedSummaryClient();
    const agent = new Agent({
      model: "glm-4.6",
      systemPrompt: "系统规则",
      client,
      tools: bigToolRegistry(),
      sessionStore: store,
    });

    await agent.run("帮我查一下");
    await started;

    expect(await agent.shutdown()).toBe(true);
    expect(await fs.readFile(store.filePath, "utf-8")).not.toContain("后台摘要落地");
    // 二次关停幂等：没有在飞的更新可跳过
    expect(await agent.shutdown()).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
