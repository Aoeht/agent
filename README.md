# ai_agent

[![CI](https://github.com/Aoeht/agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Aoeht/agent/actions/workflows/ci.yml)

自己写的通用 AI Agent 运行时，TypeScript + Bun，不依赖任何 agent 框架。同一套内核对外开三个入口：终端 REPL、Web UI、团队 CLI。能联网搜索、在沙箱目录里读写文件、执行脚本、挂 MCP 外部工具服务器、检索本地知识库、跨会话记住事情，并把子任务委派给只读子 Agent 独立复核。

规模（2026-10-27）：`src/` 100 个文件 19.9k 行 TS，`web/` 27 个文件 3.7k 行，`tests/` 13.5k 行，`docs/` 24 篇 12.4k 行；`bun test` 494 通过 / 5 跳过 / 0 失败（499 例，70 个测试文件 = 根 63 + web 7）；根与 `web/` 两处 `tsc --noEmit` 均零报错；CI 在 ubuntu-latest 与 windows-latest 双平台跑。

## 先用起来

```bash
bun install
# 项目根新建 .env，至少填模型服务地址与 Key：
#   OPENAI_API_KEY=sk-xxxx
#   OPENAI_BASE_URL=https://api.deepseek.com/v1
#   TAVILY_API_KEY=tvly-xxxx   # 选填，联网搜索与链接核查需要
bun run src/index.ts           # 终端交互模式
```

在 `你>` 后面直接打字。启动时会列出已有会话让你续聊或新建，历史落盘在 `.agent-sessions/<sessionId>.jsonl`，重启进程后仍带着上文继续。

**Web UI**（另装一份依赖，`web/` 有独立 lockfile）：

```bash
cd web && bun install && bun run build && cd ..
bun run src/server/main.ts     # 默认 http://127.0.0.1:8787，静态托管 web/dist
# 开发时改跑 cd web && bun run dev（Vite 5173，代理已指向 8787）
```

服务器缺省只绑回环；绑非回环地址又没设 `AGENT_UI_TOKEN` 会直接拒绝启动。

技能是可选的：`.agents/skills/` 已 gitignore，克隆下来没有技能时行为与未开启技能完全一致（不注册 `load_skill`、提示词不变）。要用就照 `skills-lock.json` 里记的来源逐个 `bunx skills add <name>` 装回来。

**完整操作手册（推荐从这里开始）：[docs/使用说明书.md](docs/使用说明书.md)** —— 安装配置、全部功能用法、环境变量速查、常见任务、排错表。

## 常用命令

```bash
bun run src/index.ts                 # 终端交互模式
echo "任务" | bun run src/index.ts   # 单次模式（脚本 / CI）
bun run src/server/main.ts           # Web UI 服务器
bun run team "分析工作区代码并复核结论"  # 团队 CLI：多子 Agent 并发 + 独立复核

bun run typecheck                    # 根类型检查（改完必跑）
cd web && bun run typecheck          # 前端类型检查（独立 tsconfig，根查不到）
bun test                             # 全量测试（含 web/tests）

bun run rag:ingest --sync <路径>     # 导入知识库语料（加 --dry-run 先看要动什么）
bun run trace:report                 # 聚合 .traces/ 轨迹：缓存命中 / 成本分布 / 工具错误率
bun run eval:memory                  # 记忆召回对照评测（四种检索变体，缺省用合成向量，零调用）
bun run eval:scanner --self-check    # 诈骗扫描评测管道自检（零调用；--live 才真跑，要花钱）
```

## 三个入口，一套内核

`src/bootstrap.ts` 是唯一装配点：技能发现 → 沙箱解析 → 工具注册表 → MCP 挂载 → 记忆与检索 → 不可信上下文。三个入口都调它，差别只剩人工确认通道（终端逐个询问 vs Web 审批桥）和日志前缀，工具清单与策略语义永远一致。

| 入口 | 文件 | 独有能力 |
|---|---|---|
| 终端 REPL | `src/index.ts` | 会话选择菜单、启动时模型可用性探测、Ctrl+C 取消当前回合 |
| Web UI | `src/server/main.ts` + `web/` | 多会话并行、忙时消息排队、工具审批弹窗、计划面板、斜杠命令卡与回滚后历史重拉 |
| 团队 CLI | `src/team.ts` | 协调规划 → 并发子 Agent → 独立复核 → 最多两轮定向补查 → 汇总 |

REPL 与 Web 共用同一条斜杠命令路由（`src/core/command_router.ts`）：`/help` `/model` `/prompts` `/prompt` `/rewind` `/task*` `/tokens`。命令就地执行，不进 LLM、不落会话文件。

## 内置工具

| 工具 | 作用 | 额外依赖 |
|---|---|---|
| `search_web` | 联网搜索 | `TAVILY_API_KEY` |
| `inspect_link` | 可疑链接核查采证，必要时起真实浏览器 | `playwright` |
| `bili_collect` | B 站视频 / 作者 / 评论快照读数 | 本地数据集目录（`BILI_DATASET_DIR`，不入库） |
| `rag_search` | 本地知识库混合检索 | 需先 `rag:ingest`；向量检索要 `EMBEDDING_*` |
| `git_tree` | 仓库结构只读 | — |
| `run_script` | 沙箱内执行脚本（docker 一次性容器或宿主机进程） | docker 可选 |
| `read_image` | 读图交多模态模型 | — |
| `ask_user` | 向人提问并等回答 | — |
| `memory` | 跨会话记忆读写 | — |
| `load_skill` | 按需读取技能正文 | — |
| `delegate_task` | 委派只读子 Agent（`team` / `scanner` 角色） | — |
| `ingest_findings` | 把发现项写进数据集 | — |
| `update_plan` | 维护计划步骤 | — |
| `set_acceptance_criteria` / `read_task_state` | 设定与读取验收条件 | — |
| `tool_search` | 工具按需加载：schema 超过上下文窗口 10% 时自动启用 | — |
| `filesystem__*` | 来自 MCP filesystem server 的文件读写，限沙箱根内 | — |

## 几个值得说的设计

**不信任模型的自我报告。** "运行结束"与"任务完成"分开记录：模型输出完整文本只标 `answered`，`verified` 必须由宿主对真实文件实测通过才算。计划里还有 pending 步骤时，即使模型声称"已完成"也只标 `incomplete`。验收条件可以要求只采信宿主设定的（`AGENT_REQUIRE_HOST_CRITERIA=1`），模型自设条件实测全过也只记「已回答，未验收」。详见 [docs/运行状态与拒绝识别.md](docs/运行状态与拒绝识别.md) 与 [docs/任务持久化与独立验收.md](docs/任务持久化与独立验收.md)。

**中断的操作不自动重放。** 有副作用的工具调用被打断后状态未知（`needsReconciliation`），崩溃边界上不会替模型决定"再跑一次"，而是列成待核对操作让人 `/task resolve`。

**外部内容一律走不可信围栏。** MCP 资源、搜索结果、网页正文进上下文前套围栏标签，围栏文本做全角转义防止内容伪造闭合标记。

**回合级检查点用影子 git 仓库。** 每轮 user 消息落盘前对沙箱工作区拍快照，`/rewind` 可按序号回滚文件、会话记录或两者。快照失败只告警不阻塞回合。

**上下文压缩是阶梯式的。** 工具结果先替身（stub）、再丢弃、再折叠成长期摘要、最后硬截断，每级都发 `compact` 事件；摘要模型可与主模型分开配（`AGENT_SUMMARY_MODEL`，Web 端还能按会话覆盖）。

**工具注册表没有全局单例。** 入口 `new` 一个实例显式注入 Agent 与 MCP adapter，同进程能组装多套工具集跑多个 agent（`benchmarks/gaia_eval.ts` 就是这么并发评测的）。

**MCP 策略矩阵按风险分级。** 只读与本地非破坏写入放行，破坏性或外部可写询问，外部破坏性拒绝；未声明 `annotations` 的工具走保守默认（询问）。路径守卫与 filesystem server 的 roots 能力共用同一个沙箱根，形成双层防护。

## 配置

全部环境变量在 `src/config.ts` 顶部有注释清单。常用的：

| 变量 | 默认 | 作用 |
|---|---|---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | 模型服务凭证（必填） |
| `AGENT_MODEL` | `glm-5.2` | 主模型 |
| `AGENT_SUMMARY_MODEL` | `qwen3.6-plus` | 压缩 / 命名 / 记忆提取用的摘要模型 |
| `AGENT_MAX_ITERATIONS` | `0` | ReAct 迭代上限，0 = 不限（花费由预算兜底） |
| `AGENT_MAX_TOTAL_TOKENS` | `500000` | 单次 run 的 token 硬预算，≤0 不限 |
| `AGENT_MAX_TOOL_CALLS` | `40` | 单次 run 工具调用总次数上限 |
| `AGENT_THINKING_EFFORT` | `default` | `off`/`low`/`medium`/`high`，按厂商映射请求字段 |
| `AGENT_TOOL_SEARCH` | `auto` | 工具按需加载：`auto`/`on`/`off` |
| `AGENT_SANDBOX` | `auto` | `run_script` 后端：`host`/`docker`/`auto` |
| `AGENT_SANDBOX_NET` | `none` | docker 沙箱网络，默认断网防外传 |
| `AGENT_CHECKPOINTS` | 开 | 回合级回滚检查点 |
| `AGENT_DELEGATE` | 开 | 主对话内子 Agent 委派 |
| `AGENT_MEMORY_DIR` | `.agent-memory` | 跨会话记忆目录 |
| `AGENT_SESSION_ID` / `AGENT_SESSION_DIR` | `.agent-sessions` | 会话选择，显式指定 ID 可跳过询问 |
| `AGENT_TRACE_DIR` | `.traces` | 运行轨迹 JSONL 落盘目录 |
| `TAVILY_API_KEY` | — | 联网搜索 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | — | 向量检索；未配则降级为纯 BM25 关键词召回 |
| `RAG_PG_URL` | — | 知识库改存 PostgreSQL（缺省 JSON 文件） |
| `AGENT_UI_PORT` / `AGENT_UI_HOST` | `8787` / `127.0.0.1` | Web 服务器监听 |
| `AGENT_UI_TOKEN` | — | 访问口令，≥32 字符；绑非回环地址时必填 |
| `AGENT_UI_REMOTE_HARDENING` | 关 | 摘掉 `run_script` 并要求容器沙箱（公网入口用） |
| `AGENT_TEAM_*` | — | 团队运行的并发、预算、超时、复核模型 |

MCP 服务器配置 = 内置默认（`src/mcp/config.ts`：filesystem stdio + 一个 streamableHttp 示例）⊕ 项目根 `.mcp.json`（已 gitignore，`AGENT_MCP_CONFIG` 可改路径）。文件变更无需重启，watcher 防抖监听并增量应用。

## 项目结构

```
src/
  index.ts            终端 REPL 入口
  team.ts             团队 CLI 入口
  server/main.ts      Web UI 服务器入口（REST + SSE）
  bootstrap.ts        三入口共用装配点
  config.ts           环境变量 → 类型化运行配置
  core/    (36 文件)  Agent 主循环、上下文压缩、记忆仓与混合召回、任务/计划与独立验收、
                      检查点与回滚、命令路由、运行预算、事件总线、轨迹、
                      不可信数据围栏、团队协调与调度、工具按需加载
  tools/   (20 文件)  内置工具（见上表）+ docker 沙箱后端 + 遥测中间件
  mcp/      (7 文件)  MCP 客户端层：配置、适配器、路径守卫、策略矩阵、热重载、人工确认
  rag/     (14 文件)  自包含知识库：导入、切块、BM25/向量混合检索、JSON 或 PostgreSQL 存储
  prompts/            系统提示词、/prompt 模板命令、本地提示模板 MCP 服务器
  skills/loader.ts    Agent Skill 发现与渐进加载
  bili/               B 站视频风控纯函数层：快照契约、SRT 解析、链接候选、风险窗口粗定位
  utils/              token 计数、思考程度厂商映射
web/                  React 19 + Vite 7 + Tailwind 4 前端（独立 lockfile 与 tsconfig）
benchmarks/           gaia_eval / memory_recall_eval / scanner_eval / trace_report / llm-serving
docs/                 24 篇文档
tests/                63 个测试文件 + 夹具（根 `bun test` 会一并跑 web/tests 的 7 个）
tools/                根目录一次性诊断脚本 + docker 沙箱镜像（tools/sandbox/）
.agents/skills/       第三方 Agent Skill（`bunx skills add` 装到这里，已 gitignore；来源与 hash 记在 skills-lock.json）
```

依赖方向单向：`入口 → bootstrap → core ← tools / mcp / prompts`，`tools → rag`；rag 不依赖任何人，core 不反向依赖 tools/mcp（数据围栏、注册表、MCP prompt 角色类型都下沉在 core）。前端只允许 `import type` 后端的 `src/server/protocol.ts`，编译期擦除，不打包任何后端代码。

根目录 `tools/` 与 `src/tools/` 语义不同：前者放一次性诊断脚本与沙箱镜像，后者是 agent 的内置工具。

## 文档地图

| 文档 | 内容 |
|---|---|
| [使用说明书](docs/使用说明书.md) | 怎么装、怎么用、每个功能怎么触发、报错怎么办 |
| [WebUI入门篇](docs/WebUI入门篇.md) / [WebUI进阶篇](docs/WebUI进阶篇.md) | 前端零基础起步；协议合同、REST/SSE 双通道、一次回合的 12 步；进阶篇讲设计取舍与踩过的坑 |
| [PostgreSQL使用说明书](docs/PostgreSQL使用说明书.md) | PG 18 零基础操作，以及知识库如何切到 PG 后端 |
| [任务持久化与独立验收](docs/任务持久化与独立验收.md) | 跨回合任务与计划、真实文件验收、中断核对、新任务命令 |
| [运行状态与拒绝识别](docs/运行状态与拒绝识别.md) | `answered` / `verified` / `incomplete` / `recovery_required` 各自什么时候出现 |
| [子Agent运行时](docs/子Agent运行时.md) | 宿主协调规划、结构化交付、独立复核与最多两轮定向补查；并发预算、取消和汇总 |
| [视频诈骗扫描](docs/视频诈骗扫描.md) | scanner 子代理：视频 / 作者 / 评论三维度取证定性，链接一律走 `inspect_link` |
| [浏览器链接采证](docs/浏览器链接采证.md) | 本地浏览器打开链接、人工处理验证、截图交给模型 |
| [现代ReAct入门篇](docs/现代ReAct入门篇.md) | agent 主循环、"想-做-看"、消息与历史管理 |
| [MCP入门篇](docs/MCP入门篇.md) / [MCP进阶篇](docs/MCP进阶篇.md) | MCP 协议与本站客户端实现：工具/资源/提示模板、能力协商、安全策略 |
| [现代RAG入门篇](docs/现代RAG入门篇.md) / [现代RAG进阶篇](docs/现代RAG进阶篇.md) | 知识库检索：分词、BM25、切块、混合检索 |
| [技能三层辨析](docs/技能三层辨析.md) | `skill` 的三重含义：A2A 的 `AgentSkill`、MCP 的 `Tool`、Agent Skill（`SKILL.md`）；含分发安装层与安全排序 |
| [现代Agent知识框架](docs/现代Agent知识框架.md) | 以本项目为参照系的现代 agent 十二层解剖，每层"通用机制 × 本项目实现 × 差距标记"，附体检表、演进路线与术语表 |
| [A2A适配性评估](docs/A2A适配性评估.md) / [A2A入门篇](docs/A2A入门篇.md) / [A2A进阶篇](docs/A2A进阶篇.md) | **设计草案，代码未实现**：这套代码适不适合多 agent / A2A，七优势六缺口三形态分级 |
| [大模型微调](docs/大模型微调知识文档.md) / [部署框架](docs/大模型部署框架知识文档.md) / [蒸馏与知识迁移](docs/大模型蒸馏与知识迁移知识文档.md) | LLaMA-Factory、vLLM/SGLang/TensorRT-LLM/LMDeploy、蒸馏与知识迁移的使用者视角笔记 |
| [SPEC](docs/SPEC.md) / [方案](docs/方案.md) | 图片诈骗审查执行规范；反诈识别的四条技术路线成本对比 |

## 评测与可观测性

`benchmarks/` 下的东西刻意不进 CI，状态如实标注：

| 脚本 | 怎么跑 | 现状 |
|---|---|---|
| `gaia_eval.ts` | `--mock` 无网自检 / `--data <path>` 真实评测 | ⚠️ **mock 自检当前是红的（6 通过 / 7 失败）**；真实评测只跑过 Level 1 的 5 题，不构成可引用的准确率 |
| `memory_recall_eval.ts` | `bun run eval:memory` | 四种检索变体对照；报告用的是合成向量夹具，分数只说明机制差异，不代表真实 embedding 语义质量 |
| `scanner_eval.ts` | `--self-check` 零调用自检 / `--replay`（默认，对已存报告重打分）/ `--live` 真跑 | 对照人工标注算 precision / recall / F1，弃权单列不计入分母；`--replay`/`--live` 依赖已 gitignore 的 `dataset/` |
| `trace_report.ts` | `bun run trace:report` | 聚合 `.traces/*.jsonl`；每个指标自带分母（trace schema 演进过，用全量语料当分母会算出看似精确实则错误的结论） |
| `llm-serving/` | — | vLLM vs SGLang 单机实测记录（Markdown + CSV，非脚本） |

`.traces/` 含真实对话，已 gitignore。

## 已知未完成

- `src/tools/find_suspicious_segments.ts` 是整体注释掉的占位文件，未接线；其 SRT 风险定位的意图已由 `src/bili/`（srt / localize）与 scanner 子代理实现。
- A2A 只有文档没有代码，`src/` 下无 `a2a/` 目录。
- `gaia_eval --mock` 自检 7 项失败。
- CI 里 `actions/checkout` 与 `actions/cache` 还是 v4，有 Node 20 弃用警告。

## 开发约定

改完必跑 `bun run typecheck`（根）+ `cd web && bun run typecheck`（前端），再 `bun test`。

`bun test` 在**同进程内并发**跑所有测试文件，`process.env` 是进程级共享的——需要改环境变量的测试要么把 delete→assert→restore 压在无 await 的同步块里，要么给被测函数注入配置。异步收尾一律**轮询等条件**，不要用固定 sleep：本机够用的毫秒数在 2 核共享 runner 上必然偶发红。

知识文档面向"从零理解"写成，代码里的关键取舍都有对应章节；改动较大时同步更新对应文档。
