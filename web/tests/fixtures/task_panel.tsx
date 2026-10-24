import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../../src/state/store";
import { RightPanel } from "../../src/components/RightPanel";
import { MockTransport } from "../../src/lib/mock";
import type { ServerEvent } from "../../../src/server/protocol";
import type { TaskRecord } from "../../../src/core/task_types";

const initial: TaskRecord = {
  id: "persisted-task", goal: "生成并检查报告", state: "incomplete", createdAt: "2026-01-01", updatedAt: "2026-01-02",
  plan: [{ content: "修复报告正文", status: "pending" }],
  criteria: [{ kind: "text_contains", path: "report.txt", description: "报告正文", text: "结果" }],
  verification: { status: "failed", checks: [{ description: "报告正文", path: "report.txt", passed: false, detail: "文件不存在" }] },
  actions: [], runs: [{ id: "r1", input: "生成报告", startedAt: "2026-01-01", endedAt: "2026-01-02" }],
};
const summary = { sessionId: "persisted-session", messageCount: 0, lastUpdated: "2026-01-02", firstUserText: "生成报告" };
class FixtureTransport extends MockTransport {
  override async listSessions() { return [summary]; }
  override async openSession() {
    return { summary, messages: [], task: JSON.parse(localStorage.getItem("task") ?? JSON.stringify(initial)) };
  }
  override subscribe(_id: string, onEvent: (event: ServerEvent) => void) {
    (window as any).completeTask = () => {
      const task: TaskRecord = { ...initial, updatedAt: "2026-01-03", state: "completed",
        plan: [{ content: "修复报告正文", status: "completed" }],
        verification: { status: "passed", checks: [{ description: "报告正文", path: "report.txt", passed: true, detail: "文件实测符合条件" }] } };
      localStorage.setItem("task", JSON.stringify(task));
      onEvent({ type: "task_update", task });
    };
    return () => {};
  }
}
// store 不再自动选中会话：夹具里模拟用户点开这条持久化会话
function OpenPersisted() {
  const { actions } = useStore();
  useEffect(() => {
    actions.selectSession("persisted-session");
  }, [actions]);
  return null;
}
createRoot(document.getElementById("root")!).render(
  <StoreProvider transport={new FixtureTransport()}>
    <OpenPersisted />
    <RightPanel />
  </StoreProvider>
);
