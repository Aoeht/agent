// record_pattern 回归：新建草稿、同名/语义合并、达标转正、既知手法拦截、无向量回退、删卡清理。
// 与 rag.test.ts 同纪律：密闭测试（删 RAG_PG_URL），向量用 fixture 主题假向量，全部落临时目录。
delete process.env.RAG_PG_URL;
delete process.env.EMBEDDING_MODEL;
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../src/rag/knowledge_store";
import { makeFakeEmbeddings } from "../benchmarks/rag/fixture";
import { createRecordPatternTool } from "../src/tools/record_pattern";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

const ROOT = path.join(os.tmpdir(), `record-pattern-test-${Date.now()}`);
const dirFor = (name: string) => path.join(ROOT, name);

interface Outcome {
  status: string;
  pattern?: { name: string; card_status: string; source_videos: number };
  matched_pattern?: { name: string; similarity: number };
  library: { draft: number; formal: number };
  hint?: string;
  warnings?: string[];
}

function makeTool(dir: string, embeddings: ReturnType<typeof makeFakeEmbeddings> | null, extra: Record<string, unknown> = {}) {
  return createRecordPatternTool({
    store: new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") }),
    expDir: path.join(dir, "exp"),
    curatedDir: path.join(dir, "curated"),
    cacheDir: path.join(dir, "cache"),
    ...(embeddings ? { embeddings } : { embeddings: null }),
    ...extra,
  });
}

