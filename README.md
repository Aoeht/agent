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

任务结束时服务器会主动广播完成通知：成功、非零退出、超时、被终止都算。不管你正在哪个会话，右下角都会弹出卡片（脚本、结论、耗时、来源会话），可"查看任务"或"去会话"跳回发起它的对话，12 秒无操作自动收起。

页头 **⏪ 检查点** 是 `/rewind` 的可视化入口：列出本会话每个回合开始前的工作区快照，选中后按"只恢复代码 / 只恢复对话 / 两者"回滚。回合进行中不能回滚；含对话的回滚会在下一轮生效，并让同会话的其它标签页自动重拉历史。

页头 **🧩 MCP 目录** 浏览已挂载 MCP server 的资源和提示模板：选中资源看预览后"注入下一轮"（内容包在不可信围栏里只喂一轮），选模板填参数后"载入"。终端里等价命令是 `/resources [serverId]`、`/resource <serverId:name|uri>`、`/prompts`、`/prompt <serverId:name> [JSON]`。

页头 **🕘 运行轨迹** 把 `.traces/<会话>-<时间>.jsonl` 变成可读时间轴：每个回合、每步决策、每次工具调用（含心跳）与压缩/重试都在上面，点事件展开原始 JSON。默认隐藏工具心跳，长回合进行中每 2s 自动续拉；超长字段已由服务端截断，完整内容仍在 `.traces/` 文件里。委派与团队的子 Agent 轨迹各自落盘在会话目录，不在这份时间轴里。

页头 **模型供应商** 添加任意 OpenAI 兼容的聊天 API（名称、baseURL、API Key、模型 ID），保存后模型立刻进模型下拉列表（内部记作 `<供应商id>::<模型>`，请求按模型路由到对应端点与密钥）。每个模型后面有显示开关：关掉只把它从下拉和"手动探测"清单里剔除，已选用该模型的会话照常工作。密钥只写进服务器本地 `providers.json`（0600），位置由 `AGENT_DATA_DIR` 决定、缺省锚在仓库根的 `.agent-data/`——不跟启动目录变化，从别处起服务读的也是同一份；起服务时日志会打印实际路径与条数（`📦 [UI] 供应商配置: …`），文件被手改坏（含记事本存的 UTF-8 BOM）时报错点名路径，模型下拉退回配置项继续可用。

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
| `bili_collect` | 读视频快照做诈骗证据预处理（窗口/命中评论/链接） | 本地有快照 |
| `bili_pull` | 从采集服务器拉取视频快照到本地数据集 | `BILI_HUB_URL`（+`BILI_HUB_TOKEN`） |
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
bun run rag:embed                 # 为存量语料或新 embedding 配置补建文档向量
bun run trace:report               # 聚合 .traces/：缓存命中、成本分布、工具错误率
bun run eval:memory                # 记忆召回检索变体对照（零调用）
bun run eval:scanner --self-check  # 诈骗扫描评测自检（零调用）
```

配置 embedding 后，本地文件、案例采集和联网结果在入库时生成文档向量；检索只编码查询。升级已有知识库或更换 embedding 配置后，先运行 `bun run rag:embed` 补齐向量。缺失向量不会在查询时自动补算，仍可通过关键词召回。入库向量化失败会保留正文，重跑导入或补建命令即可恢复。JSON 后端使用单个入库进程，多进程并发导入请选择 PostgreSQL。

长期记忆支持候选召回后的关系判定（重复 / 补充 / 更新 / 冲突），明确更新以原子提交保留新旧版本，未确认冲突不注入有效记忆。可通过 `memory action=conflicts` 查看待确认提案，确认后用 `resolve` 处理；详见 [长期记忆演进](benchmarks/memory_recall/evolution.md)。

REPL 与 Web 共用同一套斜杠命令：`/help` `/model` `/prompts` `/prompt` `/rewind` `/task*` `/tokens`。

## 配置

全部环境变量在 [`src/config.ts`](src/config.ts) 顶部有注释清单。常用的：

| 变量 | 默认 | 作用 |
|---|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | 模型服务凭证（必填） |
| `AGENT_MODEL` | `deepseek-v4.1-flash-1017` | 主模型 |
| `AGENT_SUMMARY_MODEL` | `qwen3.6-plus` | 压缩 / 命名 / 记忆提取用的摘要模型 |
| `AGENT_MAX_TOTAL_TOKENS` | `500000` | 单次运行的 token 预算 |
| `AGENT_MAX_TOOL_CALLS` | `40` | 单次运行的工具调用上限 |
| `AGENT_THINKING_EFFORT` | `default` | `off`/`low`/`medium`/`high` |
| `AGENT_SANDBOX` | `auto` | 脚本执行后端：`host`/`docker`/`auto` |
| `AGENT_MEMORY_DIR` | `.agent-memory` | 跨会话记忆目录 |
| `AGENT_TRACE_DIR` | `.traces` | 运行轨迹目录 |
| `AGENT_JOB_DIR` | `.agent-data/jobs` | 后台脚本任务目录（任务 JSON + stdout/stderr 日志） |
| `AGENT_DATA_DIR` | 仓库根 `.agent-data` | 模型供应商配置目录（`providers.json`），锚在代码目录、不随启动目录变化 |
| `AGENT_DELEGATE` / `AGENT_TEAM_TOOL` | `on` / `on` | 主对话内子代理：`delegate_task` 与重 DAG `team_task`，可分别关闭 |
| `AGENT_UI_PORT` / `AGENT_UI_TOKEN` | `8787` / — | Web 服务器端口与访问口令 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | — | 向量检索；不配则只用关键词召回 |
| `BILI_HUB_URL` / `BILI_HUB_TOKEN` | — / — | 采集服务器地址与可选 Bearer 口令，`bili_pull` 用 |
| `BILI_DATASET_DIR` | `dataset` | 视频快照目录，`bili_pull` 写入、`bili_collect` 读取 |

采集服务器侧的只读 Hub 参考实现见 [`server/bili_hub_api.py`](server/bili_hub_api.py)：直接读采集 sqlite，
按 `bili-snapshot/v1` 提供列表与单视频快照，默认只监听 `127.0.0.1:8765` 并要求 Bearer 口令。

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
