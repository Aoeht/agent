// src/tools/update_plan.ts
import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";
import { PlanStore } from "../core/plan_store";

const UpdatePlanParamsSchema = z.object({
  steps: z
    .array(
      z.object({
        content: z
          .string()
          .trim()
          .min(1, "content 不能为空")
          .max(500)
          .describe("这一步要做什么：一句话、可执行、带完成判据，不要写\"继续\"这类空步骤"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .default("pending")
          .describe("pending=待执行，in_progress=进行中，completed=已完成"),
      })
    )
    .min(1, "steps 至少一步")
    .max(20, "steps 最多 20 步")
    .describe("完整计划清单：每次调用都提交全量清单（替换旧计划），不要只发变化的步骤"),
});

export type UpdatePlanParams = z.output<typeof UpdatePlanParamsSchema>;

/**
 * 计划工具的工厂：状态落在调用方持有的 PlanStore 里，
 * 本工具只做校验与写入；注入上下文、发事件、渲染都由 Agent 消费 dirty 标记完成。
 */
export function createUpdatePlanTool(store: PlanStore): ToolDefinition {
  return defineTool({
    name: "update_plan",
    schema: UpdatePlanParamsSchema,
    // 写共享状态且结果决定"下一步做什么"，不允许与同批工具并发
    parallelSafe: false,
    // 只改任务账本里的计划，不动用户工作区，中断后无需人工核对
    needsReconciliation: false,
    description:
      "创建或更新当前任务的结构化执行计划（步骤清单 + 状态）。" +
      "多步任务（预计 3 次以上工具调用或分多个阶段）开始时先调用它列出计划，再按计划逐步执行；" +
      "每完成一步就更新一次状态，计划需要调整时随时修订。" +
      "注意：每次调用提交完整清单（全量替换）；同一时刻至多一个步骤 in_progress；" +
      "一两次工具调用就能完成的简单任务不要使用本工具。",
    execute: async (params: UpdatePlanParams) => {
      const inProgress = params.steps.filter((s) => s.status === "in_progress");
      if (inProgress.length > 1) {
        throw new Error(
          `至多一个步骤可以处于 in_progress，当前有 ${inProgress.length} 个：` +
            inProgress.map((s) => `"${s.content.slice(0, 30)}"`).join("、") +
            "。请把其余步骤改为 pending 或 completed 后重新提交完整清单。"
        );
      }
      store.replace(params.steps);
      const completed = params.steps.filter((s) => s.status === "completed").length;
      return {
        ok: true,
        total: params.steps.length,
        completed,
        ...(inProgress.length === 1 ? { current: inProgress[0]!.content } : {}),
        /** 完整计划以随后的【当前任务计划】上下文块为准，回执只带进度概要 */
        progress: `${completed}/${params.steps.length}`,
      };
    },
  });
}
