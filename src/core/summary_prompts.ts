// src/core/summary_prompts.ts
/**
 * 结构化摘要的统一骨架：8 个固定小节（Claude Code auto-compact 的分段方式）。
 * 固定分节 + 「任务与目标」只补不改，是为了对抗滚动摘要的迭代衰减：
 * 自由格式的 3-5 条 bullet 在反复 merge 里会丢早期信息（电话游戏），
 * 分节骨架让每次 merge 只做"并入对应小节"，原始任务始终有落点。
 *
 * run 内滚动摘要（context_manager）与跨 run 长期摘要（agent）共用同一套骨架，
 * 两份摘要的结构一致，模型续接时不用适应两种格式。
 */
export const SUMMARY_SECTIONS = [
  "任务与目标",
  "关键事实与数据",
  "决策与结论",
  "产出物与引用",
  "错误与教训",
  "未决问题",
  "当前进展",
  "下一步",
] as const;

export const SUMMARY_SHAPE = SUMMARY_SECTIONS.map((s) => `## ${s}`).join("\n");

const COMMON_RULES = [
  "保留具体的数字、名称、路径、URL 与结论；",
  "不要评价，不要输出对话中没有的内容；只输出摘要本身。",
].join("\n");

export const SUMMARY_FRESH_PROMPT =
  "你是会话摘要器。把输入的对话（可能附带工具观察）压缩成一份结构化摘要，" +
  "供 AI 助手之后续接上下文使用。用中文输出，必须严格包含以下 8 个小节" +
  "（每节以「## 」开头，按原顺序；某节没有内容就写「（无）」）：\n" +
  `${SUMMARY_SHAPE}\n\n要求：${COMMON_RULES}`;

export const SUMMARY_MERGE_PROMPT =
  "你是会话摘要器。输入是「现有摘要」和「新产生的对话（可能附带工具观察）」。把它们合并成" +
  "一份更新后的结构化摘要，供 AI 助手之后续接上下文使用。用中文输出，必须严格保持以下 8 个小节" +
  "（每节以「## 」开头，按原顺序；某节没有内容就写「（无）」）：\n" +
  `${SUMMARY_SHAPE}\n\n要求：\n` +
  "- 「任务与目标」除非新对话明确改变了目标，否则原样保留；\n" +
  "- 已有小节的内容只能合并与精炼，不得无故丢失；新信息并入对应小节；\n" +
  `- ${COMMON_RULES}`;

export const LONGTERM_FRESH_PROMPT =
  "你是会话记忆器。把输入的「一轮工作记录」整理成长期记忆摘要，供 AI 助手在后续会话中续接上下文。" +
  "用中文输出，必须严格包含以下 8 个小节（每节以「## 」开头，按原顺序；某节没有内容就写「（无）」）：\n" +
  `${SUMMARY_SHAPE}\n\n要求：${COMMON_RULES}`;

export const LONGTERM_MERGE_PROMPT =
  "你是会话记忆器。输入是「现有长期摘要」和「新完成的一轮工作」。把它们合并成更新后的长期记忆摘要，" +
  "供 AI 助手在后续会话中续接上下文。用中文输出，必须严格保持以下 8 个小节" +
  "（每节以「## 」开头，按原顺序；某节没有内容就写「（无）」）：\n" +
  `${SUMMARY_SHAPE}\n\n要求：\n` +
  "- 「任务与目标」除非新一轮工作明确改变了目标，否则原样保留；\n" +
  "- 已有小节的内容只能合并与精炼，不得无故丢失；新信息并入对应小节；\n" +
  `- ${COMMON_RULES}`;

/** 摘要输出上限随输入量伸缩：折叠量小时不浪费，折叠量大时不被截断在半句 */
export function summaryMaxTokensFor(inputTokens: number): number {
  return Math.min(1500, Math.max(500, Math.round(inputTokens / 5)));
}
