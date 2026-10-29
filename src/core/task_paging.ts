import type { TaskRecord } from "./task_types";

export interface TaskStatePageRequest {
  /** runs 与 actions 的默认起点；两侧都较长时可用下面的专用游标分别续页 */
  offset: number;
  limit: number;
  runsOffset?: number;
  actionsOffset?: number;
}

/**
 * 任务历史分页。runs（每轮指令，通常几十条以内）与 actions（每次工具调用，动辄上百条）
 * 长度差一个数量级，共用一个 offset 时短的那侧会反复交出空页，也不方便只翻操作记录。
 * 两侧各走各的游标，缺省从同一个 offset 起步，返回各自的下一个位置（null 表示到头）。
 */
export function readTaskStatePage(task: TaskRecord, request: TaskStatePageRequest) {
  const runsOffset = request.runsOffset ?? request.offset;
  const actionsOffset = request.actionsOffset ?? request.offset;
  const runs = task.runs.slice(runsOffset, runsOffset + request.limit);
  const actions = task.actions.slice(actionsOffset, actionsOffset + request.limit);
  return {
    id: task.id, goal: task.goal, plan: task.plan, criteria: task.criteria, verification: task.verification,
    runs, actions,
    totalRuns: task.runs.length, totalActions: task.actions.length,
    nextRunsOffset: runsOffset + runs.length < task.runs.length ? runsOffset + runs.length : null,
    nextActionsOffset: actionsOffset + actions.length < task.actions.length ? actionsOffset + actions.length : null,
  };
}
