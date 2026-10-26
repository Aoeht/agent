# Web UI 进阶篇（架构、并发与坑）

> **前置假设**：已读完 `docs/WebUI入门篇.md`（知道协议合同、REST/SSE 两种通道、一次回合的 12 步）；熟悉 `core/agent.ts` 的事件总线与 `SessionStore` 的落盘语义。
>
> **本文的定位**：讲"为什么这么设计"与"坑在哪"。每个设计决策都给出它否决掉的替代方案；每个坑都是真实踩过的，附现象、根因、修法。
>
> **阅读收益**：读完你能安全地改这套 UI——知道哪些地方有并发语义、哪些改动会破坏什么不变量、扩展时最小 diff 是什么。

---

## 目录

| 章 | 内容 |
|---|---|
| 0 | 设计原则与三条不变量 |
| 1 | 服务器五件套的职责边界 |
| 2 | 多会话并行：三个支柱 |
| 3 | MCP 工具定义拷贝的语义与边界 |
| 4 | 审批桥：两条通道怎么合成一张审批卡 |
| 5 | 传输层与状态归约的工程细节 |
| 6 | 两种"重建"的对比：改配置 vs 切沙箱 |
| 7 | 演进纪律：加事件 / 加端点 / 加面板的最小 diff |
| 8 | 踩坑实录（八个真实案例） |
| 9 | 验证策略：单测点、e2e 手法、浏览器探针 |
| 10 | 已知边界与路线 |

---

# 第 0 章 设计原则与三条不变量

**原则一：Agent 核心不感知 UI。** `core/agent.ts` 至今没有一行 UI 代码。UI 服务器是事件总线的第三个消费者（终端打印、trace 落盘是前两个），外加一个"人工确认"的实现替换（`cli_confirmer` → `UiBridge`）。这条原则的收益在前端开发期兑现过：UI 断联、重启、报错，REPL 丝毫无感。

**原则二：`protocol.ts` 是唯一耦合点，只增不改。** 前端对后端的全部认知收敛到一个文件。给事件加可选字段、新增事件类型都向后兼容；改语义/删字段必须两边同步发布。

**原则三：Agent 与工具注册表按会话隔离，连接类资源全进程共享。** 历史在各会话的 JSONL 里、计划仓各持一份、工具注册表各建一套；而 MCP 连接、配置、技能清单全进程一份。谁私谁公的判据：**会话间并发写会踩坏的状态必须私有**。

由原则派生出三条**不变量**（改代码前先确认没破坏）：

1. 同一会话任意时刻至多一个 run（`entry.controller` 非空即忙）；
2. 人工确认的未决请求，在任何退出路径（超时/取消/断连/关停）下都按"拒绝"收口，绝不悬挂也绝不默认放行；
3. 前端永远不 import 后端运行时代码——`@protocol` 别名只允许 `import type`。

---

# 第 1 章 服务器五件套的职责边界

`src/server/` 五个文件，职责一刀切：

| 文件 | 职责 | 明确不管的事 |
|---|---|---|
| `protocol.ts` | 合同：事件 zod schema + REST DTO + 端点清单注释 | 任何实现 |
| `bridge.ts` | `UiBridge`：把 Confirmer / requestHuman 落成"未决审批 + SSE 广播 + 超时拒绝" | 不认识 Agent，不知道回合是什么 |
| `runtime.ts` | `ServerRuntime`：经 `bootstrap.createAgentStack` 组装共享栈（MCP 挂载目标、配置、技能、沙箱）；提供 `rebuildRuntimeWithSandboxRoot` | 不认识会话 |
| `sessions.ts` | `SessionManager` + `EventHub`：会话生命周期、每会话 Agent/注册表/PlanStore、事件转发、并行与忙检查 | 不认识 HTTP |
| `main.ts` | `Bun.serve`：路由、SSE 帧、静态托管、设置编排 | 不含业务逻辑 |

**事件转发器**（`attachEventRelay`）值得单说：它把 `AgentEventBus` 的事件翻译成协议事件。两个刻意的不对称——

- `run_end` **不从总线转发**：总线版本没有 `finalAnswer`，`runTurn` 拿到 `AgentResult` 后自行发布带完整字段的版本；
- `tool_call_start/end` **不在总线上**：由每会话注册表上的 `createToolEventBridge` 中间件产生（`sessions.ts`）。当时考虑过往总线加事件，但那要改 `core/agent.ts`，且工具生命周期天然属于注册表层——中间件方案零侵入。

