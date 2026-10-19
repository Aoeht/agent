// web/src/components/PlanPanel.tsx
import type { PlanStep } from "@protocol";

function StepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "completed") {
    return (
      <span className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-sage-500 text-[10px] font-bold text-cream-50">
        ✓
      </span>
    );
  }
  if (status === "in_progress") {
    return <span className="mt-1 inline-block h-3 w-3 shrink-0 animate-pulse rounded-full bg-clay-500" />;
  }
  return <span className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border-2 border-cream-400" />;
}

export function PlanPanel({ plan }: { plan: PlanStep[] }) {
  if (plan.length === 0) {
    return (
      <p className="text-xs leading-5 text-ink-400">
        本回合还没有生成任务计划。Agent 处理多步任务时会在这里实时展示进度。
      </p>
    );
  }
  const completed = plan.filter((s) => s.status === "completed").length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream-200">
          <div
            className="h-full rounded-full bg-clay-500 transition-all duration-500"
            style={{ width: `${(completed / plan.length) * 100}%` }}
          />
        </div>
        <span className="ml-3 shrink-0 text-xs text-ink-400">
          {completed}/{plan.length}
        </span>
      </div>
      <ol className="space-y-2">
        {plan.map((step, i) => (
          <li key={i} className="flex items-start gap-2 text-sm leading-6">
            <StepIcon status={step.status} />
            <span className={step.status === "completed" ? "text-ink-400 line-through" : ""}>
              {step.content}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
