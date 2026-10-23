# 子 Agent 运行时：第一版

这一版由宿主协调层直接创建和管理子 Agent。协调模型通过 JSON 计划描述任务，调度器调用 `new Agent()` 和 `Agent.run()`；没有注册 `spawn_agent`、`delegate_task` 等工具。

## 使用

沿用项目的 `.env` 模型配置和 MCP 工作区配置，在项目根目录运行：

```powershell
bun run team "阅读工作区代码，分析任务生命周期实现，再核对失败恢复的边界"
```

也支持管道输入和帮助：

```powershell
"对比工作区中的两份方案，列出差异和缺失信息" | bun run team
bun run team --help
```

终端打印任务启动、结束及汇总状态。按 Ctrl+C 取消整个运行；取消信号传给规划、汇总和所有已经启动的子 Agent，等待它们清理后退出。默认整个协调运行最多 10 分钟，不包含启动 MCP 服务的时间。

模型接口需要支持 OpenAI 兼容的 Chat Completions、JSON object 输出和普通工具调用。规划或汇总被拒绝、截断、格式不合法时会明确失败，不会把残缺计划当作可执行任务。

第一版入口是独立的一次性 CLI；原有单 Agent CLI 和 Web UI 保持现有行为，尚未增加 Web UI 团队任务面板。

## 执行流程

```text
用户目标
  → TeamCoordinator：规划（JSON，无 tools 参数）
  → 校验任务数量、角色、ID 和完整依赖图
  → AgentScheduler：为就绪任务预留预算、分配并发槽位
      → Agent A：独立上下文、工具注册表、计划和任务账本
      → Agent B：独立上下文、工具注册表、计划和任务账本
      → Agent C：等待指定依赖成功回答后再执行
  → TeamCoordinator：汇总所有状态和结论（无 tools 参数）
```

计划格式：

```json
{
  "tasks": [
    { "id": "collect", "role": "researcher", "goal": "收集相关实现与出处", "dependsOn": [] },
    { "id": "review", "role": "reviewer", "goal": "核对结论和缺失证据", "dependsOn": ["collect"] }
  ]
}
```

角色可以是 `researcher`、`analyst`、`reviewer`。角色描述任务分工，不授予额外权限。任务 ID 必须是小写字母开头的字母、数字、下划线或连字符，最多 40 字符。未知字段、重复 ID、不存在的依赖、自依赖、循环依赖和超量任务都会在创建子 Agent 前被拒绝。

调度器在任一子任务结束后立即复用空闲槽位。任务失败或被拒绝后，其下游标为 `skipped`，其他独立分支继续；父任务取消后不再启动新任务。

## 隔离与权限

每次子任务创建全新的 Agent、ToolRegistry、PlanStore 和 TaskStore。原始用户目标、分配的任务说明和直接依赖的结论进入子任务上下文；依赖结论使用不可信数据围栏，单条结论最多注入 6000 字符，并附有限数量的来源引用。完整工具历史留在各自轨迹中。

子任务之间共享底层模型客户端和 MCP 连接，但不共享对话历史、计划或任务控制器。MCP 的路径守卫和策略仍然生效。

宿主明确允许以下能力：

- 已挂载的 `search_web`、`rag_search`、`git_tree`、`read_image`。
- `filesystem` 的文本读取、批量读取、目录列举、目录树、文件搜索、文件信息和允许目录查询。
- 每个子 Agent 自己的 `update_plan`、`read_task_state`。

没有文件修改、脚本执行、浏览器操作、技能执行、外部消息发送或继续派生 Agent 的能力。只读指业务能力；运行记录、任务账本及检索缓存仍会写入本地。MCP 工具声明自己可并行或只读，不会自动获得白名单权限。

第一版不转接交互式追问和审批，MCP 策略要求审批的调用仍会被拒绝。模型缺少资料时应报告限制；写代码或其他超出能力的目标只能得到分析方案，不能当作已经完成实际修改。

## 配置和预算

