// src/utils/thinking_effort.ts
/**
 * 统一「思考程度」档位 → 各厂商 OpenAI 兼容端点的请求字段映射。
 *
 * 底层量纲只有一种：模型在思考阶段可消耗的推理 token 预算；各厂商对外包装不同——
 * - qwen（DashScope 兼容模式）：enable_thinking 开关 + thinking_budget（1~32768）。
 *   思考模式仅流式输出可用（非流式 400），故非流式请求跳过注入并给 note。
 * - glm（智谱 bigmodel）：thinking.type enabled/disabled，无预算参数（动态思考），
 *   low/medium/high 等价于开；GLM-5.3 系列起不支持关闭思考（disabled 报错）。
 * - deepseek：thinking.type enabled/disabled + reasoning_effort（low/high/max）；
 *   medium 不下发 effort 落厂商默认。带 tools 的请求须把历史里的 reasoning_content
 *   原样回传，否则下一轮 400 —— 回传由 Agent 消息装配负责（requiresReasoningThread），
 *   本模块只管请求字段。
 * - 其它厂商：没有该参数。显式选了档位也只给 note 不注入——宁缺毋滥，不给严格
 *   服务端（OpenAI 会拒收未知字段）添麻烦。
 *
 * 档位语义是「努力程度」而非精确 token 数；default 表示不下发、跟随厂商默认。
 */

/** 统一档位：default = 不下发（跟随厂商默认），off = 显式关思考，low/medium/high = 开思考并给力度 */
export const THINKING_EFFORTS = ["default", "off", "low", "medium", "high"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/** 解析环境变量/接口输入；只认列出的字面量，其余一律落回 default（不猜测、不告警刷屏） */
export function parseThinkingEffort(raw: string | undefined | null): ThinkingEffort {
  const value = raw?.trim().toLowerCase();
  return (THINKING_EFFORTS as readonly string[]).includes(value ?? "") ? (value as ThinkingEffort) : "default";
}

export type ThinkingVendor = "qwen" | "glm" | "deepseek" | "none";

export function thinkingVendorFor(model: string): ThinkingVendor {
  if (/qwen/i.test(model)) return "qwen";
  if (/glm/i.test(model)) return "glm";
  if (/deepseek/i.test(model)) return "deepseek";
  return "none";
}

/** 哪些厂商要求把 reasoning_content 回传进后续请求（DeepSeek 思考模式带 tools 时强制，缺席 400） */
export function requiresReasoningThread(model: string): boolean {
  return thinkingVendorFor(model) === "deepseek";
}

/** GLM-5.3 起思考不可关闭（官方文档：thinking.type 传 disabled 直接报错） */
function glmCannotDisable(model: string): boolean {
  return /glm-5\.3/i.test(model);
}

/** qwen 思考预算档位：DashScope thinking_budget 合法区间 1~32768（默认 4000） */
const QWEN_THINKING_BUDGETS: Record<Exclude<ThinkingEffort, "default" | "off">, number> = {
  low: 4096,
  medium: 16384,
  high: 32768,
};

/** 一次映射的结果：params 合入 chat.completions.create 请求体；档位无法按语义生效时给 note（调用方负责一次性告警） */
export interface ThinkingEffortPatch {
  params?: Record<string, unknown>;
  note?: string;
}

export function thinkingEffortPatch(
  model: string,
  effort: ThinkingEffort | undefined,
  opts: { stream?: boolean } = {}
): ThinkingEffortPatch {
  if (effort === undefined || effort === "default") return {};
  const vendor = thinkingVendorFor(model);

  if (vendor === "none") {
    return { note: `模型 ${model} 所在服务商没有思考程度参数，档位 ${effort} 未下发` };
  }

  if (vendor === "qwen") {
    if (effort === "off") return { params: { enable_thinking: false } };
    if (opts.stream !== true) {
      return { note: "DashScope 思考模式仅流式输出可用，该思考档位本次未下发（开启流式后生效）" };
    }
    return { params: { enable_thinking: true, thinking_budget: QWEN_THINKING_BUDGETS[effort] } };
  }

  if (vendor === "glm") {
    if (effort === "off") {
      if (glmCannotDisable(model)) {
        return { note: `${model} 不支持关闭思考（GLM-5.3 起强制开启），off 档未下发` };
      }
      return { params: { thinking: { type: "disabled" } } };
    }
    // GLM 无预算参数，思考力度由模型动态决定：low/medium/high 都映射为开
    return { params: { thinking: { type: "enabled" } }, note: "GLM 思考只有开/关两档，low/medium/high 等价" };
  }

  // deepseek
  if (effort === "off") return { params: { thinking: { type: "disabled" } } };
  // reasoning_effort 只认 low/high/max：medium 不下发 effort，落厂商默认档
  const effortField = effort === "low" || effort === "high" ? { reasoning_effort: effort } : {};
  return {
    params: { thinking: { type: "enabled" }, ...effortField },
    ...(effort === "medium" ? { note: "deepseek 的 reasoning_effort 只有 low/high/max，medium 落厂商默认档" } : {}),
  };
}
