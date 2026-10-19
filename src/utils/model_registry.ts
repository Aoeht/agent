// src/utils/model_registry.ts
/**
 * 按模型名查上下文窗口（token）。压缩触发水位依赖它：写死 128k 在 32k 或 200k 模型上
 * 都会让阈值失真（前者永远不压缩直到 API 报错，后者过早压缩浪费上下文）。
 * 表只求"量级正确"；显式配置（AgentConfig.contextWindow）永远优先于查表。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

const MODEL_WINDOW_RULES: Array<{ match: RegExp; contextWindow: number }> = [
  { match: /gemini/i, contextWindow: 1_000_000 },
  { match: /gpt-4\.1|gpt-5/i, contextWindow: 400_000 },
  { match: /glm-4\.5|glm-4\.6|glm-5/i, contextWindow: 200_000 },
  { match: /claude/i, contextWindow: 200_000 },
  { match: /deepseek/i, contextWindow: 128_000 },
  { match: /qwen/i, contextWindow: 128_000 },
  { match: /kimi|moonshot/i, contextWindow: 128_000 },
  { match: /gpt-4o|o1|o3|o4/i, contextWindow: 128_000 },
  { match: /glm/i, contextWindow: 128_000 },
];

export function contextWindowFor(model: string): number {
  for (const rule of MODEL_WINDOW_RULES) {
    if (rule.match.test(model)) return rule.contextWindow;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