async function main(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });

  const dir = dirFor("loop");
  await fs.mkdir(path.join(dir, "curated"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "curated", "客服退款.md"),
    "# 客服退款理赔\n\n## 典型话术\n- 客服主动来电说商品有问题退款\n- 理赔需要屏幕共享指导\n",
    "utf-8"
  );
  const embeddings = makeFakeEmbeddings();
  const tool = makeTool(dir, embeddings, { promoteThreshold: 3 });

  // 1. 新建：单视频进草稿层，文件带【草稿】标题，卡片入知识库
  const first = (await tool.execute({
    bv: "BV1",
    name: "AI换脸视频通话借钱套路",
    scripts: ["换脸视频通话冒充亲人", "AI合成语音制造紧急情况"],
    signals: ["催促转账到陌生账户"],
  })) as Outcome;
  check(first.status === "created" && first.pattern?.card_status === "草稿" && first.pattern.source_videos === 1, "单视频新建为草稿", first);
  const draftFile = path.join(dir, "exp", "草稿", "AI换脸视频通话借钱套路.md");
  const draftBody = await fs.readFile(draftFile, "utf-8");
  check(draftBody.includes("# 【草稿】AI换脸视频通话借钱套路"), "草稿卡带【草稿】标题", draftBody.slice(0, 40));
  check(draftBody.split("\n").some((l) => /^- \d{4}-\d{2}-\d{2} BV1$/.test(l.trim())), "草稿卡记录来源 BV（日期+BV 行）", draftBody.split("\n").filter((l) => l.includes("BV")));

  const independentStore = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  const afterCreate = await independentStore.list();
  check(afterCreate.length > 0 && afterCreate.every((d) => d.trust === "internal"), "卡片已入知识库（internal）", afterCreate.map((d) => d.source));

  // 2. 同名合并：第二个视频，仍在草稿层（未达阈值 3）
  const second = (await tool.execute({
    bv: "BV2",
    name: "AI换脸视频通话借钱套路",
    scripts: ["AI合成语音制造紧急情况", "说朋友住院急用钱"],
  })) as Outcome;
  check(second.status === "merged" && second.pattern?.source_videos === 2 && second.pattern.card_status === "草稿", "同名记录合并进同一张卡", second);
  const mergedState = JSON.parse(await fs.readFile(path.join(dir, "exp", "状态.json"), "utf-8"));
  const mergedRec = mergedState.patterns["AI换脸视频通话借钱套路"];
  check(mergedRec.scripts.includes("说朋友住院急用钱"), "合并时话术并集去重", mergedRec.scripts);

  // 3. 语义合并 + 达标转正：第三视频用不同名字但同一主题（假向量同主题维度命中）
  const third = (await tool.execute({
    bv: "BV3",
    name: "深度伪造亲友语音借钱",
    scripts: ["deepfake 视频通话", "换脸冒充亲戚要钱"],
    evidence: "00:31 换脸视频通话画面",
  })) as Outcome;
  check(third.status === "promoted" && third.pattern?.card_status === "正式" && third.pattern.source_videos === 3, "语义相似合并且跨 3 视频自动转正", third);
  check(!!third.hint && third.hint.includes("rag_eval"), "转正后附带回归评测提示", third.hint);
  const formalBody = await fs.readFile(path.join(dir, "exp", "正式", "AI换脸视频通话借钱套路.md"), "utf-8");
  check(formalBody.startsWith("# AI换脸视频通话借钱套路") && !formalBody.includes("【草稿】"), "转正卡去掉草稿标记", formalBody.slice(0, 30));
  check(formalBody.split("\n").some((l) => l.includes("BV3：00:31 换脸视频通话画面")), "来源与证据带 BV+摘录", formalBody.split("\n").filter((l) => l.includes("BV3")));
  await fs.access(draftFile).then(
    () => check(false, "草稿文件应已移除"),
    () => check(true, "草稿文件已随转正移除")
  );

  // 4. 既知手法拦截：与策展话术卡同主题 → 不入库
  const beforeKnown = (third.library.draft ?? 0) + (third.library.formal ?? 0);
  const known = (await tool.execute({
    bv: "BV4",
    name: "客服退款理赔新变种",
    scripts: ["客服主动退款", "理赔需要屏幕共享提供验证码"],
  })) as Outcome;
  check(known.status === "known" && !!known.matched_pattern?.name.includes("客服退款"), "既知手法只上报不入库", known);
  check(known.library.draft + known.library.formal === beforeKnown, "既知拦截不改变经验库", known.library);

  // 5. 无关新套路：零向量（fixture 无此主题）→ 新建第二张草稿
  const unrelated = (await tool.execute({
    bv: "BV5",
    name: "宠物领养付费套路",
    scripts: ["免费送品种猫吸引私信", "收取高额运费打包费"],
  })) as Outcome;
  check(unrelated.status === "created" && unrelated.library.draft === 1, "无关套路新建草稿", unrelated);

  // 6. 无向量回退：embeddings=null 时同名精确合并仍可用
  const fallbackTool = makeTool(dirFor("fallback"), null);
  await fallbackTool.execute({ bv: "BV1", name: "拼好饭返现套路", scripts: ["大额返现先垫付"] });
  const fallback = (await fallbackTool.execute({ bv: "BV2", name: "拼好饭返现套路", scripts: ["大额返现先垫付"] })) as Outcome;
  check(fallback.status === "merged" && fallback.pattern?.source_videos === 2, "无向量时同名合并可用", fallback);

  // 7. confirm 直转：人工确认跳过阈值
  const confirmed = (await tool.execute({
    bv: "BV6",
    name: "演唱会代拍骗局",
    scripts: ["声称内部渠道代拍", "要求先付全款定金"],
    confirm: true,
  })) as Outcome;
  check(confirmed.status === "promoted" && confirmed.pattern?.card_status === "正式", "人工确认立即转正", confirmed);

  // 8. 人工删卡后状态与库同步清理
  await fs.rm(path.join(dir, "exp", "正式", "演唱会代拍骗局.md"), { force: true });
  const afterDelete = (await tool.execute({
    bv: "BV7",
    name: "宠物领养付费套路",
    scripts: ["免费送品种猫吸引私信"],
  })) as Outcome;
  const stateAfter = JSON.parse(await fs.readFile(path.join(dir, "exp", "状态.json"), "utf-8"));
  check(stateAfter.patterns["演唱会代拍骗局"] === undefined, "被删卡的状态条目随下一次调用清理", Object.keys(stateAfter.patterns));
  const finalStore = new KnowledgeStore({ filePath: path.join(dir, "knowledge.json") });
  const finalDocs = await finalStore.list();
  check(finalDocs.every((d) => !d.source.includes("演唱会代拍骗局")), "被删卡的库内章节被剪除", finalDocs.map((d) => d.source));
  check(afterDelete.status === "merged" && afterDelete.pattern?.card_status === "草稿", "第二次记录宠物套路正常合并", afterDelete);
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