**装配复用**：共享栈的组装统一走 `bootstrap.createAgentStack`（技能 → 沙箱解析 → 注册表 → MCP 挂载 → 资源上下文），CLI 的 `src/index.ts` 和 UI 的 `runtime.ts` 是它的两个调用方，差别只剩 Confirmer 与日志前缀。**工具清单只有一份事实来源**（`registerSessionTools`），UI 的会话注册表与 CLI 共用同一函数组装。

---

# 第 2 章 多会话并行：三个支柱

v1 是全局单飞行（整个服务器同时只跑一个回合）。放开并行的难点不在"开个线程"，而在**找出所有隐式共享状态**。逐个拆解后留下三个支柱。

## 2.1 支柱一：每会话私有注册表 + PlanStore

`ensureAgent`（`sessions.ts`）为每个会话现场组装：

```ts
const registry = new ToolRegistry();
registry.use(createToolTelemetry());
registry.use(createToolEventBridge(hub, sessionId));   // 工具事件 → 本会话 SSE
registry.use(createMcpUseTracker(bridge, sessionId));  // MCP 在飞标记（2.3）
const planStore = new PlanStore();                     // 计划仓私有
registerSessionTools(registry, { skills, planStore, sandbox, sandboxRoot });
copyMcpTools(sharedRegistry, registry);                // MCP 定义拷贝（第 3 章）
```

为什么 PlanStore 必须私有：`runLoop` 开头 `planStore.reset()`、`update_plan` 全量替换、计划块钉进上下文——两个并发 run 共享一份就是互相覆盖计划。

**被否决的方案**：把 PlanStore 塞进 `ToolRuntime` 让 update_plan 运行时取——那要改 `core/types.ts` 和 CLI 调用方，爆炸半径大；每会话注册表是现成结构，顺带解决了工具开关（第 2.4）。

## 2.2 支柱二：AsyncLocalStorage 的运行期会话上下文

**被否决的方案**：v1 的 `bridge.setActiveSession(sessionId)` 单槽位。并行后两个 run 交错挂起，单槽位必然把 A 的审批弹给 B——这类 bug 还只在"两个 run 同时到达确认点"时出现，极难复现。

替代：`run_context.ts` 的 `AsyncLocalStorage<{ sessionId }>`。`runTurn` 把 `agent.run()` 包进 ALS 作用域，run 内一切（工具执行、`requestHuman` 确认）都取得到会话 id，且天然按异步链隔离。Bun 完整支持 `node:async_hooks`。

## 2.3 支柱三：MCP elicitation 的在飞归因映射

ALS 有一个盲区：**elicitation 的回调跑在 MCP 传输层的事件循环里，不在 run 的异步链上**——`server → client` 的请求由 SDK 从连接的读循环分派， ALS 上下文在那里是空的。

归因方案：每会话注册表的 `createMcpUseTracker` 中间件在 MCP 工具执行前后维护 `serverId → Set<sessionId>` 引用计数（`bridge.noteServerUse / releaseServerUse`）。`UiBridge.confirmer` 的路由顺序：

1. ALS 有值（run 内的策略 ask、run_script 确认）→ 用它；
2. 否则按 `serverId` 查在飞集合：**恰好一个会话**在飞 → 路由给它；
3. 多个会话同时在同一 server 上有在飞调用 → **decline**（无法可靠归因时宁可拒绝，不模糊放行）。

实践上 stdio server 串行处理请求，情况 3 罕见；但它保证了错误路由的可能性为零。

## 2.4 顺带的收益：工具开关

有了每会话注册表，"工具开关"几乎免费：`ensureAgent` 快照全量定义（`entry.toolDefs`），`setDisabledTools` 对注册表做反注册/按快照恢复。Agent 每轮迭代都调 `tools.toOpenAITools()`，所以**运行中的回合下一轮迭代立即生效**。注意 `resetAgents` 会丢 `registry/toolDefs` 但**保留 `disabledTools`**（重建时重新应用）。

---

# 第 3 章 MCP 工具定义拷贝的语义与边界

每会话注册表里的 MCP 工具来自 `copyMcpTools(sharedRegistry, sessionRegistry)`。它成立的前提要想清楚：

