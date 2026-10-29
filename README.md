# ai_agent

[![CI](https://github.com/Aoeht/agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Aoeht/agent/actions/workflows/ci.yml)

自己写的通用 AI Agent 运行时，TypeScript + Bun，不依赖任何 agent 框架。同一套内核对外开三个入口：终端 REPL、Web UI、多 Agent 团队 CLI。

能联网搜索、在沙箱里读写文件和执行脚本、挂 MCP 外部工具、检索本地知识库、跨会话记住事情，并把子任务委派给只读子 Agent 独立复核。

## 准备

- [Bun](https://bun.sh)（安装与运行都用它）
- 一个 OpenAI 兼容的模型服务（地址 + Key）
- 可选：`docker`（脚本沙箱隔离）、`TAVILY_API_KEY`（联网搜索）、embedding 服务（向量检索）

```bash
bun install
```

项目根目录建 `.env`：

```bash
OPENAI_API_KEY=sk-xxxx
OPENAI_BASE_URL=https://api.deepseek.com/v1
TAVILY_API_KEY=tvly-xxxx          # 可选，联网搜索用
```

## 三种用法

**终端**——最直接的一个：

```bash
bun run src/index.ts
```

启动后列出已有会话，可续聊或新建；历史存在 `.agent-sessions/`，重启仍带着上文。单次任务：

```bash
echo "把 src/tools 下的工具列个清单" | bun run src/index.ts
```

**Web UI**——多会话并行、工具审批弹窗、计划面板：

```bash
cd web && bun install && bun run build && cd ..
bun run src/server/main.ts          # 默认 http://127.0.0.1:8787
```

服务器默认只绑回环地址；绑非回环地址又没设 `AGENT_UI_TOKEN`（≥32 字符）会拒绝启动。开发时改跑 `cd web && bun run dev`（Vite 5173，已代理到 8787）。

后台跑的任务在页头 **🖥️ 后台任务** 里看：任务列表、运行时长、退出码，stdout/stderr 按 900ms 增量尾随（等同 `tail -f`），运行中的任务可直接终止——不用回对话里轮询 `job_output`。

页头 **⏪ 检查点** 是 `/rewind` 的可视化入口：列出本会话每个回合开始前的工作区快照，选中后按"只恢复代码 / 只恢复对话 / 两者"回滚。回合进行中不能回滚；含对话的回滚会在下一轮生效，并让同会话的其它标签页自动重拉历史。

页头 **🧩 MCP 目录** 浏览已挂载 MCP server 的资源和提示模板：选中资源看预览后"注入下一轮"（内容包在不可信围栏里只喂一轮），选模板填参数后"载入"。终端里等价命令是 `/resources [serverId]`、`/resource <serverId:name|uri>`、`/prompts`、`/prompt <serverId:name> [JSON]`。

**团队**——多个子 Agent 并发干活，再独立复核：

```bash
bun run team "分析工作区代码并复核结论"
```

## 内置工具

| 工具 | 作用 | 需要 |
|---|---|---|
| `search_web` | 联网搜索 | `TAVILY_API_KEY` |
| `inspect_link` | 核查可疑链接，必要时起真实浏览器取证 | — |
| `rag_search` | 本地知识库混合检索（BM25 + 向量） | 先导入语料 |
| `run_script` | 在沙箱内执行脚本（`background:true` 可后台跑长任务） | docker 可选 |
| `job_output` | 查看后台任务状态与日志尾部 | 配合后台 `run_script` |
| `git_tree` | 只读查看仓库结构 | — |
| `read_image` | 读图交给多模态模型 | — |
| `memory` | 跨会话记忆读写 | — |
| `load_skill` | 按需加载技能正文 | 装了技能才有 |
| `delegate_task` | 委派只读子 Agent | — |
| `ask_user` | 向人提问并等待回答 | — |
| `update_plan` / `read_task_state` / `set_acceptance_criteria` | 计划与验收条件 | — |
| `filesystem__*` | 来自 MCP filesystem server 的文件读写 | 限沙箱根内 |

## 常用命令

```bash
bun run typecheck                  # 类型检查
bun test                           # 全量测试
cd web && bun run typecheck        # 前端类型检查（独立 tsconfig）

bun run rag:ingest --sync <路径>   # 导入知识库语料
bun run trace:report               # 聚合 .traces/：缓存命中、成本分布、工具错误率
bun run eval:memory                # 记忆召回检索变体对照（零调用）
bun run eval:scanner --self-check  # 诈骗扫描评测自检（零调用）
```

REPL 与 Web 共用同一套斜杠命令：`/help` `/model` `/prompts` `/prompt` `/rewind` `/task*` `/tokens`。

## 配置

全部环境变量在 [`src/config.ts`](src/config.ts) 顶部有注释清单。常用的：

| 变量 | 默认 | 作用 |
|---|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | 模型服务凭证（必填） |
| `AGENT_MODEL` | `glm-5.2` | 主模型 |
| `AGENT_SUMMARY_MODEL` | `qwen3.6-plus` | 压缩 / 命名 / 记忆提取用的摘要模型 |
| `AGENT_MAX_TOTAL_TOKENS` | `500000` | 单次运行的 token 预算 |
| `AGENT_MAX_TOOL_CALLS` | `40` | 单次运行的工具调用上限 |
| `AGENT_THINKING_EFFORT` | `default` | `off`/`low`/`medium`/`high` |
| `AGENT_SANDBOX` | `auto` | 脚本执行后端：`host`/`docker`/`auto` |
| `AGENT_MEMORY_DIR` | `.agent-memory` | 跨会话记忆目录 |
| `AGENT_TRACE_DIR` | `.traces` | 运行轨迹目录 |
| `AGENT_JOB_DIR` | `.agent-data/jobs` | 后台脚本任务目录（任务 JSON + stdout/stderr 日志） |
| `AGENT_DELEGATE` / `AGENT_TEAM_TOOL` | `on` / `on` | 主对话内子代理：`delegate_task` 与重 DAG `team_task`，可分别关闭 |
| `AGENT_UI_PORT` / `AGENT_UI_TOKEN` | `8787` / — | Web 服务器端口与访问口令 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | — | 向量检索；不配则只用关键词召回 |

MCP 服务器 = 内置默认（`src/mcp/config.ts`）⊕ 项目根 `.mcp.json`（`AGENT_MCP_CONFIG` 可改路径），改文件无需重启。

## 开发

```bash
bun run typecheck && (cd web && bun run typecheck) && bun test
```

`bun test` 在同进程内并发跑所有测试文件，`process.env` 是共享的——需要改环境变量的用例要放在无 `await` 的同步块里或给被测函数注入配置；异步收尾一律轮询等条件，不要固定 `sleep`。

## 说明

- 会话、记忆、轨迹、沙箱产物都落在项目根下并被 `.gitignore` 排除，仓库里不含任何对话数据。
- 技能是可选的：`.agents/skills/` 不存在时行为与未开启技能完全一致（不注册 `load_skill`）。
- `benchmarks/` 下的评测脚本不进 CI，部分需要付费 API 或未入库的数据集。
