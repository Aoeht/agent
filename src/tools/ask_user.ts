// src/tools/ask_user.ts
import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";

const AskUserParamsSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "question 不能为空")
    .max(500)
    .describe(
      "要向用户澄清的问题：一句话、具体、给出可选的回答方向，不要问能自己查到的信息"
    ),
});

export type AskUserParams = z.output<typeof AskUserParamsSchema>;

/**
 * 模型发起的主动澄清工具：任务信息确实缺失且无法从工具/环境获得时，
 * 向用户征询一段自由文本回答。
 *
 * 交互通道走 ToolRuntime.askUser（与审批语义的 requestHuman 分开）：
 * - CLI REPL：readline 自由输入；
 * - Web UI：human_input_request 事件 → 输入框模态；
 * - 非交互模式（oneshot/脚本）：没有通道 → 返回可读错误，模型自行降级，
 *   绝不中断回合。
 */
export function createAskUserTool(): ToolDefinition {
  return defineTool({
    name: "ask_user",
    schema: AskUserParamsSchema,
    // 阻塞等待用户输入，不允许与同批工具并发
    parallelSafe: false,
    // 只是问一句话，中断后外部世界没有任何变化
    needsReconciliation: false,
    description:
      "向用户提出一个问题并等待一段自由文本回答（主动澄清）。" +
      "仅在任务信息确实缺失、缺了它无法正确继续、且靠搜索/现有工具查不到时使用；" +
      "同时问清楚一个问题，附上回答方向或可选项。用户可能拒绝回答（返回 null），" +
      "此时据已掌握的信息给出最佳判断继续，不要重复追问。",
    execute: async (params: AskUserParams, runtime) => {
      const prompt = params.question.trim();
      if (!runtime?.askUser) {
        return {
          ok: false,
          error: "当前运行环境不支持人工澄清（非交互模式），请依据已有信息自行判断并继续。",
          answer: null,
        };
      }
      try {
        const answer = await runtime.askUser(prompt, runtime.signal ?? new AbortController().signal);
        return { ok: true, answer };
      } catch (error) {
        return {
          ok: false,
          error: `澄清通道异常：${error instanceof Error ? error.message : String(error)}`,
          answer: null,
        };
      }
    },
  });
}