import { z } from "zod";

const file = { path: z.string().trim().min(1).max(1000), description: z.string().trim().min(1).max(500) };
/** Read-only checks; never execute model-supplied verification programs. */
export const AcceptanceCriterionSchema = z.discriminatedUnion("kind", [
  z.object({ ...file, kind: z.literal("file_exists"), minBytes: z.number().int().min(1).max(5_000_000).default(1) }),
  z.object({ ...file, kind: z.literal("text_contains"), text: z.string().min(1).max(20_000) }),
  z.object({ ...file, kind: z.literal("json_equals"), keys: z.array(z.string().max(200)).max(20), expected: z.json() }),
  z.object({ ...file, kind: z.literal("sha256"), digest: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
]);
export const AcceptanceCriteriaSchema = z.array(AcceptanceCriterionSchema).min(1).max(20);
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export const VerificationSchema = z.object({
  status: z.enum(["not_configured", "pending", "passed", "failed"]),
  checkedAt: z.string().optional(),
  checks: z.array(z.object({ description: z.string(), path: z.string(), passed: z.boolean(), detail: z.string(), sha256: z.string().optional() })),
});
export type Verification = z.infer<typeof VerificationSchema>;
export const TaskSchema = z.object({
  id: z.string(), goal: z.string(), createdAt: z.string(), updatedAt: z.string(),
  state: z.enum(["running", "waiting_input", "waiting_approval", "answered", "completed", "incomplete", "blocked", "cancelled", "failed", "interrupted", "superseded"]),
  waiting: z.object({ kind: z.enum(["input", "approval"]), prompt: z.string() }).optional(),
  workspace: z.string().optional(),
  plan: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })),
  criteria: z.array(AcceptanceCriterionSchema),
  criteriaSource: z.enum(["host", "agent"]).optional(),
  verification: VerificationSchema,
  runs: z.array(z.object({ id: z.string(), input: z.string(), startedAt: z.string(), endedAt: z.string().optional(), stopReason: z.string().optional() })),
  actions: z.array(z.object({
    id: z.string(), runId: z.string(), tool: z.string(), arguments: z.string(),
    /**
     * started 已派发 / returned 拿到返回值 / no_effect 结果不可确认但该工具不产生需核对的外部影响
     * / unknown 结果不可确认且必须人工核对 / applied、not_applied 人工核对结论。
     */
    state: z.enum(["started", "returned", "unknown", "no_effect", "applied", "not_applied"]),
    /** 判定该工具是否可能影响真实世界；旧记录没有这个字段时按最保守的 true 解析 */
    needsReconciliation: z.boolean().default(true),
    startedAt: z.string(), endedAt: z.string().optional(), resultPreview: z.string().optional(),
    resolution: z.string().optional(),
  })),
  owner: z.object({ pid: z.number(), token: z.string() }).optional(),
  lastAnswer: z.string().nullable().optional(),
  stopReason: z.string().optional(),
});
export type TaskRecord = z.infer<typeof TaskSchema>;
export const TASK_STATE_LABELS: Record<TaskRecord["state"], string> = {
  running: "执行中", answered: "已回答，未验收", completed: "验收通过", incomplete: "未完成",
  waiting_input: "等待补充信息", waiting_approval: "等待人工确认",
  blocked: "受阻", cancelled: "已取消", failed: "执行失败", interrupted: "中断待核对", superseded: "已切换新任务",
};