团队运行沿用 `AGENT_MODEL`、`AGENT_SUMMARY_MODEL` 和温度。子任务最多 24 次迭代；如果 `AGENT_MAX_ITERATIONS` 设置了更小的正数，则使用更小的值。团队预算使用以下独立配置，不继承单 Agent 的 token/工具次数配置：

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `AGENT_TEAM_CONCURRENCY` | 2 | 同时运行的子 Agent 数量，范围 1–8 |
| `AGENT_TEAM_MAX_TASKS` | 6 | 计划最大任务数，范围 1–8 |
| `AGENT_TEAM_TOTAL_TOKENS` | 150000 | 团队 token 预算 |
| `AGENT_TEAM_CHILD_TOKENS` | 24000 | 每个子任务启动前预留的 token 配额 |
| `AGENT_TEAM_CHILD_TOOL_CALLS` | 20 | 每个子任务最多工具调用次数，范围 1–100 |
| `AGENT_TEAM_COORDINATION_TOKENS` | 18000 | 规划和汇总各自预留的 token 配额 |
| `AGENT_TEAM_TIMEOUT_MS` | 600000 | 协调运行超时，范围 1–3600000 毫秒 |

所有数值必须是正整数。总预算至少容纳一次规划、一次汇总和一个子任务。汇总配额在规划前预留，子任务不能借用；并发子任务先预留再执行，完成后按实际报告的消耗结算并退回未用额度。预算不足时先等待活动任务结算；仍不足则跳过待运行任务。

预算沿用现有 RunBudget 的逐请求/逐步骤检查语义，**不是模型服务账单的严格上限**：已发出的单次请求、上下文压缩和收尾可能越过配额；活动请求也不能撤销已产生的费用。协调调用使用模型 usage，缺失时估算并在结果中标记；传输错误导致费用未知时保守计入预留额度。子 Agent 消耗沿用现有 AgentResult 的 usage 记账。第一版不允许子任务自行申请追加额度。

## 结果、记录与边界

默认保存到 `.agent-sessions/teams/<runId>/`，设置 `AGENT_SESSION_DIR` 可更改存储根目录：

```text
events.jsonl       团队启动、完整计划、子任务状态变化、汇总和终态
result.json        团队最终报告、所有子任务结论、来源、状态、累计 token
tasks/<id>.sqlite  每个子 Agent 的独立任务与工具执行账本
traces/           每个子 Agent 的模型步骤、工具记录和运行结果
```

`parentRunId` 将子任务关联到团队运行，子任务记录还保存自身 Agent 的 taskId/runId。团队事件逐条落盘；事件记录失败会告警，最终报告写入失败会以错误退出。记录可能包含用户资料，不应提交到代码仓库；默认目录已在 `.gitignore` 中。

团队终态：

- `answered`：所有子任务给出了完整回答，汇总也成功。只代表回答完成，**不代表独立验收通过**。
- `incomplete`：部分任务失败、跳过、超时、超预算，或最终汇总失败。已获得的子任务结论仍保留。
- `cancelled`：用户取消。
- `failed`：未能完成规划等启动阶段。

只有 `answered` 退出码为 0；取消为 130；其他未完整结束的情况为 1。汇总模型即使声称全部完成，也不能覆盖调度器记录的失败状态。数字引用编号属于各子任务，最终汇总要求使用真实 URL/文件路径，避免把不同子任务的 `[1]` 混为同一来源。

这一版支持固定计划和有向无环依赖，不支持执行中重规划、跨 Agent 实时消息、持久运行恢复、跨进程工作节点或 A2A。运行记录可供复盘，重新执行命令会开始新团队，不会自动恢复旧团队。

## 代码与验证

- `src/core/team_coordinator.ts`：模型规划、结果汇总、团队级超时、预算和事件。
- `src/core/team_scheduler.ts`：DAG 校验、预算预留、调度和子任务生命周期。
- `src/team_runtime.ts`：工具白名单、子 Agent 装配、团队环境变量。
- `src/team.ts`：一次性 CLI、信号处理和运行记录。
- `tests/team.test.ts`：调度并发、依赖失败、取消、预算、协议错误、隔离和真实 Agent 循环的假模型测试。

```powershell
bun test tests/team.test.ts
bun run typecheck
```

测试使用假模型，不会向模型服务发送请求。
