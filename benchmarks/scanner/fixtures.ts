// benchmarks/scanner/fixtures.ts
/**
 * scanner 评测的固定合成对照集：标注与 canned 回执都是手工构造的，聚合数字可手算
 * （tests/scanner_eval.test.ts 断言这些数字，防止打分口径被无声改坏）。
 * 覆盖六类形态：全对 / 弃权与 gold-unknown / 误报 / 漏报 / 中文标签归一 / 报告缺失。
 * 不读取任何真实快照，不联网，不调用模型。
 */
import type { ScannerGoldCase } from "../scanner_eval";

export const cannedCases: ScannerGoldCase[] = [
  {
    id: "BVSCAM0001",
    category: "引流诈骗",
    gold: { video: "high", author: "medium", comments: "low", overall: "high" },
    notes: "简介引流到微信 + 高风险窗口话术；全维度判定正确。",
  },
  {
    id: "BVSCAM0002",
    category: "引流诈骗",
    gold: { video: "high", author: "unknown", comments: "high", overall: "high" },
    notes: "作者维度标注员无法判断（unknown）；模型在评论区漏报（high 判成 low），overall 档位降了一级。",
  },
  {
    id: "BVCLEAN0003",
    category: "正常科普",
    gold: { video: "clean", author: "clean", comments: "clean", overall: "clean" },
    notes: "评论区等级虚高（clean 判成 low）——二元口径仍属 safe 记 tn，只进严格一致与 MAE；overall 同理判 low。",
  },
  {
    id: "BVCLEAN0004",
    category: "正常科普",
    gold: { video: "clean", author: "clean", comments: "clean", overall: "clean" },
    notes: "作者维度数据缺失，模型按纪律记无法判断（合法弃权）。",
  },
  {
    id: "BVMIX00005",
    category: "采证受限",
    gold: { video: "medium", author: "medium", comments: "unknown", overall: "medium" },
    notes: "评论区标注员无法判断，模型同样记无法判断（正确弃权）；作者维度档位高了一级。",
  },
  {
    id: "BVNULL006",
    category: "解析失败",
    gold: { video: "high", author: "low", comments: "low", overall: "medium" },
    notes: "回执没有 JSON 报告（只有文字），整例按弃权计。",
  },
];

/** canned 模式的 scanner 最终回执：结论先行 + 固定 JSON 代码块，与真实提示词要求的格式一致 */
export const cannedReports: Record<string, string> = {
  BVSCAM0001: [
    "综合判断为高风险。视频简介引导添加微信领取资料，高风险窗口命中典型引流话术，作者简介含站外联系方式，评论区未见明显异常。",
    "```json",
    '{"bvid":"BVSCAM0001","risk_level":"high","confidence":0.85,"summary":"简介引流 + 话术命中","video":{"risk_level":"high"},"author":{"risk_level":"medium"},"comments":{"risk_level":"low"},"links":[{"url":"https://example.invalid/wechat","verdict":"采证受限","signals":[]}],"unresolved":["落地页不可达，未采到证"]}',
    "```",
  ].join("\n"),
  BVSCAM0002: [
    "视频内容高风险：字幕中段出现刷单返利话术。作者维度证据不足；评论区实际存在大量接单暗语，此处模型误判为低风险。",
    "```json",
    '{"bvid":"BVSCAM0002","risk_level":"medium","confidence":0.6,"video":{"risk_level":"high"},"author":{"risk_level":"正常"},"comments":{"risk_level":"低"},"links":[],"unresolved":[]}',
    "```",
  ].join("\n"),
  BVCLEAN0003: [
    "三维度均未发现诈骗信号，评论区仅有一条询问学习资料的普通评论被保守记为低风险（这是本对照集里设计好的误报）。",
    "```json",
    '{"bvid":"BVCLEAN0003","risk_level":"low","confidence":0.9,"video":{"risk_level":"clean"},"author":{"risk_level":"clean"},"comments":{"risk_level":"low"},"links":[],"unresolved":[]}',
    "```",
  ].join("\n"),
  BVCLEAN0004: [
    "视频与评论区无风险信号；快照缺作者数据，按判定纪律记无法判断。",
    "```json",
    '{"bvid":"BVCLEAN0004","risk_level":"clean","confidence":0.8,"video":{"risk_level":"clean"},"author":{"risk_level":"无法判断"},"comments":{"risk_level":"clean"},"links":[],"unresolved":["快照无 author 数据"]}',
    "```",
  ].join("\n"),
  BVMIX00005: [
    "视频维度命中夸大收益话术（中风险）；作者维度认证信息与行为模式接近营销号（高一级）；评论区整体被水军刷屏，无法判断。",
    "```json",
    '{"bvid":"BVMIX00005","risk_level":"high","confidence":0.7,"video":{"risk_level":"medium"},"author":{"risk_level":"high"},"comments":{"risk_level":"无法判断"},"links":[],"unresolved":["评论区被刷屏，语感失真"]}',
    "```",
  ].join("\n"),
  // 模型只输出了文字结论、漏掉了 JSON 代码块 —— 解析应失败，整例弃权
  BVNULL006: "综合判断：视频维度存在诱导风险，作者简介正常，评论区未见异常。建议结合人工复核。",
};

/**
 * canned 集的预期聚合值（手工推演，tests/scanner_eval.test.ts 断言）：
 * 三维度合并 18 对：tp=5（A.video/A.author/B.video/E.video/E.author），fp=0，
 * tn=6（A.comments/C.video/C.author/C.comments/D.video/D.comments），fn=1（B.comments），
 * 弃权=4（D.author/F.video/F.author/F.comments），gold-unknown 上给了判断=1（B.author），
 * 正确弃权=1（E.comments）。=> P=5/5=1，R=5/6，F1=10/11，弃权率=4/16=0.25，
 * 严格一致=9/12=0.75，MAE=4/12=1/3（B.comments 高/低差 2 + C.comments 低档虚高 1 + E.author 高一级 1）。
 * overall 单列：tp=3（A/B/E，B/E 档位偏一级但仍属 risky），tn=2（C/D），弃权=1（F）
 * => P=R=F1=1，弃权率=1/6，严格一致=2/5，MAE=3/5。
 * 注意二元口径下没有 fp：pred=low 落在 gold=clean 上是等级虚高不是误报——
 * fp 路径由 tests 里 pairOutcome 的直接断言覆盖。
 */
export const cannedExpected = {
  micro: { precision: 1, recall: 5 / 6, f1: 10 / 11, abstainRate: 0.25, exactMatchRate: 0.75, mae: 1 / 3 },
  overall: { precision: 1, recall: 1, f1: 1, abstainRate: 1 / 6, exactMatchRate: 0.4, mae: 0.6 },
  counts: { tp: 5, fp: 0, tn: 6, fn: 1, abstain: 4, goldUnknownPredicted: 1, correctAbstain: 1 },
};
