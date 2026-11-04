import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ndcgAt5, readQuestions, recallByRank, renderSession, surfaces } from "../benchmarks/longmem_eval";

const IDCG2 = 1 / Math.log2(2) + 1 / Math.log2(3);

describe("LongMemEval 判分纯函数", () => {
  test("renderSession 只把 has_answer 回合计为 gold，空白回合跳过但保留原序号", () => {
    const rendered = renderSession([
      { role: "user", content: "  " },
      { role: "user", content: "第一句\t在这里" },
      { role: "assistant", content: "关键事实在这里", has_answer: true },
    ]);
    expect(rendered.gold).toEqual(["关键事实在这里"]);
    expect(rendered.text).toBe("[1] user: 第一句 在这里\n[2] assistant: 关键事实在这里");
  });

  test("长回合只要被块覆盖首/中/尾任一窗口即算顶出，短回合要求整段出现", () => {
    const body = `问题背景说明。${"中".repeat(400)}结论是每周三发布。`;
    expect(surfaces(body.slice(150, 650), body)).toBe(true);
    expect(surfaces(body.slice(-120), body)).toBe(true);
    expect(surfaces("与本报告完全无关的另一些文字，一个字的重合都没有。", body)).toBe(false);
    expect(surfaces("好的", "好的")).toBe(true);
    expect(surfaces("好的", "收到，明白了")).toBe(false);
  });

  test("块首 80 字符落在回合内也算顶出（回合比块长的情形）", () => {
    const body = "起始标记 ".repeat(20);
    expect(surfaces(`${body}后续无关内容`, body)).toBe(true);
  });

  test("Recall@k 随 k 单调，未进 top-K 的名次永不计入", () => {
    expect(recallByRank([0, 3, Number.POSITIVE_INFINITY], 3)).toEqual([1 / 3, 1 / 3, 2 / 3, 2 / 3]);
    expect(recallByRank([Number.POSITIVE_INFINITY], 1)).toEqual([0, 0, 0, 0]);
    expect(recallByRank([], 0)).toEqual([0, 0, 0, 0]);
  });

  test("NDCG@5 只取前 5 名次，按理想序归一且不超过 1", () => {
    expect(ndcgAt5([0, 1, 2], 3)).toBeCloseTo(1, 6);
    expect(ndcgAt5([0, Number.POSITIVE_INFINITY], 2)).toBeCloseTo(1 / IDCG2, 6);
    expect(ndcgAt5([7, 8], 2)).toBe(0);
    expect(ndcgAt5([4], 2)).toBeCloseTo((1 / Math.log2(2)) / IDCG2, 6);
  });
});

const question = (id: string, type: string, answer: string) => ({
  question_id: id, question_type: type, question: `q-${id}`, answer,
  haystack_dates: ["2024-01-01"], haystack_session_ids: [`s_${id}`],
  haystack_sessions: [[{ role: "user", content: `c-${id}`, has_answer: true }]],
  answer_session_ids: [`s_${id}`],
});

describe("LongMemEval 数据集流式读取", () => {
  const write = async (text: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lme-read-"));
    const file = path.join(dir, "data.json");
    await fs.writeFile(file, text, "utf-8");
    return { dir, file };
  };

  test("按缩进格式切题，正文里的伪边界不会多数一道题", async () => {
    // 会话正文里塞进与题目起始序列完全相同的文本：JSON 里裸换行必然是 \n 两个字符，所以切分不受影响
    const fake = `{\n        "question_id": "not_a_question"`;
    const items = [question("a1", "t1", fake), question("b1", "t2", "普通正文"), question("a2", "t1", "{}")];
    const { dir, file } = await write(`${JSON.stringify(items, null, 4)}\n`);
    const read = await readQuestions(file, () => true);
    expect(read.total).toBe(3);
    expect(read.questions.map(q => q.question_id)).toEqual(["a1", "b1", "a2"]);
    expect(read.questions[1]!.answer).toBe("普通正文");
    expect(read.sha256).toBe(createHash("sha256").update(JSON.stringify(items, null, 4) + "\n").digest("hex").slice(0, 16));
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("紧凑格式（缩进 0）同样能切，选择谓词按出现顺序生效", async () => {
    const items = [question("a1", "t1", "x"), question("b1", "t2", "y"), question("a2", "t1", "z")];
    const { dir, file } = await write(JSON.stringify(items));
    const firstT1Only = await readQuestions(file, q => q.question_type === "t1");
    expect(firstT1Only.total).toBe(3);
    expect(firstT1Only.questions.map(q => q.question_id)).toEqual(["a1", "a2"]);
    const compact = await readQuestions(file, (_q, index) => index < 2);
    expect(compact.questions.map(q => q.question_id)).toEqual(["a1", "b1"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("不是题目数组就明确报错，不返回半截结果", async () => {
    const { dir, file } = await write(JSON.stringify([{ id: 1 }, { id: 2 }]));
    expect(readQuestions(file, () => true)).rejects.toThrow(/不是预期的题目数组/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
