// src/tools/memory.ts
import { z } from "zod";
import { defineTool } from "../core/types";
import { MemoryStore } from "../core/memory_store";

/**
 * 跨会话记忆工具：模型自管的全局语义记忆（user/feedback/project/reference 四类）。
 * 写入纪律放在 description 里（Claude Code auto memory 的判断标准）：
 * 记「未来会话用得上且无法从代码/会话历史推导」的事实，不记一次性对话细节。
 * 记忆内容每次 run 以【长期记忆】块注入，forget/update 时模型凭索引里的条目 id 操作。
 */
export function createMemoryTool(store: MemoryStore) {
  return defineTool({
    name: "memory",
    description:
      "读写跨会话长期记忆。什么值得记：用户明确要求“记住”；用户纠正了你的做法（feedback）；" +
      "从代码、git 历史或当前对话之外才能知道的项目事实与偏好；外部资源的位置。" +
      "什么不记：能从代码推导的架构与路径、一次性对话细节、当前任务的临时状态。" +
      "每次对话开始时已注入记忆索引（含条目 id），先用 action=read 可看到全部条目；" +
      "写入时用一句完整、自包含的事实陈述，不要写“参见之前”这类依赖上下文的话；" +
      "信息变化时先 forget 旧条目再 add 新条目（旧条目保留痕迹，不静默覆盖）。",
    schema: z.object({
      action: z
        .enum(["read", "add", "forget", "update"])
        .describe("read=查看当前记忆索引；add=新增一条；forget=作废一条（信息不再成立）；update=修改一条的正文"),
      type: z
        .enum(["user", "feedback", "project", "reference"])
        .optional()
        .describe("add 时必填。user=用户偏好；feedback=纠正与有效做法；project=项目事实与决策；reference=外部资源位置"),
      text: z.string().trim().min(1).optional().describe("add/update 时必填：记忆正文，一句自包含的事实"),
      id: z.string().trim().min(1).optional().describe("forget/update 时必填：记忆条目 id（索引 [ ] 里的 m-… 编号）"),
    }),
    needsReconciliation: false, // 只写自有记忆仓，幂等且不影响外部世界
    execute: async (args) => {
      if (args.action === "read") {
        const active = await store.active();
        return {
          status: "ok" as const,
          total: active.length,
          index: (await store.loadIndex()) || "（暂无跨会话记忆）",
        };
      }
      if (args.action === "add") {
        if (!args.type || !args.text) {
          throw new Error("add 需要 type 与 text 两个字段");
        }
        const entry = await store.add({ type: args.type, text: args.text });
        if (!entry) {
          return { status: "duplicate" as const, message: "同类型同文本的生效记忆已存在，未重复记录" };
        }
        return { status: "ok" as const, id: entry.id, type: entry.type, text: entry.text };
      }
      if (args.action === "forget") {
        if (!args.id) throw new Error("forget 需要 id 字段（先 read 查看条目 id）");
        const ok = await store.forget(args.id);
        if (!ok) throw new Error(`记忆条目 ${args.id} 不存在或已作废`);
        return { status: "ok" as const, id: args.id, message: "已作废该记忆（保留痕迹，可追溯）" };
      }
      // update
      if (!args.id || !args.text) throw new Error("update 需要 id 与 text 两个字段");
      const updated = await store.update(args.id, args.text);
      if (!updated) throw new Error(`记忆条目 ${args.id} 不存在或已作废`);
      return { status: "ok" as const, id: updated.id, text: updated.text };
    },
  });
}
