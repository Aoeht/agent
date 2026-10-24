# 现代 Agent 知识框架（以本项目为参照系）

> **前置假设**：你想系统性地理解"现代 agent"（Claude Code、Codex CLI、Devin 这一代编码/通用助手）由哪些层构成、每层解决什么问题、机制细节如何，并且希望每个概念都能落到**本仓库的真实代码**上——不是泛泛的名词解释，而是"这个机制在我们项目里叫什么、在哪个文件、为什么这么设计、离业界最佳还差什么"。
>
> 状态标记：✓ 已有（可对照代码读） · ◐ 部分（有骨架缺血肉） · ✗ 缺（路线图候选）。

| 章节 | 内容 |
|---|---|
| [一、解剖图](#一解剖图十二层加两个横切面) | 十二层 + 两个横切面的总览，每层一句话职责 |
| [二、L1 模型调用层](#二l1-模型调用层) | 客户端、流式、用量、重试、过滤、中断 |
| [三、L2 上下文工程层](#三l2-上下文工程层) | 估算与校准、两级压缩、引用映射、钉住前缀、前缀缓存 |
| [四、L3 工具系统层](#四l3-工具系统层) | 注册表、Schema 单源、并发治理、输出治理、图片旁路 |
| [五、L4 协议互操作层](#五l4-协议互操作层mcp) | MCP 传输/原语/策略/守卫/热更新 |
| [六、L5 主循环与控制层](#六l5-主循环与控制层) | ReAct 循环、强制收尾、预算、取消、错误终态 |
| [七、L6 记忆与持久化层](#七l6-记忆与持久化层) | 会话文件、长期摘要、任务账本、检查点、轨迹 |
| [八、L7 规划与验收层](#八l7-规划与验收层) | 计划即工具、验收条件、真实执行验收 |
| [九、L8 多 Agent 协作层](#九l8-多-agent-协作层) | 协调-调度-契约、复核与补查、预算预留 |
| [十、L9 人机协作层](#十l9-人机协作层) | 审批桥、澄清通道、预算追加、等待状态 |
| [十一、L10 安全层](#十一l10-安全层) | 不可信围栏、注入防线、沙箱、鉴权、审计 |
| [十二、L11 交互入口层](#十二l11-交互入口层) | REPL / 一次性 / Web UI、协议合同、事件桥 |
| [十三、L12 技能层](#十三l12-技能层) | 渐进披露、物化执行、市场安装 |
| [十四、横切面 A：可观测性与成本](#十四横切面-a可观测性与成本) | 事件总线、trace、成本表、缓存观测 |
| [十五、横切面 B：评测与质量](#十五横切面-b评测与质量) | 单测纪律、GAIA、冒烟配方 |
| [十六、差距清单与演进路线](#十六差距清单与演进路线) | 按性价比排序的 TODO |
| [十七、术语表](#十七术语表) | 每个术语一句话 |

---

## 一、解剖图：十二层加两个横切面

把任何一个现代 agent 拆开，从下到上是这样的依赖栈（上层只能依赖下层）：

```
 ┌──────────────────────────────────────────────────────────────┐
 │ L11 交互入口层   REPL / 一次性管道 / Web 工作台 / 协议合同      │
 │ L12 技能层       SKILL.md 渐进披露 + 沙箱内脚本执行             │
 ├──────────────────────────────────────────────────────────────┤
 │ L9  人机协作层   审批 / 澄清 / 预算追加 / 等待状态              │
 │ L8  多Agent层   协调规划 → 并发执行 → 独立复核 → 定向补查      │
 │ L7  规划验收层   计划即工具 + 真实执行验收（非模型自评）        │
 ├──────────────────────────────────────────────────────────────┤
 │ L6  记忆持久层   会话文件 / 长期摘要 / 任务账本 / 检查点 / 轨迹 │
 │ L5  主循环控制层  ReAct + 预算 + 取消 + 强制收尾 + 错误终态      │
 ├──────────────────────────────────────────────────────────────┤
 │ L4  协议互操作层  MCP 客户端：传输/原语/策略/守卫/审计           │
 │ L3  工具系统层   注册表 + Schema 单源 + 并发 + 输出治理         │
 ├──────────────────────────────────────────────────────────────┤
 │ L2  上下文工程层  估算校准 / 两级压缩 / 引用映射 / 前缀缓存      │
 │ L1  模型调用层   客户端 / 流式 / 用量 / 重试 / 过滤 / 中断       │
 └──────────────────────────────────────────────────────────────┘
   横切面 A：可观测性与成本（事件总线 + trace + 账本）
   横切面 B：评测与质量（单测 + 评测集 + 冒烟配方）
```

本项目的依赖方向与之严格一致：`index → core ← tools / mcp / prompts`，`tools → rag`，core 不反向依赖任何人（见 README"项目结构"）。这个纪律本身就是框架的一部分——**分层不是文档洁癖，是"能不能同进程组装出第二套 agent"的前提**：`core/registry.ts` 的工具注册表没有全局单例，入口 `new` 一个实例显式注入 Agent 与 McpAdapter，所以 gaia_eval 能组装出评测专用工具集、team 运行时能组装出只读白名单工具集、Web 服务器能给每个会话一套独立注册表。

一个判断 agent 现代化程度的快速体检表（本项目逐项状态）：

| 体检项 | 状态 | 落点 |
|---|---|---|
| 上下文超限不死（自动压缩 + 溢出兜底） | ✓ | `core/context_manager.ts` 四级阶梯 |
| 长会话不失忆（跨 run 记忆） | ✓ | 长期摘要 fold + 钉住前缀 |
| 工具输出不撑爆上下文 | ✓ | `core/tool_outputs.ts` 截断/落盘 |
| 每步可观测（事后能复盘） | ✓ | 事件总线 + `.traces/*.jsonl` |
| 危险操作有人闸门 | ✓ | 策略矩阵 + 审批桥 + `run_script` 人工确认 |
| 做完能独立验证（不是模型自己说自己对） | ✓ | `core/task_verifier.ts` 真实执行验收 |
| 出错能回滚 | ✓（REPL） | 影子 git 检查点 + `/rewind` |
| 中断不丢状态 | ✓ | AbortController 全链路透传 + 任务账本 unknown 状态 |
| 长任务成本可控 | ✓ | RunBudget 越线先问后停 |
| 多 agent 协作 | ◐ | team 运时只在独立 CLI，主对话够不着 |
| 会话消息队列 | ✓ | 忙时发送排队、回合结束自动接续、可撤单（2026-10-24） |
| 主对话内委派子 agent | ✗ | 无 Task/delegate 工具 |

---

## 二、L1 模型调用层

**这层解决什么问题**：把"一次 HTTP 调用"变成可靠的编程接口——流式输出、真实用量、失败重试、内容过滤识别、用户中断，全部在这里归一。

### 2.1 客户端与调用归一 ◐

本项目用 OpenAI SDK 的 `chat.completions` 走任何 OpenAI 兼容端（`.env` 的 `OPENAI_BASE_URL`，当前是 DashScope 兼容模式）。`Agent` 的 `complete()`（`src/core/agent.ts`）是统一入口：按配置分流 `completeOnce`（非流式）或 `completeStreamed`（流式），两者产出同一种 `CompletionResult` 形状——**流式与非流式对上层不可区分**，这是所有调用方的单一事实来源。

关键决策：自建 client 时显式 `maxRetries: 0`，把 SDK 内置重试**关掉**，统一由 `complete()` 自己重试——否则两层重试相乘，一次网络抖动退避成指数的指数。

### 2.2 流式 ◐

`completeStreamed` 逐 delta 发 `token` 事件（REPL 直写终端、Web 走 SSE）；tool_calls 分片按 index 拼装，拼完做 **JSON 校验**（流式分片拼出非法参数是真实会发生的事故）；`stream_options.include_usage` 让流末尾多一个 usage chunk。部分输出保护：一旦已收到任何 chunk 再失败，错误对象被打上 `PARTIAL_STREAM` 标记，**上层不重试**（重试会重复吐字），已流出内容保留为最终答案。

现代 agent 的标配里本项目还缺：**Esc 键中断**（readline 行模式下没有按键级监听，目前只有 Ctrl+C）。

### 2.3 用量与成本观测 ✓

每次调用从 usage 提取 prompt/completion/total；`cachedTokensOf()`（agent.ts）额外提取 `prompt_tokens_details.cached_tokens`（DeepSeek 原生 `prompt_cache_hit_tokens` 做回退），作为 `cachedPromptTokens` 透传到 step/run_end 事件、AgentResult、团队账本。口径纪律：**cached 是 promptTokens 的子集，只观测不改账**。

### 2.4 重试与退避 ✓

`core/llm_retry.ts` 的 `isRetryableTransportError` 只认连接错误/429/5xx；指数退避 + 抖动，默认 2 次；用户取消不重试；内容过滤不重试。摘要类调用有独立策略（`summary_call.ts`）：首模型重试 2 次，用尽换候选模型各一次。缺：429 的 `Retry-After` header 解析。

### 2.5 内容过滤与错误终态 ✓

`run_outcome.ts` 把各种失败归类成稳定终态（content_filter / output_truncated / cancelled / error…），`isContentPolicyError` 兼容 DashScope 的 DataInspectionFailed 措辞。**错误必须有终态而不是抛穿到界面转圈**——这个纪律贯穿整条链。

### 2.6 中断传播 ✓

每回合一个 AbortController（REPL 的 Ctrl+C / Web 的取消按钮），signal 透传到 LLM 请求、重试等待、每个工具执行（含 MCP 调用）。打断后：已流出的部分保留、历史干净落盘、取消也带 `outcome:cancelled` 进会话文件。

---

## 三、L2 上下文工程层

**这层解决什么问题**：上下文窗口是 agent 最贵的资源。这层的全部工作可以概括成三句话——**进上下文之前先治理（微压缩），满了有阶梯降级（宏压缩），压完的东西不能失联（引用映射/钉住前缀）**。这是本项目最强的层，值得逐块细读。

### 3.1 Token 估算与校准 ✓

所有压缩决策建立在估算上（`CommercialTokenCounter`，按模型名词表），但估算有盲区：图片不进估算、tokenizer 有误差、协议有固定开销。解法是**用真实 usage 校准估算**：`recordPromptUsage()` 记录 actual/estimate 的 EMA 比值，钳在 `[1, 3]`——只允许"更保守"，估算偏大不会推迟压缩。工具 schema 的每请求固定开销单独计入（`estimateToolsOverhead`）。每条消息的估算结果按对象身份缓存在 WeakMap，run 内 append-only 所以测一次就够。

### 3.2 微压缩：工具输出进上下文之前 ✓

`core/tool_outputs.ts` 是所有工具结果的统一出口：超过 2000 token 头 70% 尾 30% 截断；超过 8000 token **整篇落盘**（`<sessionDir>/tool_outputs/`），消息里只留摘要 + 文件路径——信息无损，模型需要时可以再读盘。落盘失败退回普通截断，绝不因治理动作打断 run。

### 3.3 宏压缩：四级降级阶梯 ✓

`ContextManager.compress()` 每次迭代请求前调用，阶梯是：

1. **原样发送**（估算在水位内直接返回同一个数组——这对前缀缓存至关重要，见 3.6）；
2. **stub_tool_outputs**：旧工具输出替换为占位符（保留"调了什么、参数是什么"），占位文本确定性生成、可缓存——第二次 stub 只废新改段，不动旧占位；
3. **drop_tool_history**：旧工具组（assistant(tool_calls) + tool 响应）整体移出，最新一组永远原样保留；
4. **fold_summary**：旧对话轮折叠进滚动摘要（8 节结构化骨架，`summary_prompts.ts`——结构化对抗迭代衰减），摘要失败 3 次后放弃 LLM 摘要改 **hard_truncate**（保留预算 25% 内最近对话）。

两个容易被忽略的细节：**水位只增不减**（foldedCount/foldedGroupCount 保证同一批内容不重复喂摘要）；**摘要 token 记账不游离**（onSummaryUsage 喂进 RunBudget 和总账，后台 fold 的成本补记进下一轮 run_end）。

### 3.4 溢出兜底 ✓

估算再准也会被 provider 打脸。`completeWithOverflowGuard`：API 报 400/413 + token 措辞 → 触发 emergency 压缩（跳过 1-2 直接摘要、最近窗口压到 15%）→ 重试**一次**；再超限就把原始错误抛给调用方。误报的代价只是多压一次，漏报的代价是 run 直接失败——所以措辞匹配放宽。

### 3.5 引用映射不随压缩消失 ✓（本项目的特色机制）

工具结果里的来源（URL/标题）在进上下文时被编号成【引用来源】块，模型最终回答用 `[n]` 指代。压缩会删掉工具输出，但编号→来源的映射不能丢：stub 保留引用块头；整组移出时映射收成【引用来源索引】块成对注入（`droppedCitationDigest`）；摘要裁剪时引用块整块保留。用户永远能点开 `[3]` 看到出处，无论那轮工具输出是否已经被压掉。

### 3.6 前缀缓存：观测 + 稳定化 ✓（2026-10-24 完成）

OpenAI 兼容端（DeepSeek/GLM/DashScope）普遍有隐式前缀缓存：provider 按 64-token 块缓存请求前缀，命中部分按折扣计费。这层要做两件事：

- **观测**：解析 `cached_tokens` 全程透传（见 2.3），REPL/Web/团队账本都能看到命中率——没有观测就无法证明任何优化有效；
- **稳定**：消息顺序服务缓存。本项目的历史版本有两个每轮全量失效的破坏点，现已修复：① 长期摘要块/任务记录每轮内容都会变（fold 落地、actions 增长），原来排在 history **之前**，一变就把全部历史的缓存作废——现在移到 history 之后，命中前缀从"只有 system"变成"system + 全部历史"；② 磁盘历史窗口 `compact(20)` 是滑动窗口，超限后**每轮**从头部掉一条——现在加迟滞窗口（不满 maxTurns+25% 不重写），失效频率从每轮一次降到每 5 轮一次。

不变量（有回归测试 `tests/prefix_cache.test.ts` 把守）：**run 内未触发压缩时，连续请求是同一组消息对象的前缀扩展**（对象身份断言，比字符串比较更强）。

已知边界：run 内的工具链消息不落盘（落盘的是最终回答形态），所以跨轮命中只覆盖到 history 前缀为止——这是持久化设计的属性，不是 bug。

### 3.7 跨 run 记忆 ✓

每个用过工具的 run 结束后，后台 fold 一份长期摘要（用户请求/结论/工具观察），写进会话文件元记录；下一个 run 开始时作为**钉住前缀**注入（压缩永不折叠）。fold 转后台执行（REPL 立刻回到提示符），下一轮 run 开轮前必须落地——钉住前缀要读到最新摘要；成本补记进下一轮总账。关停（quit/Ctrl+C）中止在飞 fold 并报告是否跳过了更新。

### 3.8 缺什么 ✗

- **动态环境块**：系统提示纯静态——没有当前日期、cwd、git 分支状态（OS 写死 "Windows"）。现代 agent 通常注入一个稳定-per-会话的 `<env>` 块。注意：环境块内容要**会话内稳定**，否则自己就成了缓存破坏点。
- **推理内容处理**：GLM/Qwen 的 `reasoning_content` 被静默丢弃；上下文编辑（选择性清除旧工具结果、保留思考块）这类精细手术没有。

---

## 四、L3 工具系统层

**这层解决什么问题**：工具是 agent 的手。这层的核心矛盾是**表达力 vs 治理**——模型要看到足够好的 Schema 才能正确调用，宿主要能控制并发、限制输出体积、拦截危险操作。

### 4.1 注册表与中间件链 ✓

`core/registry.ts`：可实例化的 ToolRegistry（无全局单例），`use()` 挂 ToolCallMiddleware 链——遥测、审批、路径守卫都是中间件。`toOpenAITools()` 的顺序稳定（对前缀缓存友好——tools schema 也是请求前缀的一部分）。

### 4.2 Schema 单一事实来源 ✓

`defineTool<T>()`（`core/types.ts`）：Zod schema 是唯一事实，JSON Schema 创建时派生一次（`io:"input"` 让带 default 的字段不进 required）；execute 收到的入参先过 schema 校验，失败转成**字段级错误 observation** 回给模型（不是抛异常）。MCP 工具刻意不走 Zod——协议规定由 server 端校验，客户端重复校验反而添乱。

### 4.3 并发治理 ◐

厂商语义：同批 tool_calls 默认并发。本项目每个工具声明 `parallelSafe`（只读无副作用才 true），**整批全部安全才并发，否则整批串行**——保守但简单。预算拦下的调用补一条错误 tool 观测，保证 tool_calls 与响应严格成对（OpenAI 协议要求）。缺：混合批次的"安全子集并发"、并发上限/信号量、per-tool 超时。

### 4.4 输出治理与多模态旁路 ✓

文本输出走 3.2 的截断/落盘。图片走专用旁路：`ToolRuntime.emitImage`（`read_image` 等本地工具用）把图片作为 user 消息的 `image_url` part 附到**下一次**请求（role:tool 只能装文本，这是协议限制），只存活一轮、不落库不进 trace——避免跨轮重复发送大图。约束：限工作区、≤10MB、文件头嗅探 MIME。缺：用户直接粘贴图片进 REPL 的入口、图片 token 进估算（目前靠校准比兜底）。

### 4.5 内置工具盘点 ✓

联网搜索（tavily）、链接核查（inspect_link）、浏览器采证（browser_*）、RAG 检索（rag_search，BM25+向量 RRF 混合）、读图（read_image）、git 仓库地图（git_tree）、脚本执行（run_script，见 L10 沙箱）、计划更新（update_plan）、验收条件（set_acceptance_criteria）、技能装载（load_skill，见 L12）、澄清（ask_user）、遥测。工具即文档：每个工具的 description 是模型唯一能看到的说明书。

---

## 五、L4 协议互操作层（MCP）

**这层解决什么问题**：agent 的能力不可能全部内置。MCP 是"工具的 USB 接口"——外部服务器以标准协议暴露 tools/resources/prompts 三类原语，客户端负责发现、准入、守卫。

### 5.1 传输 ✓

三种全支持：stdio（本地子进程，env/cwd/stderr 增量收割）、SSE（标注过时）、streamableHttp（现代 HTTP）。配置在 `src/mcp/config.ts`——**编译期静态数组，加服务器要改代码重启**（热载入是缺口，见第十六章）。

### 5.2 三类原语 ◐

- **tools**：完整——分页拉全、差量同步（ToolListChanged 通知 → reloadServerTools）、命名空间 `serverId__tool`（64 截断 + sha1 后缀防撞）、annotations 归一化、structuredContent、进度续期超时；
- **resources**：能 list/read/subscribe，但消费方式是"启动时由宿主挑 text/* 资源注入一次不可信上下文（8k 上限）"——模型与 UI 都不能按需浏览（缺 /resources 入口）；
- **prompts**：list/get 完整，REPL 有 `/prompts` `/prompt` 命令消费，Web 无界面。

### 5.3 策略矩阵与双层守卫 ✓（本项目的特色机制）

准入不是"每个工具都要确认"也不是"白名单放行"，而是**风险分级矩阵**（`mcp/policy_matrix.ts`）：readOnly→minimal/low；destructive/openWorld 升级；幂等降级。默认 minimal/low/moderate→allow、high→ask、critical→deny；**未声明 annotations 的按 ask**（不知情就保守）；toolOverrides/serverOverrides 精确覆盖。ask 落地到 Confirmer（CLI readline / Web 审批卡），没有 confirmer 的环境 ask 直接拒绝——**绝不静默放行**。

第二层是路径守卫（`mcp/adapter.ts`）：allowedRoots=[sandboxRoot] 白名单 + .env/.git/.ssh 黑名单，覆盖工具参数与 resources/read 的 file:// URI。第三层是审计：onAudit 中间件包整链，敏感参数 redact。

### 5.4 现代特性矩阵

| 特性 | 状态 | 说明 |
|---|---|---|
| elicitation（服务器向用户要输入） | ◐ | 仅 form 模式，双端实现（CLI/Web） |
| roots（向服务器声明工作区根） | ✓ | config.roots → file:// URI + listChanged |
| sampling（服务器反向请求模型） | ✗ | 未声明该能力 |
| OAuth | ✗ | 仅静态 header（env Bearer） |
| 工具热更新 | ◐ | server 内变更会刷新**共享**注册表；但每会话注册表在 ensureAgent 时一次性拷贝，长驻 UI 会话拿不到变更 |

---

## 六、L5 主循环与控制层

**这层解决什么问题**：把"一次问答"变成"自主多步工作"，同时保证它**一定会停**、停的时候**有交代**、用户随时**能踩刹车**。

### 6.1 ReAct 循环 ✓

`runLoop`（agent.ts）标准"想-做-看"：构建上下文 → LLM 调用 → 无工具调用则收尾 / 有则执行工具、追加观察、继续。系统提示的纪律：3+ 工具调用要先 `update_plan` 建计划；最终回答前把计划步骤全部标记完成。

### 6.2 强制收尾 ✓

迭代上限/预算越线时不直接丢弃——禁用工具（`tool_choice:"none"`）再要一次最终答案（模型可能一路上都在调工具、从没机会输出正文）；收尾偶发空内容（推理模型把 completion 耗在思考上）时**摘掉工具参数再试一次**。墙钟越线不追加收尾（时间不等人）。

### 6.3 预算 ✓

`RunBudget`：maxTotalTokens / maxToolCalls / maxToolCallsPerName / maxWallClockMs。**越线先问后停**（`requestBudgetExtension` → REPL y/N / Web 审批卡）：同意则调高限额**原地继续**——工具结果都还在上下文里，比让用户重新发一句"继续"更连贯。拒绝后走强制收尾。摘要调用的 token 也计入预算（压缩不是免费的）。

### 6.4 错误终态与部分结果 ✓

任何路径（回答/拒绝/过滤/取消/错误/预算停/迭代尽）都返回带稳定 stopReason 的 AgentResult，已发生的调用、用量、证据全部保留——见 2.5。

### 6.5 缺什么 ✗

- 主对话内**委派子 agent**（Claude Code 的 Task 工具）：团队运行时全部现成但只在独立 CLI，`registerSessionTools`（`src/bootstrap.ts`）没有任何 delegate 类工具——这是当前多 agent 投入与日常使用之间最大的断层；
- **全局后台任务** ◐：Web 会话消息队列已做（忙时发送排队、回合结束自动接续、可撤单，见 12.4），但"把长任务整个放后台、切走再回来"的全局后台任务与跨会话完成通知仍未做；REPL 无队列。

---

## 七、L6 记忆与持久化层

**这层解决什么问题**：进程会死、上下文会满、人会后悔。持久化层让三件事都有退路：重启续聊（会话文件）、窗口外不失忆（长期摘要）、做错了能回滚（检查点）。

### 7.1 会话文件 ✓

`core/session_store.ts`：JSONL 一行一条，追加即落盘（崩溃最多丢最后一条）。**元记录**设计很妙：会话名/模型选择/模板状态/长期摘要写成"长得像 user 消息、正文带固定前缀"的记录——历史可查（哪轮用了什么模型）、上下文不重复付费（进 LLM 前按前缀剔除）、旧版本读到也只会当成一句普通用户话。`load()` 时 `repairTail()` 修复被中断的尾部（半个回合、缺响应的工具组），保证历史永远是合法消息序列。磁盘层 compact 只保留最近 N 轮完整对话（工具调用不跨进程重放），带迟滞窗口（见 3.6）。

### 7.2 任务账本 ✓（超出一般 agent 的部分）

`core/task_store.ts`：每会话一个 sqlite，记录任务目标/计划/验收条件/每次运行/每个工具动作。三个关键机制：**执行权租约**（pid+token，防两个执行器同时跑）；**动作核对状态**（中断恢复时把在途副作用标 `unknown`，强制人工 `/task resolve` 核对后才能继续——"工具返回不等于真的生效"）；**验收条件不可降低**（模型不能偷偷把标准改宽松）。跨重启恢复：计划从任务记录还原。

### 7.3 检查点与回滚 ✓（REPL）

`core/checkpoint_store.ts` 是 Claude Code 式**影子 git**：每会话独立 git-dir（`<sessionDir>/checkpoints/<id>/.git`），每次 git 调用显式 `--git-dir/--work-tree` 并清空 `GIT_*` 环境变量（防影子仓库被外层 git 环境污染）；每个检查点是独立根提交 + 独立 ref，裁剪=删 ref（上限 100）。快照时机在"历史 compact 之后、本轮 user 消息落盘之前"——会话文件正处于干净的回合边界，**对话回滚=文件 truncateTo**，零抢救逻辑。`/rewind` 支持 c=代码/t=对话/a=两者。缺：Web UI 入口、恢复前 diff 预览、任务账本不随回滚。

### 7.4 轨迹 ✓

`core/trace.ts`：事件逐条追加 `.traces/<session>-<ts>.jsonl`（进程被杀不丢已发生的事件），run_start 带 system prompt 指纹（promptHash）——"这条轨迹用的是哪版规则"可查。缺：读取侧（trace viewer，见第十六章）。

---

## 八、L7 规划与验收层

**这层解决什么问题**：长任务里模型会"埋头干活忘了目标"，干完会"自己说自己做完了"。规划层给目标一个可追踪的结构，验收层把"完成"的定义权从模型手里拿走。

### 8.1 计划即工具 ✓

PlanStore + `update_plan` 工具（全量替换语义，≤1 个 in_progress 由 execute 强制）。计划更新后：最新计划块追加进消息末尾**并且**接管钉住前缀——两处都要在，因为未触发压缩的轮次 compress 原样返回（钉住只在压缩路径生效），触发压缩时旧对话被折叠、钉住前缀保证最新计划永不折叠。`plan_update` 事件广播（REPL 打印/Web 面板）。系统提示纪律：3+ 工具调用必须先有计划。缺：两阶段"先规划审批再执行"模式（route A，当时的取舍是 route B 更轻）。

### 8.2 真实执行验收 ✓（本项目的招牌机制）

验收不是"模型自评我完成了"，而是**宿主读真实文件**：`task_verifier.ts` 对 file_exists / text_contains / json_equals / sha256 逐条实测，拒符号链接、拒越界路径、拒凭据目录。三道防线防"模型挑宽松标准自己拿绿灯"：宿主可预设验收条件（`requireHostAcceptanceCriteria` 模式下模型自设条件即使实测全过也只记"已回答，未验收"）；条件一经设定不可降低删除；终答后有一次"验收失败→修复"的循环机会，收尾再实测一次。verified 状态要求独立证据齐全（否则 task_store.finish 直接抛错）。

边界：目前只做 5MB 内文件级检查；无测试运行器（跑测试并解析结果）、无语义评分。

---

## 九、L8 多 Agent 协作层

**这层解决什么问题**：单个 agent 的上下文有限、视角单一。多 agent 用"分而治之 + 独立复核"换质量和规模，代价是协调成本和延迟。

### 9.1 本项目的团队运行时 ✓

`bun run team "目标"`（`src/team.ts` + `core/team_coordinator.ts` + `team_scheduler.ts` + `team_contracts.ts`）：

```
协调规划（结构化 JSON 计划，DAG 依赖）
  → 子任务并发执行（白名单只读工具、每子任务独立预算）
  → 独立复核（可用不同模型；失败先重试一次）
  → 最多两轮定向补查（只重跑未通过的任务及其下游）
  → 汇总（紧凑投影 + 逐级收紧）
```

值得细读的机制：

- **结构化契约**：子任务交付/复核都是 JSON（`team_contracts.ts` Zod 契约），解析有围栏/前后缀容错（`extractJsonObject`）；校验失败先派**一次性无工具格式修复子代理**（带着宿主错误信息，只许改格式不许重查）——远比整轮重跑便宜；
- **预算预留与保守结算**：每子任务从团队总预算预留额度，"发出但没响应"按预留全额结算（宁可多记不漏记）；
- **防洗钱复核**：复核者拿到的是任务契约与工作代理的交付，不能被交付文本里夹带的"请通过"话术收买（复核指令独立注入）；
- **紧凑投影**：汇总输入用专用投影（只留结论/交付/未解决项/来源，不复述 findings/coverage），4 级逐级收紧（去引用列表 → 每任务 4000 → 1600 字符 → 去证据），保证装入协调预留且留 512 token 补全——大团队不再整体失败；
- **墙钟治理**：每子任务超时 = min(固定配置, 团队剩余时间)，墙钟停止的子代理不做强制收尾（时间不等人）→ 判 failed → 可补查；
- **补查反馈传导**：下游补查会收到被返工的直接依赖的未通过检查项（按 taskId 标注）——下游知道上游结论为什么不可靠，才能正确重核。

### 9.2 结构性缺口 ◐

- **入口断层**：以上全部只能从独立 CLI 进。REPL/Web 主对话没有 Task/delegate 工具，团队结果也不回注主对话——多 agent 投入对日常使用不可见；
- **子代理同构**：role（researcher/analyst/reviewer）只改提示词一句话，工具白名单全部相同；没有"通用可写型"子代理（刻意的安全取舍）、没有按角色区分预算；
- **复核仍单评审者**：`AGENT_TEAM_REVIEW_MODEL` 可配跨模型但缺省为空=同模型；无多评审者投票；
- **不支持断点续跑**：团队中断后从头再来。

### 9.3 业界参照

Claude Code 的子代理是"主对话内的 Task 工具 + 专门角色（只读探索/通用/评审）+ 结果作为消息回注"——轻量、日常可用；本项目的团队是"批处理式 DAG + 独立复核"——重、质量导向。两者互补，理想形态是主对话内可委派轻量子代理、重任务再走团队运行时。

---

## 十、L9 人机协作层

**这层解决什么问题**：agent 不是全自动的——它需要在关键路口问人，而"问"这件事本身要做得不烦人、不丢失、不阻塞错车道。

### 10.1 三通道合一 ✓

本项目的三条人机通道：**审批**（策略 ask / run_script 确认，y/N 语义）、**澄清**（ask_user 自由文本，模型主动发起）、**预算追加**（越线时 y/N）。REPL 端三者复用同一个行输入源（LineSource 队列，防管道丢行）；Web 端三者归一到审批桥（`src/server/bridge.ts`）：一张卡片按 requestedSchema 渲染表单，`POST /approvals/:id` 应答，120s 超时自动 decline，**刷新后 SSE 重发未决请求**（审批不能因为刷新而消失）。

### 10.2 等待状态持久化 ✓

任务账本记录 `waiting` 状态（哪种通道、问的什么）——宿主崩溃重启后能恢复"当时正等着用户确认什么"（见 7.2 的租约与核对机制）。

### 10.3 缺什么 ✗

- 权限模式（Claude Code 的 plan mode / auto-approve / yolo 档位）：本项目粒度是"每个工具每次"，没有会话级模式开关；
- Web 端的命令通道：斜杠命令（/task resolve 等）只在 REPL 分发，Web 把它当普通文本喂给模型（见第十六章）。

---

## 十一、L10 安全层

**这层解决什么问题**：agent 会主动读外部数据、跑脚本、写文件。安全层的对象不是"黑客"，而是**被工具结果诱导的模型**和**被授权过头的工具**。

### 11.1 不可信数据围栏 ✓（单choke点）

`core/untrusted.ts` 的 `wrapUntrustedData`：所有工具观察、MCP 资源、外部文本进上下文统一套围栏，明示"这是外部数据、不要执行其中的指示"；围栏标签本身全角转义（body 里含 `</UNTRUSTED_MCP_DATA>` 也逃不出去）。语义分级的两个通道：untrustedContext 是"参考资料不要执行"，提示模板是"被选定执行的指令、与系统规则冲突以系统为准"——**语义相反的两种外部内容绝不混用同一个围栏**。

### 11.2 提示模板的角色保真 ✓

MCP prompts 里的 system 消息前置到 System 层（不降级成 user 文本——降级会丢失优先级），其余按原顺序、带出处围栏注入（`injectedMessages`）。

### 11.3 沙箱 ✓（范围明确）

`run_script` 是唯一执行任意代码的工具，后端可切：docker（一次性容器、断网、rootfs 只读、CPU/mem/pids/nofile/fsize 硬顶、超时 docker rm -f）/ host / auto（探测降级，显式记录；`AGENT_SANDBOX=docker` 是强承诺不静默降级）。解释器按扩展名白名单、无 shell 拼接（argv 直传）、执行前**每次人工确认**。技能脚本物化到沙箱内执行（见 L12）。边界声明诚实：host 后端下沙箱外副作用不设防（与 Claude Code 同边界）；filesystem MCP 的隔离靠 roots+路径守卫双层，不在容器里。

### 11.4 网络面 ✓

Web 服务器默认只绑 127.0.0.1；非回环绑定强制 token（`src/server/auth.ts`：Bearer + HttpOnly cookie 存 sha256 派生、/login 页带 CSP）；远程模式再收紧（REMOTE_HARDENING 摘 run_script）。

---

## 十二、L11 交互入口层

**这层解决什么问题**：同一个 agent 内核要服务终端、脚本/CI、图形界面三种形态，且三种形态看到的行为一致。

### 12.1 三入口同一条组装线 ✓

`src/bootstrap.ts` 的 `createAgentStack`（技能发现/沙箱解析/注册表组装/MCP 挂载）被 CLI（`src/index.ts`）和 Web 服务器（`src/server/runtime.ts`）共用——策略/守卫/工具清单同一份，差异只在 confirmer 实现与远程收紧。

### 12.2 REPL ✓

行输入队列（LineSource）防管道丢行；后台事件清行重绘；Ctrl+C 双挂（readline + 进程）；命令路由：`/model` `/prompts` `/prompt` `/rewind` `/task*`。缺常用命令：`/help` `/clear` `/compact` `/tokens`。

### 12.3 一次性模式 ✓

`echo "任务" | bun run src/index.ts`：管道单回合、退出前 `flushSummary()` 保证记忆落盘、退出码反映成败（CI 友好）。

### 12.4 Web 工作台 ✓

React 前端（`web/`）+ Bun.serve 后端（`src/server/`）。架构要点：**agent 内核零改动**——Web 是事件总线的第三个消费者；**协议合同**（`src/server/protocol.ts` Zod，additive-only 纪律）；**每会话独立 Agent/注册表/PlanStore**（ALS 归属 + 在飞工具按 serverId 归因到会话，elicitation 回调跑在传输事件循环上会丢 ALS——用引用计数兜底，多会话 ambiguity 时拒绝而非猜测）；SSE 推流 + 15s 心跳 + 重连重发未决审批。功能：多会话并行、流式、工具卡片、计划面板、工具开关（服务端持久）、模型参数/上下文条/沙箱热切换、审批桥、缓存命中行、**会话消息队列**（忙时发送不再 409：入队等待 `queue_changed` 事件可见、回合结束自动按序接续、`DELETE /sessions/:id/queue/:id` 撤单、`run_start.queueId` 把排队芯片转成正式气泡——排队是纯内存态，SSE 重连时随订阅快照补发）。

### 12.5 缺什么 ✗

- Web 斜杠命令通道（行为断裂，见第十六章）；
- 消息编辑/重发（regenerate）、文件 diff 预览；
- trace viewer（数据有、读侧无）。

---

## 十三、L12 技能层

**这层解决什么问题**：工具是"能做什么"，技能是"怎么做某类事"——把领域作业流程写成模型可装载的作业指导书（SKILL.md），不占常驻上下文。

### 13.1 三层渐进披露 ✓

①系统提示只放 name+description 清单（0 技能时逐字节不出现该段）；②`load_skill` 工具按需读 SKILL.md 正文或附带文件（路径守卫、24k 截断、不可信围栏包裹）；③读成功时把技能目录**物化**到 `<sandboxRoot>/.skills/<name>/`，脚本经 run_script 在同一沙箱边界内执行——技能没有引入新的执行面。

### 13.2 安装与来源 ✓

`bunx skills add`（市场安装，skills-lock.json 登记来源）；loader 把 lock 当来源元数据，本地哈希校验刻意不做（安装器会重写副本、哈希对不上），防篡改靠围栏不靠哈希。

### 13.3 概念辨析 ✓（本项目文档已写透）

A2A 的 AgentSkill（能力广告）/ MCP 的 Tool（可执行函数）/ Agent Skill（SKILL.md 作业指导书）是三个层面的东西，详见 `docs/技能三层辨析.md`。提示模板（MCP prompts）与技能是两套独立机制，仅共享 MCP 底座。

### 13.4 缺什么 ✗

frontmatter 只解析 name/description（不支持 allowed-tools 等扩展字段）；单一目录无用户级+项目级分层。

---

## 十四、横切面 A：可观测性与成本

**原则**：不能观测就不能改进。本项目的观测三件套：

1. **类型化事件总线**（`core/events.ts`）：run_start/step/token/retry/plan_update/compact/task_update/run_end——CLI 渲染、trace 落盘、Web SSE 任意多个消费者订阅同一事件流，新增观察者不改 Agent 构造参数；
2. **轨迹**（`core/trace.ts`）：逐事件 JSONL + system prompt 指纹 + 每步 token（含缓存命中）；
3. **账本**：run 级总账（totalTokens + cachedPromptTokens + 补记的摘要成本）、团队消耗小表（每尝试的模式/轮次/状态/tokens/缓存/原因）。

成本视角的现代实践清单：前缀缓存观测 ✓（本次完成）；prompt cache 的主动利用（Anthropic 式 cache_control 分段）✗（当前全是 OpenAI 兼容端，隐式缓存）；摘要模型分级（便宜模型做摘要/起名）✓；请求级 dedup/结果缓存 ✗（RAG 向量缓存有，LLM 层无）。

---

## 十五、横切面 B：评测与质量

1. **单测纪律** ✓：46 个测试文件、330+ 用例；纯函数优先（压缩阶梯的估算、docker argv、投影裁剪全部可离线测）；需要真实环境的用例门控跳过（docker daemon、PG、字体）；mock client 模式统一（按 tools 参数区分主调用与摘要调用）。改完必跑 `bun run typecheck` + `bun test`（web typecheck 必须在 web/ 目录下跑）；
2. **评测集** ◐：GAIA 评测链路（`benchmarks/gaia_eval.ts`，--mock 自检不花钱）；
3. **冒烟配方** ✓：管道 REPL（AGENT_REPL=1 + LineSource）做端到端行为验证；本地假 OpenAI 兼容服务（work/fake_cache_provider.ts，SSE 流式 + 可控 usage）验证 provider 相关解析——不花钱、可重复；
4. **性能基线** ◐：LLM 推理基准（benchmarks/llm-serving，SGLang/vLLM 对比）服务自部署场景。

---

## 十六、差距清单与演进路线

按性价比排序（2026-10-24 评审结论，prompt caching 已完成）：

| # | 事项 | 类型 | 一句话理由 |
|---|---|---|---|
| 1 | 主对话内 Task 委派工具 | 结构 | 协调器/子代理工厂/投影全部现成，只差注册一个宿主工具让 REPL/Web 能派子代理并把结果回注上下文；消息队列已就位，委派的长任务不再阻塞对话 |
| 2 | ~~后台任务 + 完成通知~~ | ✅ 完成 | 2026-10-24 落地会话消息队列（排队/自动接续/撤单/重连快照）；剩余：全局后台任务与跨会话通知、REPL 侧队列 |
| 3 | Web 斜杠命令通道 | 正确性 | RightPanel 正引导用户输 /task resolve，但 Web 把它当普通文本喂给 LLM——正在发生的行为断裂；顺带 /rewind UI 化 |
| 4 | MCP 配置热载入 + 跨会话传播 | 正确性 | 配置是编译期静态数组；ToolListChanged 不传播到已建会话的注册表，长驻 UI 会话拿不到 MCP 变更 |
| 5 | 复核去单点 | 质量 | 缺省跨家族模型 + 2-3 评审者多数裁决 |
| 6 | 系统提示动态环境块 | 能力 | 日期/cwd/git 状态；内容必须会话内稳定（别自己变成缓存破坏点） |
| 7 | 并行子集执行 + 并发上限/超时 | 性能 | 一批里一个非 parallelSafe 就整批串行 |
| 8 | trace viewer | 可观测 | .traces 数据现成，缺只读端点 + 前端时间轴 |
| 9 | 图片粘贴入口 + 多图预算 | 能力 | 目前唯一入口是模型自己调 read_image |
| 10 | REPL 命令补全（/help /clear /compact /tokens）+ Esc 中断 | 体验 | 高频小命令 |
| 11 | 技能 frontmatter 扩展 + 用户/项目两层 | 扩展 | allowed-tools、分层优先级 |
| 12 | MCP sampling / OAuth | 互操作 | 低频但补齐协议矩阵 |
| 13 | 消息重发、diff 预览（Web） | 体验 | 纯前端增益 |
| 14 | 团队断点续跑 | 可靠性 | 中断后从头再来 |

---

## 十七、术语表

| 术语 | 一句话定义（+本项目落点） |
|---|---|
| ReAct | 想（推理）-做（工具）-看（观察）循环；`agent.ts` runLoop |
| 上下文压缩 | 满水位前把旧内容折叠成更小表示；四级阶梯 `context_manager.ts` |
| 微压缩 / 宏压缩 | 单条工具输出进上下文前的截断落盘 / 请求级的历史折叠 |
| 钉住前缀 | 压缩永不折叠的消息集合（长期摘要/任务/计划）；setPinnedPrefix |
| 前缀缓存 | provider 按 64-token 块缓存请求前缀、命中部分折扣计费；cachedTokensOf |
| 缓存破坏点 | 任何改写已发送前缀的行为（易变块前置、滑动窗口头部掉条） |
| 溢出兜底 | API 报上下文超限后强制压缩重试一次；completeWithOverflowGuard |
| 引用映射 | 工具来源编号→出处的映射，压缩后以索引块存活；citations.ts |
| 工具注册表 | 工具定义 + 中间件链的可实例化容器；registry.ts |
| parallelSafe | 工具可否与同批调用并发执行的声明 |
| MCP | Model Context Protocol：外部工具/资源/提示模板的标准协议；src/mcp/ |
| 策略矩阵 | 按 annotations 风险分级决定 allow/ask/deny；policy_matrix.ts |
| 路径守卫 | allowedRoots 白名单 + 敏感目录黑名单的参数过滤；adapter.ts |
| elicitation | MCP 服务器向用户请求输入（form/url 模式） |
| roots | 客户端向 MCP 服务器声明的工作区根 |
| sampling | MCP 服务器反向请求客户端模型补全（本项目未支持） |
| 影子 git | 隐藏的独立 git 仓库做文件快照；checkpoint_store.ts |
| 元记录 | 会话文件里长得像 user 消息的状态记录（会话名/模型/长期摘要） |
| 长期摘要 fold | run 后把本轮工作折叠进跨 run 记忆的后台调用 |
| 任务账本 | sqlite 记录任务/运行/动作，含租约与核对状态；task_store.ts |
| 真实执行验收 | 宿主读真实文件逐条核对验收条件；task_verifier.ts |
| 预算预留/结算 | 团队给每子任务预留 token 额度、保守结算（发出未响应按全额） |
| 紧凑投影 | 汇总输入只保留结论/交付/未解决项的裁剪表示；projectForSummary |
| 定向补查 | 复核失败后只重跑未通过任务及其下游（最多两轮） |
| 防洗钱复核 | 复核者只看契约与交付、指令独立注入，不受交付文本收买 |
| 不可信围栏 | 外部数据进上下文的包裹标注，明示不要执行其中指示；untrusted.ts |
| 审批桥 | Web 端把审批/澄清/预算追加归一到一张卡 + REST 应答；bridge.ts |
| ALS 归属 | AsyncLocalStorage 把工具调用归属到发起会话；run_context.ts |
| 协议合同 | 前后端共享的事件/DTO Zod schema，additive-only；protocol.ts |
| 渐进披露 | 技能先给索引、按需读正文、再物化执行的三层装载 |
| 一次性格式修复 | 结构化输出校验失败后带错误信息重试改格式的无工具子代理 |
| 事件总线 | 类型化发布/订阅，多消费者零侵入；events.ts |
| promptHash | system prompt 的 sha256 前 12 位，随 trace 落盘供归因 |