- **定义是无状态闭包**。`McpAdapter.buildDefinition` 生成的 `execute` 绑定的是 server 连接（`client`）与 adapter 的中间件链（策略、路径守卫），**不绑定注册表**——所以按定义拷贝后，策略与守卫原样生效，两个会话共用同一条连接也没有额外握手。
- **判别式是命名约定**：MCP 工具注册名固定为 `serverId__toolName`（`namespacedName`），内置工具不含双下划线。
- **边界：热更新不传播**。`ToolListChangedNotification` → `reloadServerTools` 只刷新共享注册表，已创建的会话注册表保持旧定义，直到该会话下次 `ensureAgent`（重建 Agent 时重新拷贝）。对一个长驻 UI 来说窗口很小，但要知道它在。要闭环的话，可在 manager 上加刷新回调遍历会话重拷——当前刻意不做（复杂度/收益不划算，已记入路线）。

---

# 第 4 章 审批桥：两条通道怎么合成一张审批卡

后端有两条"等人类"通道，语义不同：

- **`Confirmer`**（adapter 策略 ask + elicitation）：`ElicitationRequest → Promise<ElicitationResult>`，天然的"审批"语义；
- **`ToolRuntime.requestHuman(prompt, signal) → string | null`**：文本进出。当前唯一调用方是 `run_script` 的执行确认（CLI 里打印 `允许执行吗？[y/N]` 等用户敲 y）。

**设计错误与修正**（真实教训）：v1 把 requestHuman 渲染成了 `human_input_request` 文本输入弹窗——用户得在输入框里敲 "y"，能用但完全错位；而且它和审批弹窗标题不同，排查时容易盯错窗口。修正后 `UiBridge.requestHuman` 把确认**映射成真正的 `approval_request` 事件**：accept → 返回 `"y"`（`run_script` 的 `approve()` 接受），decline/超时/abort → 返回 `null`（取消执行）。前端复用同一张审批卡、同一个 `POST /approvals/:id` 端点，协议零改动；`human_input_request` 通道保留给未来真正的文本输入调用方。

未决请求的生命周期管理（`bridge.ts`）要点：

- 每个未决请求带 `sessionId` 与原始事件：**SSE 重连时 `pendingEventsFor(sessionId)` 重发**——刷新页面不能丢审批；
- `setTimeout` 超时 → decline（构造时就挂好，不用清理函数外的分支）；
- `askApproval` 接受可选 `AbortSignal`：run 被取消时立即按拒绝收口；
- `disposeSession(sessionId)`：取消回合/关停时把该会话所有未决请求一次性收口。

---

# 第 5 章 传输层与状态归约的工程细节

## 5.1 Transport 双实现

`Transport` 接口是前端的"系统能力清单"。**Mock 的价值不是演示**——它强制协议有可脱离后端的单边实现，前端可以在后端烂掉/没写完时照常开发；同时它是协议的第二个消费者，接口设计得对不对，mock 一写就知道。

## 5.2 applyEvent：事件到状态的唯一归约

`store.tsx` 的 `applyEvent(s, e)` 是纯函数，每个协议事件一个 case。三个值得注意的 case：

- **`token`**：只追加到"最后一条且为流式中的 assistant 项"，否则新建——这个判断让断线重连后（丢了一段 token）最多表现为文字截断，不会串到别的气泡；
- **`step`**：流式开启时它的 `llmContent` 与 token 流重复，仅在"最后一条不是流式项"时兜底插入（兼容非流式后端）；它的 `tokens.promptTokens` 是上下文占用条的数据源；
- **`run_end`**：从返回值发布、带 `finalAnswer`，负责一切收尾（定格流式、清未决弹窗、累计 token、统计卡）。

新增事件时在 `applyEvent` 加 case 即可，组件不用动——它们只读状态。

## 5.3 乐观更新与回源

工具开关采用乐观更新：先改本地状态再 POST，失败时 `listTools` 回源覆盖。适用原因是操作幂等且可回源；发消息**不做**乐观（有 202/409 语义与后台 run），用户气泡的"乐观插入"发生在 `user_sent` action 里，后端 `run_start` 到达时状态自然衔接。

---

# 第 6 章 两种"重建"的对比

