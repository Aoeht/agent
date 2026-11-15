# A2A ↔ LangGraph 互操作实验场

ai_agent 的 A2A 接口（TS 手写实现，`src/a2a/`）与 LangGraph 生态（a2a-sdk 1.3.0 + 本地源码 `A:\Langchain\repos\langgraph` 1.2.19）的双向互通验证。

```
方向①（TS → Python）   scripts/a2a_probe.ts ──SendMessage/SSE──▶ agent_server.py（LangGraph agent）
方向②（Python → TS）   client_to_ai_agent.py ──SendMessage/SSE──▶ ai_agent（src/server/main.ts, :8787）
```

两个方向的报文都是 **A2A v1.0** JSON-RPC（PascalCase 方法名、Part 成员名 oneof、
`A2A-Version: 1.0` 头、流式事件 `{task|statusUpdate|artifactUpdate}`、终态关流）。

## 准备

```bash
# 虚拟环境（依赖含本地源码路径依赖，见 pyproject.toml）
uv sync
```

凭据：真模型模式读仓库根 `../../.env` 的 `DASHSCOPE_API_KEY`（DashScope compatible-mode）。
配额失败时用 `LANGGRAPH_FAKE=1` 走无 LLM 确定性图。

## 方向①：ai_agent 客户端 → LangGraph 服务端

```bash
# 1. 起 LangGraph A2A 服务端（:41241）
uv run agent_server.py                 # 真模型
LANGGRAPH_FAKE=1 uv run agent_server.py  # 无 LLM 兜底

# 2. ai_agent 侧探针（发现名片 → 流式发消息）
bun run scripts/a2a_probe.ts http://127.0.0.1:41241 --message "上海今天天气怎么样？"
```

预期：探针打出名片（skills: weather-query）、流事件 `[task] → [status] TASK_STATE_WORKING →
[artifact] → [status] TASK_STATE_COMPLETED`，终态 artifact 含天气回答
（真模型模式会先看到 `节点 agent · 调用工具 get_weather` 的进度摘要）。

## 方向②：a2a-sdk 客户端 → ai_agent 服务端

```bash
# 1. 起 ai_agent 服务端（:8787，A2A 端点默认关闭，需显式开）
AGENT_A2A_SERVER=1 bun run src/server/main.ts

# 2. a2a-sdk 客户端打进来
uv run client_to_ai_agent.py http://127.0.0.1:8787 --message "用一句话介绍你自己"
```

预期：拉到 ai_agent 名片（skills: general-assistant / evidence-research）、流事件
TASK_STATE_WORKING（带轮次/工具名进度）→ artifact（最终回答）→ TASK_STATE_COMPLETED。

## 方向③（可选）：完整 agent 链路内委派

让 ai_agent 的主对话通过 `a2a_call` 工具委派 LangGraph agent：

```bash
AGENT_A2A_AGENTS='[{"name":"weather","url":"http://127.0.0.1:41241"}]' \
AGENT_A2A_SERVER=1 bun run src/server/main.ts
# 再在 Web 工作台/CLI 里让它「用 a2a_call 问 weather：上海天气」——
# 返回值会带【不可信外部数据 · 来源：远端 Agent「weather」…】围栏
```

## 文件

| 文件 | 说明 |
|---|---|
| `agent_server.py` | LangGraph 测试 agent + a2a-sdk 服务端（DefaultRequestHandler + create_jsonrpc_routes） |
| `client_to_ai_agent.py` | a2a-sdk 客户端（ClientFactory 流式）打 ai_agent |
| `pyproject.toml` | uv 项目；langgraph/langgraph-prebuilt 用本地源码 file:// 依赖 |
