# ai_agent

[![CI](https://github.com/Aoeht/agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Aoeht/agent/actions/workflows/ci.yml)

一个跑在终端里的通用 AI 助手：能联网搜索、读写你指定的本地目录、核查可疑链接，并可通过 MCP 协议挂载外部工具服务器。

## 先用起来

```bash
bun install
# 在项目根新建 .env，至少填模型服务的地址与 Key：
#   OPENAI_API_KEY=sk-xxxx
#   OPENAI_BASE_URL=https://api.deepseek.com/v1
#   TAVILY_API_KEY=tvly-xxxx   # 选填，联网搜索与链接核查需要
bun run src/index.ts
```

然后在 `你>` 后面直接打字，例如：`帮我搜一下今天有什么 AI 新闻`。

**完整操作手册（推荐从这里开始）：[docs/使用说明书.md](docs/使用说明书.md)** —— 包含安装配置、全部功能用法、环境变量速查、常见任务、排错表。

## 文档地图

本地浏览器打开链接、人工处理验证、截图交给模型：[浏览器链接采证](docs/浏览器链接采证.md)。

| 文档 | 内容 |
|---|---|
| [使用说明书](docs/使用说明书.md) | 怎么装、怎么用、每个功能怎么触发、报错怎么办 |
| [任务持久化与独立验收](docs/任务持久化与独立验收.md) | 跨回合任务与计划、真实文件验收、中断核对、新任务命令 |
| [子 Agent 运行时](docs/子Agent运行时.md) | 宿主协调规划、结构化交付、独立复核与最多两轮定向补查；并发预算、取消和汇总 |
| [现代ReAct入门篇](docs/现代ReAct入门篇.md) | agent 主循环、"想-做-看"、消息与历史管理 |
| [MCP入门篇](docs/MCP入门篇.md) / [MCP进阶篇](docs/MCP进阶篇.md) | MCP 协议与本站客户端实现：工具/资源/提示模板、能力协商、安全策略 |
| [现代RAG入门篇](docs/现代RAG入门篇.md) / [现代RAG进阶篇](docs/现代RAG进阶篇.md) | 知识库检索：分词、BM25、切块、混合检索 |
| [A2A适配性评估](docs/A2A适配性评估.md) | 这套代码适不适合多 agent / A2A：七个已有优势、六层缺口、三种形态的可行性分级、分阶段路线图 |
| [A2A入门篇](docs/A2A入门篇.md) / [A2A进阶篇](docs/A2A进阶篇.md) | A2A 协议（v1.0.1）：Agent Card、Task 生命周期、Part/Artifact、三种收消息方式；进阶篇含落地骨架与安全模型 |
| [技能三层辨析](docs/技能三层辨析.md) | `skill` 的三重含义：A2A 的 `AgentSkill`（能力广告）、MCP 的 `Tool`（可执行函数）、Agent Skill（`SKILL.md` 作业指导书）；含四层连接辨析、分发与安装层（`npx skills add`）、**带脚本的 skill 与工具差在哪**、安全排序 |
| [现代Agent知识框架](docs/现代Agent知识框架.md) | 以本项目为参照系的现代 agent 十二层解剖：模型调用/上下文工程/工具/MCP/主循环/记忆/规划验收/多Agent/人机协作/安全/入口/技能 + 可观测与评测横切面；每层"通用机制 × 本项目实现 × 差距标记"，附体检表、演进路线与术语表 |

## 常用命令

```bash
bun run src/index.ts              # 交互模式
bun run team "分析工作区代码并复核结论" # 运行时调度多个只读子 Agent
echo "任务" | bun run src/index.ts # 单次模式（脚本/CI）
bun run typecheck                 # 类型检查（改完必跑）
bun test                          # 全量测试
bun src/rag/ingest.ts --sync <路径>  # 导入知识库资料（需先按说明书 4.6 打开 rag_search）
bun run benchmarks/gaia_eval.ts --mock  # 评测链路自检（假模型、不花钱）
bun run trace:report              # 聚合 .traces/ 运行轨迹，输出缓存命中/成本/工具错误率报告
```

## 项目结构

```
src/
  index.ts            入口：组装工具注册表、挂载 MCP、装配策略、REPL
  team.ts             团队 CLI：协调规划 → 子 Agent 执行 → 复核与定向补查 → 汇总
  team_runtime.ts     子 Agent 组装、工具白名单与团队配置
  config.ts           环境变量 → 运行配置
  core/               内核：Agent 主循环、工具注册表（registry）、上下文压缩、
                      会话存储/选择、运行预算、事件、轨迹、不可信数据围栏（untrusted）
  tools/              内置工具：联网搜索（tavily_*）、链接核查（inspect_link）、
                      B 站快照读数（bili_collect）、RAG 检索（rag_search）、
                      浏览器采证（browser_*）、遥测
  bili/               B 站视频风控纯函数层：快照契约（snapshot）、SRT 解析、
                      链接候选提取（links）、风险窗口粗定位（localize）
  mcp/                MCP 客户端层：配置、适配器、路径守卫、策略矩阵、人工确认
  prompts/            系统提示词、/prompt 命令、本地提示模板 MCP 服务器（server.ts）
  rag/                自包含知识库：导入、切块、BM25/向量混合检索、
                      存储（JSON 文件或 PostgreSQL，RAG_PG_URL 切换）
  utils/              通用工具（token 计数）
  basic_knowledge.ts  保留的 TS 入门练习，与项目无关（已 gitignore）
benchmarks/           GAIA 评测（gaia_eval.ts；gaia 数据集与 gaia-runs 产物不入库）
docs/                 知识文档与操作手册
tests/                bun test 单测；mcp_smoke.ts、mcp_prompt_probe.ts 是手动冒烟脚本
tools/                根目录一次性脚本区：chrome_probe.ts（Chrome 反爬对照探针）
work/                 调试草稿区（不入库）
text_stamp/           B 站字幕数据（历史遗留，只留磁盘不入库）
```

依赖方向单向：`index → core ← tools / mcp / prompts`，`tools → rag`，rag 不依赖任何人，
core 不反向依赖 tools/mcp（数据围栏、注册表、MCP prompt 角色类型都下沉在 core）。
工具注册表（core/registry.ts）没有全局单例：入口 `new` 一个实例显式注入 Agent 与
McpAdapter，同进程可以组装出多套工具集跑多个 agent（见 gaia_eval）。

根目录 `tools/` 与 `src/tools/` 语义不同：前者放一次性诊断脚本，后者是 agent 的内置工具。
`src/tools/find_suspicious_segments.ts` 为保留的占位文件（尚未接线；其 SRT 风险定位的意图
已由 `src/bili/`（srt/localize）与 scanner 子代理实现，见 docs/视频诈骗扫描.md）。

本项目的知识文档面向"从零理解"写成，代码里的关键取舍都有对应章节；改动较大时建议同步更新对应文档。