| | 切模型/温度/迭代（`applySessionConfig`） | 切沙箱目录（`rebuildRuntimeWithSandboxRoot`） |
|---|---|---|
| 影响范围 | 单会话 | 全部会话 + MCP 连接 + 路径守卫 |
| 手段 | Agent 现成 setter，原位改 | 整条 `createAgentStack` 重跑（新 adapter/新连接） |
| 前置条件 | 会话不忙 | `anyBusy()` 为 false（409） |
| 旧资源 | 无需清理 | swap 后 `oldMcp.closeAll()` |
| 会话 Agent | 保留 | `resetAgents()` 全部丢弃，下回合懒重建 |
| 为什么 | 参数只是 config 字段 | 沙箱根焊在 adapter 白名单/server 启动参数/run_script 闭包里，没有原位改的口 |

前者失败的代价是一次 400；后者失败的代价是 4 秒重挂——所以后者先建新栈、成功才 swap、失败原栈原封不动。**先建后换**是这类重建的通用模式。

---

# 第 7 章 演进纪律：三个最小 diff 清单

**加一个下行事件**（如 `session_renamed`）：
1. `protocol.ts` 的联合类型加一个 member（字段尽量可选）；
2. 产生方接线：总线已有 → `attachEventRelay` 加转发；服务器自产 → 在对应方法里 `hub.publish`；
3. `store.tsx` 的 `applyEvent` 加 case；
4. 组件按需读取。**前后端可分两步上线**：前端先合并（未知事件天然被 discriminatedUnion 之外的分支忽略？——不会，zod 解析失败会丢帧；所以前端先上、后端后上，或同 PR）。

**加一个 REST 端点**：
1. `protocol.ts` 端点清单注释 + DTO；
2. `SessionManager`/`runtime` 加方法；
3. `main.ts` 加路由（记住 `readJson` + 错误映射 400/409）；
4. `vite.config.ts` 代理如果是新路径前缀要加（同前缀则不用）；
5. `transport.ts` + `http.ts` + `mock.ts`。

**加一个右栏卡片**：纯前端，`RightPanel.tsx` 加 Card + 从 `useStore` 取状态；若需要新数据，先走上面两条。

---

# 第 8 章 踩坑实录（八个真实案例）

每个都是本项目真实发生过的。格式：现象 → 根因 → 修法 → 教训。

**① 新会话点了没反应，状态弹回旧会话。** 根因：`StoreProvider` 的 transport 写成默认参数 `transport = new MockTransport()`——Provider 每次渲染都新建实例，两个以它为依赖的 effect 无限重跑，把状态永远拉回 fixtures。修法：`useState(() => transport ?? new MockTransport())` 只建一次。教训：**React 里任何"创建一次"的东西（连接、客户端、订阅）都不许放参数默认值或函数体，放 `useState`/`useMemo` 初始化器**。

**② 模型下拉是空的，接口单独 curl 却正常。** 根因：`vite.config.ts` 代理清单漏了 `/models`，浏览器请求 404，fetch 抛错被吞。修法：补代理；顺手把错误从"静默吞"改成至少可诊断。教训：**加后端路由时，代理清单是隐藏的第 6 步**（第 7 章清单里已固化）。

**③ 模型清单加载后又被清空。** 根因：`models_loaded` 和 `settings_loaded` 共用一个 action，后者带 `models: []`，两个请求竞态后到的覆盖先到的。修法：拆成两个独立 action。教训：**并发 fetch 各自 dispatch 时，action 的载荷必须正交**。

**④ 点会话/按钮无响应，Playwright 点击一直超时。** 根因两层：内嵌浏览器对不可见标签页节流（setTimeout 钳到 1s），且其 actionability 检查在该页面上不可靠。修法：自动化一律 `evaluate(() => el.click())`（派发真实 DOM 事件，React 正常响应）；演示验证时把面板带到前台。教训：**无头/内嵌环境验证 UI，别信固定等待，信状态轮询**。

**⑤ 会话内容出现 � 乱码。** 根因：git-bash 的 curl 把 `-d` 里的中文按本地 GBK 编码发送，服务端按 UTF-8 解出替换符。修法：测试改用 ASCII 或浏览器；已存在的乱码测试会话直接删除（`grep -P '\x{FFFD}'` 定位）。教训：**问题不在服务端时，先看数据的字节**。

**⑥ 同一秒创建两个会话，ID 相同。** 根因：`createSessionId` 是纯秒级时间戳，UI 连点两次"新会话"必撞。修法：追加 4 位随机后缀。教训：**CLI 时代的"人速不会撞"在 UI 时代不成立**——任何按时间生成的标识符都要带随机熵。

