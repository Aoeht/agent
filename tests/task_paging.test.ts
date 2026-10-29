import { describe, expect, test } from "bun:test";
import { readTaskStatePage } from "../src/core/task_paging";
import { TaskSchema } from "../src/core/task_types";

const at = "2026-10-01T00:00:00.000Z";
function task(runCount: number, actionCount: number) {
  return TaskSchema.parse({
    id: "task", goal: "目标", createdAt: at, updatedAt: at, state: "running",
    plan: [], criteria: [], verification: { status: "not_configured", checks: [] },
    runs: Array.from({ length: runCount }, (_, i) => ({ id: `r${i}`, input: `指令${i}`, startedAt: at })),
    actions: Array.from({ length: actionCount }, (_, i) => ({
      id: `a${i}`, runId: "r0", tool: "write", arguments: "{}", needsReconciliation: false, state: "returned", startedAt: at,
    })),
  });
}

describe("task state paging", () => {
  test("runs 短、actions 长时各自续页，短的一侧不再交空页", () => {
    const record = task(2, 25);
    const first = readTaskStatePage(record, { offset: 0, limit: 10 });
    expect(first.runs.map((run) => run.id)).toEqual(["r0", "r1"]);
    expect(first.nextRunsOffset).toBeNull();
    expect(first.actions).toHaveLength(10);
    expect(first.nextActionsOffset).toBe(10);

    const second = readTaskStatePage(record, { offset: 0, actionsOffset: first.nextActionsOffset!, limit: 10 });
    expect(second.runs.map((run) => run.id)).toEqual(["r0", "r1"]);
    expect(second.actions[0]?.id).toBe("a10");
    expect(second.nextActionsOffset).toBe(20);

    const last = readTaskStatePage(record, { offset: 0, actionsOffset: 20, limit: 10 });
    expect(last.actions.map((action) => action.id)).toEqual(["a20", "a21", "a22", "a23", "a24"]);
    expect(last.nextActionsOffset).toBeNull();
  });

  test("单侧游标不影响另一侧；越界返回空页并标明已到头", () => {
    const record = task(3, 3);
    const page = readTaskStatePage(record, { offset: 0, runsOffset: 1, limit: 5 });
    expect(page.runs.map((run) => run.id)).toEqual(["r1", "r2"]);
    expect(page.actions).toHaveLength(3);
    expect(page.nextRunsOffset).toBeNull();
    expect(page.nextActionsOffset).toBeNull();

    const beyond = readTaskStatePage(record, { offset: 9, limit: 5 });
    expect(beyond.runs).toEqual([]);
    expect(beyond.actions).toEqual([]);
    expect(beyond.nextRunsOffset).toBeNull();
    expect(beyond.nextActionsOffset).toBeNull();
    expect(beyond.totalRuns).toBe(3);
    expect(beyond.totalActions).toBe(3);
  });
});