**⑦ 切沙箱目录后，回合用的还是旧目录。** 根因：`rebuildRuntimeWithSandboxRoot` 换掉了共享栈，但会话的 Agent 还握着旧注册表闭包。修法：`resetAgents()` 丢弃全部 Agent（历史在磁盘，重建无损失），`ensureAgent` 改读 `runtime.sandboxRoot`。教训：**闭包捕获的资源不会因为"外面换了"而更新**，列出所有捕获点再决定重建范围。

**⑧ SSE 重连后数据"看起来正常但界面不更新"。** 根因是复合的：服务器重启后页面未刷新（旧连接早已死透）、事件在重连窗口内丢失、以及 `resetAgents` 后 hello 回到默认值被误读为"没生效"。修法：hello 重发机制本来就在；排查手段见第 9 章——**服务端加 publish 订阅者计数日志 + 页面内裸 EventSource 探针**，一次定位是"没发"还是"没收"。

---

# 第 9 章 验证策略

**单元测试**（`tests/server_bridge.test.ts`，7 例）：桥接层是纯逻辑（超时/应答/取消/归因），用假 emit + `inRunSession` 包裹即可全覆盖，不需要起服务器。协议类型被两端 typecheck 双向锁定，这本身就是一半的回归测试。

**e2e 手法**（curl 级）：
- SSE 抓帧：`curl -sN .../events` 放 `run_in_background` 的 Bash 任务里（普通 `(curl &)` 会随父 shell 被杀），POST 触发后读文件；
- 并行验证：两个会话同秒创建 → 同时 POST 都 202 → 各自 history 比对答案隔离；
- 忙语义：同会话连发，第二次必须 409。

**浏览器探针**（排查"界面为什么不更新"）：
1. 服务端 `[Hub]` 日志（publish 的订阅者计数）判断"发没发、发给几个"；
2. 页面内裸 `EventSource` 探针判断"这条 URL 在这个页面里通不通"；
3. `performance.getEntriesByType("resource")` 查 REST 请求是否真的发出（注意 EventSource 不进 Resource Timing）。

**视觉验证**：内嵌浏览器截图 + `evaluate` 状态断言组合；交互一律 evaluate click。

---

# 第 10 章 已知边界与路线

- **工具开关仅内存态**：服务器重启回到全开。持久化需要在 `SessionStore` 加一种元记录（照 `【模型】` 的模式），成本已知、刻意未做；
- **MCP 热更新不传播到已建会话**（第 3 章）；
- **SSE 重连窗口内的事件不补发**（只重发 hello + 未决审批）：重连后的流式文字可能从中间开始。彻底解法是事件序号 + 游标补发，当前规模不值得；
- **斜杠命令通道（2026-10-27）**：以 `/` 开头的输入在 `sendMessage` 里被共享命令路由器（`core/command_router.ts`，REPL 同一条）就地认领——同步返回 `{handled, lines}`，不入队、不发 run 事件、不落会话文件；变更类命令（`/model` 切换、`/prompt`、`/rewind`）忙时拒绝，只读（`/help` `/tokens` `/prompts`、`/model` 查看）随时可用；`/task*` 例外仍走队列到 Agent 内部拦截。同批补齐 Web 会话检查点：`createAgent` 按 `AGENT_CHECKPOINTS` 建 `CheckpointStore` 并挂与 CLI 共用的快照钩子工厂（`createCheckpointSnapshotHook`），`/rewind <编号> [c|t|a]` 聊天内直接可用；
- **单进程单飞行上限**：Bun 单进程 + 每会话一个 Agent，几十个并发会话才需要考虑 worker 化；
- **路线**：trace 查看器（`.traces` JSONL 数据现成，读端点 + 时间轴组件即可）、`/rewind` 的检查点面板 UI 化（聊天内序号式已可用，缺一个列表 + 恢复按钮的卡片）、~~局域网 token~~（已落地：`AGENT_UI_TOKEN` 中间件）。

---

> **读后检查**：如果你要改这套 UI，先问自己三个问题——这个改动碰了哪条不变量（第 0 章）？这个状态是会话私有的还是进程共享的（第 2 章）？失败了会不会把未决审批挂起来（第 4 章）？三个都答得上来，就可以动手了。
