# A2A 入门篇（零基础，假设你只懂"两个程序怎么说话"）

> **前置假设**：你会读 TypeScript 基础（知道 `class`、`interface`、`async/await`、`Promise`），知道"跑一个 HTTP 服务"是什么意思。你**不需要**懂 JSON-RPC、SSE、OAuth、JWS 这些东西——每个术语第一次出现都会先用人话解释，再给正式名字。
>
> **前置阅读**：`docs/MCP入门篇.md`。A2A 和 MCP 是**一对**协议，本文会反复拿它们对照。如果你还没读 MCP 那篇，先读它第 0～7 章。
>
> **配套代码**：`A:\ai_agent`。文中出现的 `文件:行号` 都指向你的真实代码，方便边读边对照自己在哪一步会用到这个协议。
>
> **本文的定位**：只讲"名词和直觉"，帮你把 A2A 的世界观建立起来。**凡是"规范字段的精确语义""某处实现与规范的偏差""怎么落到你现有代码"这类工程细节，本文一律点到为止，把展开留给 `docs/A2A进阶篇.md`。** 读完本文再读进阶篇，就不会有跳跃感。
>
> **怎么读**：第 0～3 章是"为什么要它"，第 4～6 章是"三个核心概念"，第 7～9 章是"协议怎么运转"，第 10 章把一切串成一次真实调用，第 11～12 章用来动手和自测。遇到不认识的词先往下读，很多词会在后面反复出现中变清楚。
>
> **规范版本**：本文与进阶篇对齐 **A2A v1.0.x**（`1.0.0` 发布于 2026-03-12，当前补丁 `1.0.1` 发布于 2026-05-26）。v0.3 到 v1.0 有一批**破坏性变更**（枚举值改名、`Part` 类型合并、方法名改 PascalCase、`kind` 判别字段删除、Agent Card 结构重组），网上大量教程还是 v0.3 的写法。凡是有版本陷阱的地方，本文都会明确标注 **⚠️ v1.0 变更**。

---

## 目录

| 章 | 内容 | 读完你能回答 |
|---|---|---|
| 0 | A2A 到底解决什么问题 | 为什么需要它，把 Agent 包成工具为什么不够 |
| 1 | 三个角色：User / Client Agent / Remote Agent | 我在这套协议里是哪一个 |
| 2 | A2A ≠ MCP：横着连 vs 竖着连 | 什么时候该用哪个 |
| 3 | 九个词，先混个脸熟 | Agent Card / Task / Message / Part / Artifact / Context / Skill / Extension / Binding |
| 4 | Agent Card：Agent 的名片 | 发现机制怎么工作，名片上写什么 |
| 5 | Task 与 Message：到底返回哪个 | 什么时候是"一次问答"，什么时候是"一个任务" |
| 6 | Part 与 Artifact：内容与产物 | 怎么传文本、文件、结构化数据，产物归谁管 |
| 7 | 三种收消息方式 | 轮询 / SSE 流式 / 推送通知，各适合什么 |
| 8 | 任务状态机：九个枚举值 | `INPUT_REQUIRED` 为什么是多 Agent 的关键 |
| 9 | 错误：出错了怎么说话 | 九个错误类型、一到九号错误码的直觉 |
| 10 | 串起来：一次"帮我写份报告"全程直播 | 从发现问题到拿到产物经过哪些步骤 |
| 11 | 三个你自己能跑的小观察 | 亲眼看到本文讲的东西 |
| 12 | 自测 20 题（答案在最后） | 检验是否真懂了 |
| 13 | 接下来读进阶篇哪几章 | 按需跳读的路线 |

---

# 第 0 章 A2A 到底解决什么问题

## 0.1 先回忆：MCP 解决了什么，又没解决什么

`docs/MCP入门篇.md` 第 0 章讲过一个 N×M 的故事：N 个 AI 应用要接 M 个外部能力（文件系统、GitHub、数据库……），没有标准就要写 N×M 套胶水代码。MCP 把中间那层标准化，组合数降到 N+M。

**但 MCP 有个前提**：它连接的是**「一个 Agent」和「一堆工具」**。工具是什么？是**没有自主性**的东西——你给它参数，它给你结果，它不会跟你商量、不会问你问题、不会拒绝你、不会自己决定去做点别的。

现在换个场景。你要做一个「差旅助手」，它需要：

- 查航班 → 有个**航班 Agent**
- 订酒店 → 有个**酒店 Agent**
- 换汇 → 有个**换汇 Agent**
- 推荐当地玩乐 → 有个**玩乐 Agent**

这四个东西**不是工具，是 Agent**。它们的区别很具体：

| | 工具（MCP 的领域） | Agent（A2A 的领域） |
|---|---|---|
| 自主性 | 无。参数进，结果出 | 有。会推理、会规划、会拒绝 |
| 状态 | 通常无状态 | 长时运行，跨多轮保持状态 |
| 交互 | 一次调用一次返回 | 可能来回问你好几轮 |
| 时长 | 毫秒到秒 | 秒到小时到天 |
| 内部 | 你可以看它的实现 | **不透明**——你只能看它声明的能力 |
| 出错 | 返回错误码 | 可能说"我需要授权才能继续" |
| 谁写的 | 通常是工具方 | 可能是别人、别的团队、别的公司 |

**关键差别是最后两行。** 工具是「你的下属」，Agent 是「你的同事」。你跟下属说"把这个文件读了"，他读完就完了；你跟同事说"帮我订个酒店"，他可能回你"预算多少？住几晚？"

## 0.2 把 Agent 包成工具，为什么不够

绝大多数人的第一反应是：「那我就把这四个 Agent 各包成一个 MCP 工具不就行了？」

**短期能跑，长期会撞墙。** 官方文档专门为此写了一篇（[Why Agents Are Not Tools](https://discuss.google.dev/t/why-agents-are-not-tools/192812)）。撞的墙具体是这几面：

**第一面：包成工具就丢掉了多轮。** 工具的契约是「一次调用 → 一个返回值」。但「帮我订酒店」这件事天然要多轮：Agent 要先问清楚日期、人数、预算，才能给出报价。你把「问日期」做成工具返回值，调用方（大模型）就得自己理解"这是一个问题，我要去问用户，然后把答案塞回下一次调用"——**这个逻辑现在跑在提示词里，也就是跑在模型的自由发挥里，而不是跑在代码里**。

**第二面：包成工具就丢掉了进度。** 「生成本季度销售报告」要跑十分钟。工具调用是阻塞的：调用方要么干等十分钟（浪费、可能超时），要么放弃。A2A 的做法是**立刻返回一个任务句柄**，然后你可以轮询、可以订阅流、可以让对方在完成时回调你的 webhook。这三件事工具契约都没有。

**第三面：包成工具就丢掉了取消。** 用户说"算了别做了"。工具调用没有标准的取消语义——你可以 abort 本地等待，但**对方还在跑、还在烧钱**。A2A 有 `CancelTask`。

**第四面（最要紧）：包成工具就把对方的内部暴露在你的上下文里了。** 工具调用要求你把「工具的输入输出描述」放进自己的上下文，而且工具返回的内容会直接进你的消息历史。当你把另一个 Agent 包成工具时，等于**让它的输出长驱直入你的上下文**，这在安全上是个大洞（详见 `docs/A2A适配性评估.md` 第 5.1 节）。A2A 的核心原则之一是 **Opaque Execution（不透明执行）**：双方协作只交换"声明过的能力"和"交换的内容"，**不需要**知道对方内部怎么想、有什么工具、记着什么。

一句话总结：

> **MCP 让 Agent 能"用"东西，A2A 让 Agent 能"找人"。**

## 0.3 没有 A2A 会怎样：又是 N×M

假设你的差旅助手要和四个 Agent 协作。没有标准，你要为每一个写一套私有对接：航班方用 REST + 自己的错误码，酒店方用 gRPC + 自己的认证，换汇方用 WebSocket，玩乐方给了个 SDK。

然后你想再加两个 Agent，或者换个框架重写自己，或者要把自己的 Agent 开放给别人调——**每一对组合都要重新写一遍。**

这就是 MCP 遇到的同一个 N×M 问题，只是层级不同：

```
   你的助手 ──私有①── 航班 Agent
            ──私有②── 酒店 Agent
            ──私有③── 换汇 Agent
            ──私有④── 玩乐 Agent
            → 最坏 N×M 套胶水代码
```

A2A 把中间那层标准化，于是变成：

```
   [N 个 Agent]  ←── A2A 标准 ──→  [M 个 Agent]
```

**和 USB-C 的类比在 A2A 这里同样成立**（`docs/MCP入门篇.md` 第 0.3 节）。这里可以再补一层更贴切的比喻：

> **MCP 是"你的电脑接外设"的 USB。A2A 是"两台电脑之间通话"的协议**——比如 SMTP 或者电话。两台电脑不需要知道对方装了什么软件、用什么操作系统，只要都会说这套话就行。

## 0.4 一句提醒

和 MCP 一样，A2A 和"是不是 AI"无关。它纯粹是**两个程序之间怎么说话**的规范。你那四个"Agent"完全可以换成四个假程序——收到消息就返回固定 JSON——协议照样能跑通。

> 自查：A2A 是"让模型更聪明"的东西，还是"让程序之间互通"的东西？让两个agent通信的标准

---

# 第 1 章 三个角色：User / Client Agent / Remote Agent

MCP 有三个角色（Host / Client / Server）。A2A 也有三个，但**其中一个不是程序**。

## 1.1 User（用户）

规范原文说得很宽：

> **User**: The end user, which can be a human operator or an automated service.

**可以是人，也可以是一段自动化服务。** 这一条很重要，因为 A2A 里的 Agent 常常是「代表某个 User 去说话」的。你的差旅助手代表你（人）去和航班 Agent 说话；航班 Agent 背后可能是航空公司的一段自动化服务。

## 1.2 A2A Client（客户端 Agent）

**发起请求的那一方。**

规范叫它 "A2A Client (Client Agent)"。注意名字里既有 Client 又有 Agent——**它是"扮演客户端角色的 Agent"**。

对你来说：如果 `A:\ai_agent` 主动去调用别人的 Agent，那它就是 A2A Client。它需要做三件事：**发现**对方（拿到 Agent Card）、**认证**（按名片上的要求出示凭据）、**发消息**（`SendMessage`）。

## 1.3 A2A Server（远端 Agent）

**提供能力、接受请求的那一方。** 规范也叫它 "Remote Agent"。

它对外暴露一个 HTTP 端点，实现 A2A 协议。**对客户端来说它是黑盒**：

> To the client, the remote agent is an _opaque_ (black-box) system: its internal workings, memory, and tools stay hidden.

这句 "opaque"（不透明）是 A2A 的设计灵魂。回想第 0.2 节第四面墙——**不透明不是限制，是特性**：它保护了对方的商业机密，也保护了你（你不会不小心把自己的内部塞进对方上下文）。

## 1.4 一张图 + 你的代码在哪

```
   ┌──────┐                  ┌──────────────────┐                  ┌────────────────┐
   │      │                  │                  │   A2A 协议       │                │
   │ User │ ───────────────► │  A2A Client      │ ───────────────► │  A2A Server    │
   │      │   (人 或 服务)    │  (Client Agent)  │   JSON-RPC/HTTP  │ (Remote Agent) │
   └──────┘                  └──────────────────┘                  └────────────────┘
                                     ▲                                      │
                                     │                                      │ MCP
                              你的 A:\ai_agent                        （对方自己的工具，
                           （如果它主动发起请求）                        你看不见）
```

对照你的代码：

- 你现在的 `src/index.ts` + `src/core/agent.ts` 是**一个完整的 Agent**（有主循环、有工具、有记忆）。
- 它通过 `src/mcp/` 和外部能力说话 → 那是 **MCP 的 Client 侧**。
- **它现在既不是 A2A Client 也不是 A2A Server**——两边都没有实现。所以第 1.2 / 1.3 节的两个角色，对你来说是"要新增的两个身份"。
- 而它已经具备的一切（主循环、工具注册表、事件总线），恰好就是扮演这两个角色所需要的引擎。

## 1.5 一个容易搞混的点：Client 和 Server 是**相对的**

同**一个** Agent，在两次不同的交互里可能角色不同：

- 你的助手去调酒店 Agent → 你的助手是 **Client**
- 别人来调你的助手 → 你的助手是 **Server**

这跟 Web 服务器一样：你的浏览器是 HTTP 客户端，你的 Node 服务是 HTTP 服务端；但你的 Node 服务去调数据库时，它又变成了数据库的客户端。**角色是"这次交互里的位置"，不是"这个东西的属性"。**

> 自查：一个 Agent 能不能同时是 A2A Client 和 A2A Server？可以

---

# 第 2 章 A2A ≠ MCP：横着连 vs 竖着连

这是最容易混、也最值得先讲清的一章。

## 2.1 官方给的两个词：Vertical 与 Horizontal

规范文档（[A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)）用了一对非常精准的词：

> **MCP is vertical.** It deepens a single agent.
>
> **A2A is horizontal.** It connects agents across that boundary.

翻译成人话：

- **MCP 是竖着连**：从「一个 Agent」往**下**连到工具、数据、API。连得越多，**这一个 Agent 越能干**。
- **A2A 是横着连**：从「一个 Agent」往**旁边**连到**另一个 Agent**。对方可能在另一个团队、另一个部门、另一家公司。连得越多，**你这套系统的覆盖面越广**。

一句话：

> **MCP 给每个 Agent 深度，A2A 给你的系统广度。**

## 2.2 官方那个"修车铺"例子（推荐记住）

规范里有个很好的例子，我复述一下，因为它把两者如何配合说透了。

一个**修车铺**，员工全是 AI Agent「机修工」。它们有专用工具：车辆诊断仪、维修手册数据库、举升机。

一次完整的服务是这样：

| 步骤 | 谁和谁说话 | 用哪个协议 |
|---|---|---|
| 1 | 客户（或其助理 Agent）→「服务经理」Agent：「我的车有异响」 | **A2A** |
| 2 | 服务经理 ↔ 客户，来回问诊：「能发段异响的视频吗？」「我看到有液体渗漏，多久了？」 | **A2A** |
| 3 | 机修工 Agent 去用工具：`scan_vehicle_for_error_codes(vehicle_id='XYZ123')` | **MCP** |
| 4 | 机修工 Agent 查手册：`get_repair_procedure(error_code='P0300', ...)` | **MCP** |
| 5 | 需要举升机：`raise_platform(height_meters=2)` | **MCP** |
| 6 | 发现要换零件，机修工 Agent →「零件供应商」Agent：「有 2018 Camry 的 #12345 吗？」 | **A2A** |
| 7 | 供应商 Agent 回应，促成订单 | **A2A** |

看明白了吗：

- **凡是"人手下的工具在干活"** → MCP（第 3、4、5 步）
- **凡是"两个有自主性的角色在商量"** → A2A（第 1、2、6、7 步）

而且注意第 2 步：**问诊是多轮的、信息是逐步明确的。** 这正是工具契约做不到的部分。

## 2.3 一张对照表

| 维度     | MCP                       | A2A                                |
| ------ | ------------------------- | ---------------------------------- |
| 连接方向   | 竖（Agent → 工具/数据）          | 横（Agent ↔ Agent）                   |
| 对端性质   | 无自主性的能力                   | 有自主性的对等方                           |
| 对端可见性  | 你可以看它的实现                  | **不透明**（Opaque Execution）          |
| 交互时长   | 毫秒～秒                      | 秒～小时～天                             |
| 状态     | 通常无状态                     | **Task 有完整生命周期**                   |
| 多轮     | 无协议级多轮                    | **协议级多轮**（`INPUT_REQUIRED`）        |
| 进度     | `notifications/progress`  | SSE 流 + 推送通知                       |
| 取消     | `notifications/cancelled` | `CancelTask` + `SubscribeToTask`   |
| 发现     | 配置里写死 Server 列表           | **Agent Card**（`.well-known` 自动发现） |
| 身份/鉴权  | 由 Host 自己管                | **协议声明** `securitySchemes`         |
| 传输     | stdio / Streamable HTTP   | JSON-RPC over HTTP、gRPC、HTTP/REST  |
| 底层消息格式 | JSON-RPC 2.0              | JSON-RPC 2.0（或 gRPC / REST）        |
| 出身     | Anthropic（2024 年底）        | Google（2025 年 4 月），后捐给 Linux 基金会   |

**最后一行值得单独说**：两者**都用 JSON-RPC 2.0**。这不是巧合——它意味着如果你已经理解了 MCP 的报文长什么样（`docs/MCP入门篇.md` 第 3 章），A2A 的报文你基本上已经会读了。差异在**方法名**和**数据结构**，不在"怎么把一条消息装进 HTTP 请求"这件事上。

## 2.4 一个反过来的证据：Agent-as-Tool 不是错的

既然两个协议都基于 JSON-RPC，那**「把 A2A Agent 伪装成 MCP 工具」在技术上完全可行**——官方文档甚至专门讲了这个做法（[Representing A2A Agents as MCP Resources](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)）：

> An A2A Server (a remote agent) can expose some skills as MCP-compatible resources. This works best when the skills are well-defined and can be called in a tool-like, stateless way.

**官方自己承认这个做法在"技能定义良好、可当无状态调用"时是合适的。** 但它紧接着补了一句：

> Still, A2A's main strength is its support for flexible, stateful, collaborative interactions that go beyond a typical tool call.

所以正确的理解不是「A2A 比 Agent-as-Tool 高级」，而是：

> **Agent-as-Tool 是 A2A 的一个降级特例。** 短任务用前者（便宜），长任务/多轮任务用后者（贵但对）。

这条判断对你有实际价值，因为它意味着**你不必一步到位**：先把远端 Agent 当工具用起来，等真遇到"多轮/长时/要进度"的需求再升级。`docs/A2A适配性评估.md` 第 3 章就是这个分级。

## 2.5 一条历史：为什么现在是"两家说了算"

这一节讲背景，但它能解释一件对你很实际的事：**为什么你不必再纠结"该押注哪个 Agent 互操作协议"。**

**2025 年 4 月**：Google 发布 A2A，同时公布 50 多家合作伙伴。当时的局面是"协议混战"——除了 A2A 和 MCP，还有 IBM 的 ACP（Agent Communication Protocol，走 REST/OpenAPI 原生路线）、Cisco 主导的 AGNTCY、ANP 等等。

**2025 年 6 月 23 日**：Google 把 A2A 捐给 Linux 基金会。

**2025 年 8 月 29 日**：**IBM 的 ACP 并入 A2A**，在 Linux 基金会下统一。（这条有硬证据：ACP 的仓库 `i-am-bee/acp` 现在 `archived: true`，最后一次提交停在 **2025-08-25**，open issues 归零——它就是在那时冻结的。）官方后来的定性很直白：

> In August 2025, IBM's Agent Communication Protocol merged into A2A showing that the field was moving toward **a single shared standard rather than competing ones**.

**2025 年 12 月 9 日**：Linux 基金会成立 **Agentic AI Foundation（AAIF）**，首批项目是 Anthropic 的 MCP、Block 的 goose、OpenAI 的 AGENTS.md。

**2026 年 8 月**：**A2A 加入 AAIF**。于是整个开放栈变成了一个分层结构：

| 层 | 项目 | 管什么 |
|---|---|---|
| 指令与上下文 | AGENTS.md | Agent 的指令约定 |
| 运行时 | goose | Agent runtime |
| **工具连接** | **MCP** | **agent-to-tool** |
| 流量中介 | agentgateway | 网关与控制 |
| **Agent 互操作** | **A2A** | **agent-to-agent** |

**对你的实际含义有三条**：

1. **MCP 和 A2A 现在是同一个治理容器下的两层，不是竞争关系。** 你不用二选一。`docs/MCP入门篇.md` 学到的东西不会浪费——它管的是下面那层。
2. **你正在读的这个协议有明确的机构背书。** Google、Microsoft、AWS、Cisco、IBM Research、Salesforce、SAP、ServiceNow 都在 A2A 的技术指导委员会里。
3. **但"标准统一"不等于"生态成熟"。** A2A 的官方工具体系（[a2a-inspector](https://github.com/a2aproject/a2a-inspector) 约 500 star、[a2a-tck](https://github.com/a2aproject/a2a-tck) 约 50 star）规模**远小于** MCP 生态（MCP 在 2025 年底已有上万个已发布 server）。**这意味着你会遇到"文档齐、实现少"的阶段**，得自己动手的地方比 MCP 多。

> 顺带一个**命名陷阱**，你在搜索时会撞上：**有两个都叫 ACP 的东西**。一个是 **IBM 的 Agent Communication Protocol**（2025 年 8 月并入 A2A）；另一个是 **OpenAI 的 Agentic Commerce Protocol**（2025 年 12 月随 AAIF 新闻稿提及，管的是商业支付，不是 Agent 通信）。缩写一样，东西完全不同。

## 2.6 四层辨析：别把所有"连接"都当成 A2A

第 2.1 节的"竖着连 / 横着连"是一条判据，但现实里有**四种**容易互相混淆的"连接"，它们分属不同层次。分清楚这个，能挡住八成概念混淆。

| 层次 | 是什么 | 运行时判据 | 例子 |
|---|---|---|---|
| **一、工件迁移** | 搬配置、搬记录、转格式 | **一方离线**，纯文件读写；对方不知道发生了什么 | ChatGPT 的 [Import from another agent](https://learn.chatgpt.com/docs/import)（读 Cursor / Claude Code 的本地配置转成自己的格式） |
| **二、模型即工具** | 调一个远端 LLM | 没有自主性、无状态、一问一答 | 任何一个 Agent 调模型 API |
| **三、Agent 即工具** | 调一个完整 Agent，但按工具语义用 | 有自主性，但**不能被回问**、无任务生命周期 | 把子 Agent 包成一个 `ToolDefinition` |
| **四、A2A** | 和对等 Agent 协作 | 有 **Task 生命周期** + 能中断（`INPUT_REQUIRED`）+ 能力发现 | 你的助手 ↔ 酒店 Agent |

### 一句话判据（比看架构图快）

> **对方能被问、也能反过来问你吗？**
>
> 只能被读 → **工件迁移**
> 能被调、能返回结果 → **Agent 即工具**
> 能被调、还会**反过来问你问题**、还会**拒绝**你 → **A2A**

第三档就是 `TASK_STATE_INPUT_REQUIRED` / `TASK_STATE_REJECTED` 存在的意义。**一个不会反驳你的东西，不是同事，是下属或资料。**

### 三个容易误判的实例

- **"ChatGPT 和 Cursor 同步了"** → 是**第一层**。那个功能是读本地配置文件（`CLAUDE.md` → `AGENTS.md`、`settings.json` → `config.toml`、最近 30 天聊天记录 → ChatGPT chats），**单向、离线、对方不参与**。跟 git pull 读仓库没有本质区别。
- **"Cursor 里挂了 ChatGPT"** → 是**第二层**或根本没有连接（同一个助手换了个壳）。
- **"把 Agent 挂成 MCP 工具"** → 是**第三层**。官方文档自己承认这可行，但限定在"skill 定义良好、可以像工具一样无状态调用"时。

### 重要：这四层不是"先进程度"的排序

**别把它们读成"第一层最土、第四层最高级"。** 它们是**运行时语义的分类**，各有各的适用场景：

- 工件迁移**根本不需要** A2A
- Agent 即工具在很多场景下比 A2A **更理性**（短任务、无状态、省掉任务生命周期和鉴权的全部开销）

官方文档自己就说过：把 A2A 的 skill 暴露成 MCP 资源，**"最适合那些定义良好、可像工具一样无状态调用的 skill"**。所以判据不是"双方是不是 AI 产品"，而是**运行时到底在发生什么**。

## 2.7 MCP 的 sampling 是 A2A 的前身吗？

**不是前身，是同源的两个分支。** 这个误解很常见（而且很自然），值得单独澄清。

### 误解从哪来

MCP 有个反向能力叫 **sampling**：Server 可以对 Client 说"借你的模型算一次"。看起来很像 agent 间协作，于是很自然会想"这不就是 A2A 的雏形吗"。

### 直接的历史证据

MCP 仓库里有人提过**完全一样的假设**：[issue #503 "Reframe sampling as a basis for bidirectional agent-to-agent communication"](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/503)（2025-05-09 提交，2026-06-26 关闭）。

作者指出 sampling 其实已经具备做协作的三件东西：**可预载消息历史**（Server 塞一段对话让 Client 续写）、**上下文共享**（`systemPrompt` / `includeContext`）、**嵌套执行**（在一次工具调用内部发起 sampling）。

然后他给了最关键的一条：

> [A2A](https://google.github.io/A2A/topics/a2a-and-mcp/) and ACP support agent-to-agent communication with their own mechanisms on top of MCP, and interestingly **don't mention sampling in their justifications for standing up new agent-oriented protocols at all**。

**从设计血统上看，A2A 不是从 sampling 演化来的** —— A2A 论证自己存在的理由时压根没提 sampling。

### 为什么它成不了 A2A：规范把人锁在环里

看 sampling 规范的 User Interaction Model 段落（[2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling)）：

> For trust & safety and security, there **SHOULD** always be a human in the loop with the ability to deny sampling requests.

并且要求 Client 应支持"发送前审阅并修改 prompt、投递前审阅并修改回复"。

**注意：这是段落级的定位，不是一个可以关掉的参数。**（网上流传的 `humanInLoop` 参数并不存在 —— 这个错误也出现在本地 `docs/MCP进阶篇.md` 的早期版本里，已修正。）

**含义**：如果每次 sampling 都预期被人看一眼，那它做不了长时任务、做不了自动编排、做不了无人值守的委派 —— 而这些恰恰是 A2A 存在的全部理由。

### 最短的记法

> **sampling 是"借脑子"，A2A 是"找同事"。**

| | MCP Sampling | A2A |
|---|---|---|
| 要的是什么 | 一次**模型推理** | 一个**任务结果** |
| 对方为什么不做 | 它**没有**模型（不想自带 key） | 它**有自己的模型**，只是这件事不该它做 |
| 借用的实质 | 一个**函数** | 一个有**自主性**的对等方 |
| 人必须介入 | **SHOULD always** | 不要求（中断态时才可选） |
| 状态 | 无 | Task + 状态机 + `taskId`/`contextId` |
| 能力发现 | 无（`modelPreferences` 是**挑模型**的偏好） | `AgentCard` + `skills`（互相发现"你会什么"） |
| 能反过来问吗 | 不能问"要不要澄清/能不能拒绝" | 能（`INPUT_REQUIRED` / `AUTH_REQUIRED` / `REJECTED`） |

### 那它们共享什么

**共享同一祖先：双向协议 —— "对端可以反向发起请求"。**

MCP 的真正贡献是让**工具第一次能反过来说话**：`roots/list` 问边界、`sampling/createMessage` 借模型、`elicitation/create` 问用户。在 function calling 时代，这三件事一件都做不到。

A2A 继承的正是这条洞察，然后把它从"工具借能力"扩展到"对等方协作任务"：

```
        共同祖先：双向协议（对端能反向发起请求）
                     │
         ┌───────────┴───────────┐
    竖着用：借能力            横着用：协作任务
    （MCP: sampling/roots/    （A2A: AgentCard/
      elicitation）              Task/INPUT_REQUIRED）
```

**同源的两个分支，不是前后两代。**

## 2.8 自查

> 我现在想让远端 Agent 帮我做一件事，它是"一次问答"还是"一个可能要来回几次的任务"？我该用哪个协议/哪种形态？

---

# 第 3 章 九个词，先混个脸熟

这一章只是词典，不求记住。后面每章会展开。

## 3.1 一览表

| 词              | 一句话                             | 类比         | 详见          |
| -------------- | ------------------------------- | ---------- | ----------- |
| **Agent Card** | 描述这个 Agent 是什么、会什么、怎么连的 JSON 文档 | 名片 / 菜单    | 第 4 章       |
| **Task**       | 一个有状态的工作单元，有唯一 ID 和生命周期         | 工单         | 第 5、8 章     |
| **Message**    | 一轮对话，有 `role` 和若干 `Part`        | 一句话        | 第 5、6 章     |
| **Part**       | 内容的最小容器：文本 / 文件 / 结构化数据         | 一句话里的一个"件" | 第 6 章       |
| **Artifact**   | Agent 产出的**交付物**                | 工单的附件成品    | 第 6 章       |
| **contextId**  | 把相关的多个 Task 和 Message 归为一组      | 会话 / 工单号前缀 | 第 5 章       |
| **Skill**      | Agent 声明的一项能力                   | 菜单上的一道菜    | 第 4 章       |
| **Extension**  | 在核心协议之外扩展能力的机制                  | 自定义 HTTP 头 | 进阶篇         |
| **Binding**    | 同一套语义在不同传输上的具体写法                | 同一句话用三种外语说 | 第 7 章 + 进阶篇 |

## 3.2 三个最容易搞混的区分

**① Task（工单）vs Message（一句话）**

- `Message` 是一轮**通信内容**。可以独立存在（客户问一句，Agent 答一句，结束）。
- `Task` 是一个**工作单元**，有 ID、有状态、有历史、可能产出 `Artifact`。
- 一次交互**可能**只产生 Message（简单问答），**也可能**产生 Task（要干活）。

**② Part（内容件）vs Artifact（产物）**

- `Part` 是**容器类型**，`Message` 和 `Artifact` **都用它**装内容。
- `Artifact` 是**语义角色**：它代表"这次任务的交付物"。
- 所以：`Message.parts` 是"这一轮说的话"，`Artifact.parts` 是"交付的成品"。

**③ contextId（上下文）vs taskId（任务）**

- `contextId` **归组**，由服务端生成，把一串相关的 Task/Message 串成一个"会话"。
- `taskId` **标识**单个 Task。
- 一个 `contextId` 下可以有**多个** `taskId`（甚至并行跑）。这是 A2A 做"迭代式协作"的关键（第 5.4 节会讲）。

> 自查：`contextId` 和 `taskId` 谁是谁的容器？

---

# 第 4 章 Agent Card：Agent 的名片

## 4.1 为什么需要"发现"

你想调航班 Agent，但你得先知道：**它的地址是什么？它会什么？它要我怎么认证？它支持流式吗？**

硬编码进配置当然可以，但那样"发现"就不是动态的了。A2A 给了一个标准答案：**Agent Card**。

## 4.2 怎么找到它：两种方式

**方式一：Well-Known URI（推荐，用于公开 Agent）**

规则极其简单：**在你域名的固定路径上放这个 JSON 文件。**

```
https://{你的域名}/.well-known/agent-card.json
```

`/.well-known/` 这个前缀是个互联网惯例（RFC 8615），意思是"我要在这个固定位置声明一件标准的事"。你现在访问 `https://某站点/.well-known/security.txt` 能看到它的安全联系方式，是同一个思路。

于是发现流程就是：

1. 客户端知道或猜到了域名 `flight.example.com`
2. `GET https://flight.example.com/.well-known/agent-card.json`
3. 拿到名片，读里面的信息
4. 按名片上的要求去认证、去发消息

**⚠️ 路径变更史（务必记住）**：`0.1.0` 和 `0.2.x` 用的是 **`/.well-known/agent.json`**；改名发生在 **`0.3.0`（2025-07-30，PR #841）**，v1.0 沿用 `agent-card.json`。

**这意味着现实里两种路径都会遇到。** 你的客户端两个都该试——这是一个非常常见的"为什么连不上"的原因。

**方式二：注册中心（Registries / Catalogs）**

企业内或公开市场上，名片统一存在一个目录服务里，客户端按条件（比如"谁会做汇率换算"）去查。规范**没有**规定这个目录的 API，属于各家自己实现。

**方式三：直接配置**

写死在配置里或环境变量里。适合内部固定的几个 Agent。规范也承认这种方式：

> **Advantages:** This method is straightforward for establishing connections within known, static relationships.

## 4.3 名片上写什么

一份真实的 Agent Card（v1.0 结构）大概长这样：

```json
{
  "name": "差旅助手",
  "description": "帮你规划国际旅行：航班、酒店、换汇、当地玩乐",
  "version": "1.0.3",

  "supportedInterfaces": [
    {
      "url": "https://travel.example.com/a2a/v1",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    },
    {
      "url": "https://travel.example.com/a2a/rest/v1",
      "protocolBinding": "HTTP+JSON",
      "protocolVersion": "1.0"
    }
  ],

  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extendedAgentCard": false
  },

  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],

  "skills": [
    {
      "id": "plan-trip",
      "name": "行程规划",
      "description": "根据预算与日期规划完整行程",
      "tags": ["travel", "planning"],
      "examples": ["帮我规划 5 月去赫尔辛基的 5 天行程，预算 2 万"],
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain", "application/json"]
    }
  ],

  "securitySchemes": {
    "bearer": {
      "httpAuthSecurityScheme": { "scheme": "Bearer", "bearerFormat": "JWT" }
    }
  },
  "security": [{ "bearer": [] }],

  "signatures": []
}
```

逐个看重点字段：

| 字段 | 作用 | 你该注意什么 |
|---|---|---|
| `name` / `description` | 身份 | 会被人和模型读，写清楚是值得的 |
| `version` | Agent 版本 | 能力变了要变，客户端靠它判断是否重新拉取 |
| `supportedInterfaces` | **（v1.0 新）** 支持的传输与地址列表 | **按偏好排序**，第一个是首选。客户端必须挑一个自己支持的，并**用对应的 URL** |
| `capabilities.streaming` | 会不会流式 | 不会的话你调 `SendStreamingMessage` 会被拒 |
| `capabilities.pushNotifications` | 支不支持 webhook 回调 | 不支持的话推送通知相关操作会报错 |
| `capabilities.extendedAgentCard` | 有没有"认证后才给看"的详细名片 | 敏感信息放这里，公开名片只放基础信息 |
| `skills` | **会什么** | 这是客户端决定"要不要找它"的依据 |
| `securitySchemes` / `security` | 怎么认证 | 凭据要**带外获取**（见下） |
| `signatures` | 名片本身的签名 | 防伪造，见第 4.5 节 |

**⚠️ v1.0 变更（三处，都是破坏性的）**：

1. **`url` 被 `supportedInterfaces` 取代**。v0.3 的 `AgentCard.url` 是单个字符串；v1.0 变成列表，每项是一个 `AgentInterface`（字段：`url` / `protocolBinding` / `protocolVersion` / `tenant`）。
2. **`protocolVersion` 从名片顶层搬进了每个 `AgentInterface`**。也就是说：**同一个 Agent 可以同时用 v0.3 和 v1.0 对外服务**，靠接口条目区分。这是很聪明的向后兼容设计。
3. **`supportsAuthenticatedExtendedCard` 现在是 `capabilities.extendedAgentCard`**。

另外两处也容易踩：

- **`security` 改名为 `securityRequirements`**（v1.0）。
- **`capabilities.stateTransitionHistory` 被删除了**（它存在于 0.1.0 到 0.3.0，但一直没实现；v1.0 直接移除）。如果你看到教程里写这个字段，那是旧版本的。

如果你在网上找教程，看到 `"url": "http://..."` 写在名片顶层的——**那是 v0.3 的写法**。

## 4.4 `securitySchemes`：认证在协议**外面**

这一条很重要，容易误解：

> **A2A 不自己发明认证机制。** 它复用标准 Web 实践（HTTP 头 + OAuth2/OIDC/API Key/mTLS），名片只负责**声明**"我需要哪种"。

规范原文（第 7 章开头）：

> A2A treats agents as standard enterprise applications, relying on established web security practices. **Identity information is handled at the protocol layer, not within A2A semantics.**

流程是三步：

1. **发现要求**：读名片上的 `securitySchemes`
2. **带外取凭据**：按该方案去拿 token（比如走 OAuth2 授权码流程拿 JWT）
3. **随请求携带**：每次 A2A 请求都在 HTTP 头里带上

**注意第 2 步是"带外"（out-of-band）的**：拿 token 这件事**不通过 A2A 协议本身**，而是走标准 OAuth 流程。规范还特别建议：

> The A2A specification strongly recommends the use of out-of-band dynamic credentials rather than embedding static secrets within the Agent Card.

**别把密钥写进名片里。** 名片是公开的（至少在 well-known 路径上是）。

## 4.5 `signatures`：名片也可能是假的

想一个攻击场景：你信任 `flight.example.com`，但有攻击者能篡改你拿到的名片内容（比如中间人，或者你从某个注册中心拿的），把 `url` 改成他自己的服务器。然后你所有请求和凭据都会发到他那里。

A2A 的防线是**给名片签名**，用标准 JWS（JSON Web Signature，RFC 7515）：

- 签名前要先把名片**规范化**（RFC 8785 的 JSON Canonicalization Scheme）——因为 JSON 里字段顺序、空白不影响语义，但会影响签名字节，所以必须先统一成一个确定的字节序列。
- 签名时**要排除 `signatures` 字段本身**（否则自己签自己，循环依赖）。
- 验证时：拿公钥（通过 `kid` 和 `jku` 找 JWKS），重做规范化，验签。

规范的建议是：

> Clients **SHOULD** verify at least one signature before trusting an Agent Card.

**签名是可选的**（`MAY be digitally signed`）。所以现实里你会遇到没签名的名片。这时候你只能靠传输安全（HTTPS）建立信任。这个取舍在进阶篇第 8 章会再讲。

## 4.6 名片的缓存

名片变化很少（加了个 skill、改了个认证要求），所以规范要求：

- **服务端**：加 `Cache-Control`，加 `ETag`（可以用 `version` 或内容哈希算）
- **客户端**：遵守缓存语义，过期后用 `If-None-Match` 条件请求，别无条件重拉

**为什么值得专门写一节**：如果你在 Agent 主循环里每次都拉名片，会白白多一轮网络往返，还可能被限流。缓存一下，很便宜。

> 自查：名片上的 `supportedInterfaces` 有两项，一个是 JSONRPC 一个是 gRPC，你的客户端只支持 JSONRPC，你该怎么做？

---

# 第 5 章 Task 与 Message：到底返回哪个

## 5.1 两种回应

客户端发了一条消息（`SendMessage`）。服务端可以回两种东西之一：

1. **`Message`** —— "一句话就答完了，不用记着这件事"
2. **`Task`** —— "这事得干一会儿，给你个工单号，后面来查"

规范把这个选择描述得很清楚：

> - **Respond with a Stateless `Message`**: Use this for immediate, self-contained interactions.
> - **Initiate a Stateful `Task`**: The agent runs a `Task` through a defined lifecycle.

**判断标准就一条：这件事结束后还需要记住状态吗？**

- "今天北京天气怎么样" → 答完就完了 → `Message`
- "帮我把这 200 页 PDF 翻译成中文" → 要跑很久、要能查进度、可能要中断 → `Task`

## 5.2 服务端可以有三档风格（这个分类对你设计自己的 Agent 很有用）

规范把 Agent 按复杂度分了三类：

**① Message-only Agent（只会回话）**

永远返回 `Message`。典型是"直接包一层 LLM 调用 + 简单工具"的 Agent。用 `contextId` 把消息串起来。

**优点**：简单。**缺点**：长任务没法表达。

**② Task-generating Agent（一切皆任务）**

永远返回 `Task`。哪怕只是答一句天气，也建一个 `TASK_STATE_COMPLETED` 的 Task。

**优点**：客户端逻辑统一，不用判断"这次是哪种"。**缺点**：简单交互也产生了一堆 Task 对象，存储和追踪成本高。

**③ Hybrid Agent（混合）**

**用 `Message` 协商，用 `Task` 干活。** 规范的原话很精辟：

> `Message` objects carry the lightweight back-and-forth that establishes what should be done, and a `Task` is created once there is committed work to execute and observe.

翻译：**还没说清楚要干什么的时候用 Message 聊；一旦确定要动手了，就开一个 Task。**

**这个分类对你直接有用。** 你要给 `A:\ai_agent` 加 A2A 支持时，第一件事就是选一档。建议：**从 Hybrid 开始**——因为你的 Agent 本来就有"判断这个任务要不要调工具"的能力，这个判断恰好就是从 Message 升级到 Task 的时刻。

## 5.3 一个硬规矩：Task 一旦终态，不可复活

规范（[Life of a Task](https://a2a-protocol.org/latest/topics/life-of-a-task/)）：

> Once a task reaches a terminal state (completed, canceled, rejected, or failed), **it cannot restart.** Any subsequent interaction related to that task, such as a refinement, must initiate a **new task** within the same `contextId`.

**为什么定这个规矩**，规范给的理由很实在：

1. **Task 不可变（Immutability）**：客户端可以稳定地引用一个 task 及其状态和产物，输入到输出的映射干净，便于编排和追溯。
2. **工作单元清晰（Clear Unit of Work）**：每次新请求、每次修改、每次追问都是一个独立 Task，记账和产物溯源都简单。
3. **实现更简单（Easier Implementation）**：开发者不用纠结"我该新建还是重启"。

**对你的含义**：如果你想"在原来那个结果上再改一改"，正确做法不是往老 task 发消息，而是**同一个 `contextId` + 一个新的 `taskId`**，并用 `referenceTaskIds` 指向那个老 task。见下。

## 5.4 多轮与迭代：`contextId` + `referenceTaskIds`

**第一次**：客户端发消息（无 `contextId`）→ 服务端返回一个新的 `contextId`，如果开了 Task，还有一个 `taskId`。

**继续说**：客户端在后续消息里带上**同一个 `contextId`**。可选地再带上 `taskId`，表示"我这是在接着某个具体任务说"。

**要改上一版的产物**：开一个**新 Task**（同一个 `contextId`），并在消息里用 `referenceTaskIds` 指向老 task：

```json
{
  "message": {
    "role": "ROLE_USER",
    "messageId": "msg-user-002",
    "contextId": "ctx-conversation-abc",
    "referenceTaskIds": ["task-boat-gen-123"],
    "parts": [{ "text": "把帆船改成红色的。" }]
  }
}
```

规范还专门讨论了「产物版本追踪」，有个反直觉的结论：

> **The client is best placed to manage this artifact linkage.** ... So the serving agent shouldn't track artifact mutations, and this linkage is not part of the A2A protocol specification.

也就是说：**版本历史由客户端自己管**。服务端只承诺一件事：

> serving agents should reuse a consistent `artifact-name` when they generate a refined version of an existing artifact.

**同一个名字，新的 `artifactId`。** 客户端靠"名字相同"认出这是同一个产物的新版本。

**这个设计的道理**：只有客户端知道"什么算可接受的结果"，所以只有客户端有资格决定保留哪个版本。服务端作为产出一方，不该替客户端做这个判断。

## 5.5 并行：同一个 `contextId` 下可以同时跑多个 Task

规范举的例子很直观：

- Task 1：订去赫尔辛基的机票
- Task 2：基于 Task 1 订酒店
- Task 3：基于 Task 1 订雪地摩托
- Task 4：基于 Task 2 给酒店加个 SPA

**这就是多 Agent 编排的样子。** 注意 Task 2/3 依赖 Task 1，Task 4 依赖 Task 2——依赖关系通过 `referenceTaskIds` 表达，而**协议本身不做调度**。调度是你的编排逻辑的事。

> 自查：用户对上一轮的结果不满意，说"再改改"。你该往老 task 发消息，还是开新 task？为什么？

---

# 第 6 章 Part 与 Artifact：内容与产物

## 6.1 Part：一个"内容件"

`Part` 是 A2A 里装内容的最小单位。**它是个"四选一"**——一个 Part 里必须**恰好**放下面四样之一：

| 字段 | 装什么 | 典型用法 |
|---|---|---|
| `text` | 纯文本字符串 | 说的话、一段 markdown |
| `raw` | 内联的二进制字节 | 小图片、小文件，直接在消息里 |
| `url` | 指向外部文件的 URI | 大文件，别塞进消息，给个链接 |
| `data` | 结构化 JSON 值 | 表单、参数、机器可读的结果 |

另外每个 Part 还能带：

- `mediaType`：MIME 类型（`"text/plain"`、`"image/png"`、`"application/json"`）
- `filename`：文件名
- `metadata`：自定义键值对

**⚠️ v1.0 变更（这是最大的破坏性变更）**：v0.3 里这四种内容是四种子类型（`TextPart` / `FilePart` / `DataPart`，文件还分 `FileWithBytes` / `FileWithUri`）。v1.0 **合并成一个统一的 `Part`**，直接用 `text` / `raw` / `url` / `data` 字段。

对比一下（[a2a-python 迁移指南](https://a2aproject.github.io/a2a-python/docs/migrations/v1_0/)）：

| 内容 | v0.3 | v1.0 |
|---|---|---|
| 文本 | `Part(TextPart(text=...))` | `Part(text=...)` |
| 文件（字节） | `Part(FilePart(file=FileWithBytes(bytes=...)))` | `Part(raw=...)` |
| 文件（URI） | `Part(FilePart(file=FileWithUri(uri=...)))` | `Part(url=...)` |
| 结构化数据 | `Part(DataPart(data=...))` | `Part(data=...)` |

**为什么这个改动值得注意**：它让"内容件"这个概念真正统一了。你现在不需要在四个类型之间做分支判断，只需要看哪个字段有值。这是简化，但**它是不兼容的**——老代码会直接跑不通。

## 6.2 一个 Message 长什么样

```json
{
  "role": "ROLE_USER",
  "messageId": "6dbc13b5-bd57-4c2b-b503-24e381b6c8d6",
  "parts": [
    { "text": "分析这张图，把里面的人脸框出来。" },
    {
      "raw": "iVBORw0KGgoAAAANSUhEUgAAAAUA...",
      "filename": "input_image.png",
      "mediaType": "image/png"
    }
  ]
}
```

三个必看字段：

- **`role`**：`ROLE_USER` 或 `ROLE_AGENT`。**⚠️ v1.0 变更**：v0.3 是小写 `"user"` / `"agent"`，v1.0 是 `"ROLE_USER"` / `"ROLE_AGENT"`。
- **`messageId`**：这条消息的唯一 ID。**它有实际用途**：规范说 `SendMessage` 可能具备幂等性，服务端**可以用 `messageId` 检测重复消息**（规范 3.3.1）。所以网络抖动重发时，带上同一个 `messageId` 是安全的。
- **`parts`**：内容数组。可以混装——上例就是"一句话 + 一张图"。

还有一个容易忽略的字段：**`extensions`**（v1.0 新增，Message 和 Artifact 都有）。它声明这条消息用到了哪些扩展。见进阶篇。

## 6.3 Artifact：交付物

`Artifact` 是**任务产出的成品**。跟 Message 的区别不在于内容形式（都用 Part），而在于**语义角色**。

```json
{
  "artifactId": "9b6934dd-37e3-4eb1-8766-962efaab63a1",
  "name": "processed_image_with_faces.png",
  "description": "已标注人脸的图片",
  "parts": [
    {
      "url": "https://storage.example.com/processed/task-bbb/output.png?token=xyz",
      "filename": "output.png",
      "mediaType": "image/png"
    }
  ]
}
```

字段：

- `artifactId`：唯一 ID
- `name`：人类可读名字。**这个字段在迭代场景里很重要**——同一产物的新版本要复用同一个 `name`（第 5.4 节）。
- `description`：说明
- `parts`：内容（一个 Artifact 可以有多个 Part，比如"图片 + 它的说明"）

**Artifact 还能流式增量地到达**：`TaskArtifactUpdateEvent` 带 `append` 和 `lastChunk` 两个字段，让客户端能像拼包一样把分块送来的大产物拼起来。这就是"生成一份长报告，边生成边看到"的实现方式。

## 6.4 一个实用建议：大内容走 `url`，别走 `raw`

`raw` 是**内联**的——它会**整个塞进 JSON**（base64 之后体积还要涨约 33%）。

一份 5 MB 的 PDF 走 `raw`，会变成约 6.7 MB 的 JSON 字符串。这个 JSON 要：
- 在客户端和服务端各驻留一份
- 如果你的 Agent 是 LLM 驱动的，可能还要进上下文（**token 爆炸**）
- 进日志、进 trace 的话更可怕

**正确做法**：大文件放对象存储，Part 里用 `url` 给链接（可以带临时 token）。这也是规范示例里的做法。

> 自查：一个 Part 里能不能同时有 `text` 和 `data`？为什么？

---

# 第 7 章 三种收消息方式

## 7.1 三种模式，一套语义

规范列了三种交互机制：

| 模式 | 怎么工作 | 适合 |
|---|---|---|
| **Request/Response（轮询）** | 发请求 → 拿到 Task → 隔一会儿 `GetTask` 问一次 | 简单、不需要实时 |
| **Streaming（SSE）** | 开一条长连接，服务端持续推事件 | 需要实时进度、需要看中间产物 |
| **Push Notifications** | 你给个 webhook URL，服务端在状态变化时**主动 POST 给你** | 超长任务、客户端会断线/不在线 |

**它们是同一套状态机的三种"运输方式"**，不是三套逻辑。这个认识很重要：你内部的 Task 状态变化只有一份真相，三种模式只是把这份变化送出去的不同管道。

## 7.2 方式一：轮询（最笨，但最可靠）

```
客户端 ──SendMessage──► 服务端
客户端 ◄────Task─────── 服务端   (state: TASK_STATE_WORKING)

（等 3 秒）
客户端 ──GetTask──────► 服务端
客户端 ◄────Task─────── 服务端   (state: TASK_STATE_WORKING)

（等 3 秒）
客户端 ──GetTask──────► 服务端
客户端 ◄────Task─────── 服务端   (state: TASK_STATE_COMPLETED, 带 artifacts)
```

**阻塞 vs 非阻塞**：`SendMessage` 有个配置字段 `returnImmediately`：

- **默认（阻塞）**：服务端**等到**任务到达终态或中断态才返回
- **`returnImmediately: true`**：服务端建完 Task 立刻返回，剩下你自己轮询

（**⚠️ v1.0 变更**：这个字段 v0.3 叫 `blocking`，语义是反的；v1.0 改成 `returnImmediately`，更不容易搞错。）

**什么时候用**：任务几十秒内能完，或者你的客户端就是个 CLI（不需要实时进度）。**你的场景大概率从这一档开始。**

## 7.3 方式二：SSE 流式

**SSE = Server-Sent Events**，一种"服务端单向持续推数据"的 HTTP 技巧。做法是：服务端把响应头设成 `Content-Type: text/event-stream`，然后**不关闭连接**，一直往里写。

一条 SSE 消息的格式极简：

```
data: {这里是 JSON}

```

（一个 `data:` 前缀 + 一行 JSON + 一个空行表示这条消息结束）

A2A 用它来推三种东西。看规范给的完整例子：

```http
POST /message:stream HTTP/1.1
Host: agent.example.com
Content-Type: application/a2a+json
Authorization: Bearer token

{
  "message": {
    "role": "ROLE_USER",
    "parts": [{"text": "写一份关于气候变化的详细报告"}],
    "messageId": "msg-uuid"
  }
}
```

**SSE 响应流**：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"task": {"id": "task-uuid", "contextId": "context-uuid", "status": {"state": "TASK_STATE_WORKING"}}}

data: {"artifactUpdate": {"taskId": "task-uuid", "contextId": "context-uuid", "artifact": {"parts": [{"text": "# 气候变化报告\n\n"}]}}}

data: {"statusUpdate": {"taskId": "task-uuid", "contextId": "context-uuid", "status": {"state": "TASK_STATE_COMPLETED"}}}
```

**⚠️ v1.0 变更（两个）**：

1. **流事件不再有 `kind` 字段**。v0.3 用 `"kind": "status-update"` 判断事件类型；v1.0 改用**字段名判断**：有 `statusUpdate` 字段的就是状态更新，有 `artifactUpdate` 的就是产物更新。
2. **`final` 字段被删了**。v0.3 的状态更新事件带 `"final": true` 表示"这是最后一个"；v1.0 改成**用传输层的关闭来表示结束**（SSE 连接断掉 = 流结束了）。

这两个改动都让实现变简单了，但同样**不兼容**。

**流必须遵守的两条规矩**（规范第 3.1.2 节，这是硬要求）：

> 1. **Message-only stream**：如果返回 `Message`，流里**必须恰好有一个** Message，然后立刻关闭。
> 2. **Task lifecycle stream**：如果返回 `Task`，流的**第一个事件必须是 Task 对象**，之后是零个或多个状态更新/产物更新；任务到终态时流必须关闭。

**混合是不允许的**——不能先发 Message 再发状态更新，也不能在 Task 之前发状态更新。参考实现甚至会对违规**抛错**（`InvalidAgentResponseError`）。这是个容易踩的坑：**先 Task，再更新。**

**断线了怎么办**：用 `SubscribeToTask` 重新订阅。规范保证：

> The operation MUST return a `Task` object as the **first event** in the stream, representing the current state of the task at the time of subscription. This prevents a potential loss of information between a call to `GetTask` and calling `SubscribeToTask`.

**注意这个细节设计**：先给你一个当前状态快照。"查询状态"和"开始订阅"之间如果不给快照，中间发生的变化就丢了。这是个很典型的健壮性设计，值得学。

## 7.4 方式三：推送通知（给会断线的客户端）

SSE 有个前提：**你的连接得一直在**。但有的客户端做不到：

- 手机 App 被切到后台
- Serverless 函数跑完就退出了
- 任务要跑 6 小时，不可能一直挂着连接

于是 A2A 支持：**客户端给一个 webhook URL，服务端在状态变化时主动 POST 过去。**

```json
{
  "message": {
    "role": "ROLE_USER",
    "parts": [{"text": "生成 Q1 销售报告，这个要跑一会儿，好了通知我。"}],
    "messageId": "6dbc13b5-bd57-4c2b-b503-24e381b6c8d6"
  },
  "configuration": {
    "taskPushNotificationConfig": {
      "url": "https://client.example.com/webhook/a2a-notifications",
      "authentication": {
        "scheme": "Bearer",
        "credentials": "secure-client-token-for-task-aaa"
      }
    }
  }
}
```

服务端在任务完成时：

```http
POST /webhook/a2a-notifications HTTP/1.1
Host: client.example.com
Authorization: Bearer secure-client-token-for-task-aaa
Content-Type: application/a2a+json

{
  "statusUpdate": {
    "taskId": "43667960-d455-4453-b0cf-1bae4955270d",
    "contextId": "c295ea44-7543-4f78-b524-7a38915ad6e4",
    "status": {
      "state": "TASK_STATE_COMPLETED",
      "timestamp": "2024-03-15T18:30:00Z"
    }
  }
}
```

**payload 的格式和 SSE 里的一模一样**（都是 `StreamResponse`，含 `task` / `message` / `statusUpdate` / `artifactUpdate` 四选一）。这是个好设计——你只需要写一个"处理 StreamResponse"的函数，流式和推送两种模式共用。

**但推送通知带来两个非对称的安全问题，规范专门花了大篇幅讲：**

**问题一：服务端可能被利用来做 SSRF 攻击。** 客户端给的 `url` 是**任意 URL**。如果服务端无脑去 POST，恶意客户端就可以让它去攻击内网：

```
"url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
```

（这是云环境的元数据端点，能拿到实例的临时凭据。）

规范的缓解建议：**域名白名单、所有权验证（挑战-应答）、网络层出口防火墙**。

**问题二：客户端的 webhook 会被伪造。** 谁能往你的 webhook POST？必须是能验明正身的服务端。规范的验证手段：

- **验签**：JWT 签名对着 JWKS 公钥验；或 HMAC；或 API Key
- **防重放**：检查时间戳（太老的拒绝）、用一次性 ID（JWT 的 `jti` 声明）
- **密钥轮换**：JWKS 就是为轮换设计的

规范还给了一个完整的「非对称密钥流程」示例（服务端签 JWT → 客户端拿 `kid` 去 JWKS 取公钥 → 验签 → 校验 `iss`/`aud`/`iat`/`exp`/`jti`）。这一套是标准做法，进阶篇会展开。

## 7.5 该选哪个：一张决策表

| 你的情况 | 选 |
|---|---|
| 任务几十秒内完成，客户端是 CLI | **轮询**（最简单） |
| 想知道实时进度、想看到中间产物 | **SSE** |
| 任务可能跑很久，客户端可能断线/退出 | **推送通知** |
| 不确定 | **先轮询**。它永远不会错，只是不实时。 |

**给你的具体建议**：`A:\ai_agent` 现在的形态是 CLI（`src/index.ts` 的 REPL 与 stdin 单次模式，`index.ts:566-572`）。你最先该实现的是**轮询**，因为它不需要常驻连接、不需要新的事件循环、不需要 webhook 服务。等你真的需要看进度了再上 SSE——而且你的事件总线（`src/core/events.ts`）已经是现成的映射源。

> 自查：SSE 和推送通知的 payload 格式一样吗？为什么这样设计？

---

# 第 8 章 任务状态机：九个枚举值

## 8.1 状态一览

**⚠️ v1.0 变更**：枚举值从 `snake_case` 改成了 `SCREAMING_SNAKE_CASE`，并且加了 `TASK_STATE_` 前缀。

| v1.0 值 | v0.3 值 | 含义 | 类别 |
|---|---|---|---|
| `TASK_STATE_SUBMITTED` | `submitted` | 已收到，还没开始干 | 进行中 |
| `TASK_STATE_WORKING` | `working` | 正在干 | 进行中 |
| `TASK_STATE_INPUT_REQUIRED` | `input_required` | **需要你补信息** | **中断态** |
| `TASK_STATE_AUTH_REQUIRED` | `auth_required` | **需要你授权** | **中断态** |
| `TASK_STATE_COMPLETED` | `completed` | 干完了 | **终态** |
| `TASK_STATE_FAILED` | `failed` | 干失败了 | **终态** |
| `TASK_STATE_CANCELED` | `canceled` | 被取消了 | **终态** |
| `TASK_STATE_REJECTED` | `rejected` | 被拒绝了（不干这个活） | **终态** |
| `TASK_STATE_UNSPECIFIED` | （无） | 未指定（spec 默认值） | — |

三类要分清：

- **进行中**：还在跑，你等着或者轮询
- **中断态**：**卡住了，等你**。这是多轮协作的关键。
- **终态**：结束了，**不可复活**（第 5.3 节）

## 8.2 为什么 `INPUT_REQUIRED` 是多 Agent 的关键

回忆第 0.1 节那张表：「工具是下属，Agent 是同事。」

下属不会说"我需要更多信息"。同事会说。

`TASK_STATE_INPUT_REQUIRED` 就是协议级的「同事问你话」。看规范的例子：

**第一轮**：

```json
{ "message": { "role": "ROLE_USER", "parts": [{"text": "帮我订张机票"}], "messageId": "msg-1" } }
```

**响应 —— 不是失败，是挂起**：

```json
{
  "task": {
    "id": "task-uuid",
    "status": {
      "state": "TASK_STATE_INPUT_REQUIRED",
      "message": {
        "role": "ROLE_AGENT",
        "parts": [{"text": "我需要更多信息。你想从哪里飞到哪里？"}]
      }
    }
  }
}
```

**第二轮 —— 带上 taskId 接着说**：

```json
{
  "message": {
    "taskId": "task-uuid",
    "role": "ROLE_USER",
    "parts": [{"text": "从旧金山到纽约"}],
    "messageId": "msg-2"
  }
}
```

**注意三个设计细节**：

1. **不是错误。** HTTP 是 200，Task 是活的。这跟传统的"参数不全 → 400"完全不同。**"信息不足"是正常流程，不是异常。**
2. **问的话在 `status.message` 里。** 也就是说问题本身是一条结构化的 Message（有 role 有 parts），不是塞在某个 `error` 字符串里。
3. **续话的方式是带 `taskId` 再发一条消息。** 同一个 task 继续，不是开新 task。

**对你的直接含义**：`A:\ai_agent` 现在有一个非常接近的机制——`requestHuman`（`src/core/types.ts:16`，CLI 实现在 `src/index.ts:383`）。你的 Agent 在工具执行中途可以停下来问用户一句话。

**但这两者有个本质差别**：你的 `requestHuman` 是**同步阻塞**的、**只面向本地终端用户**的、**活在一次工具调用里面**。A2A 的 `INPUT_REQUIRED` 是**异步的、可跨进程跨网络的、把"等"变成了一个持久化的状态**。

这个差别在跨 Agent 协作时会变成硬约束：如果远端 Agent 需要你补话，而你正在一个更大的编排流程中间，你**不能**同步阻塞在那个点上——你要把整个链路挂起，让用户的答复过一会儿从另一个入口回来。

**还有一个必须搞清楚的边界**：规范明确说了，**消息不是可靠的投递机制**（`Messages MUST NOT be considered a reliable delivery mechanism for critical information`），而且 Task 的历史也不保证包含所有消息。所以**关键状态必须靠 `GetTask` 去查，不能指望"我订阅过流所以我都看到了"**。客户端断线重连后可能漏掉中间的状态更新——这正是 `GetTask` 存在的意义。

## 8.3 `AUTH_REQUIRED`：把"要授权"也变成状态

第八个状态解决另一个问题：**"我有权限问题，需要授权"**。

规范举的例子：

> - An agent requiring an OAuth access token to call an API or another agent
> - An agent requiring human approval before a destructive action is taken

**规范在这里写得非常克制且严谨，值得逐句读**（第 7.6 节）：

Agent 要做的是：

1. **必须用一个 Task 来跟踪**这个操作
2. **必须**把状态转到 `TASK_STATE_AUTH_REQUIRED`
3. **必须**在 `TaskStatus` 的 message 里解释需要什么授权（除非已经带外协商过了）

而且：

> Agents **MUST NOT** treat the `TASK_STATE_AUTH_REQUIRED` state transition, by itself, as authorization for any particular operation.

**这句话是个安全底线**：进入这个状态**本身不等于获得了授权**。授权的范围、表示、有效期、撤销语义，**协议一概不管**，由你的实现、凭据签发方或扩展来定义。

还有一条非常重要的链式设计：

> If the client is itself an A2A agent actively processing a Task, the client may further delegate the authorization request to its client by transitioning its own Task to `TASK_STATE_AUTH_REQUIRED`. ... This enables forming a **chain of Tasks in `TASK_STATE_AUTH_REQUIRED`**.

**想象一下**：用户 → 你的助手 → 酒店 Agent → 支付网关 Agent。支付网关需要用户的二次确认。这个"需要授权"沿链条**一层层往回传**，一直传到用户面前。用户确认后，凭据再传回去。

**这就是多 Agent 的"授权链"。** 而它的基础就是"授权是一个状态，不是一次函数调用"。

规范还提醒了一个真实风险：

> If a client does not have an active response stream open with the agent, the client risks missing Task updates.

于是给了三条出路：`SubscribeToTask` 订阅、注册 webhook、或者老实轮询 `GetTask`。**中断态是一个可能持续很久的状态，所以必须有一种"我不盯着也能被通知到"的机制。**

## 8.4 状态机图

```
                    ┌───────────────┐
                    │   SUBMITTED   │
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐
              ┌────►│    WORKING    │◄────┐
              │     └───┬───┬───┬───┘     │
              │         │   │   │         │
     （补话/授权后续跑） │   │   │         │
              │         │   │   └─────────┘
              │         │   │
   ┌──────────┴──┐  ┌───▼────────────┐
   │INPUT_REQUIRED│  │ AUTH_REQUIRED  │   ← 中断态：卡住了，等你
   └──────────────┘  └────────────────┘
                            │
        ┌───────────┬───────┴────┬───────────┐
        │           │            │           │
   ┌────▼────┐ ┌────▼────┐ ┌─────▼────┐ ┌────▼─────┐
   │COMPLETED│ │ FAILED  │ │ CANCELED │ │ REJECTED │   ← 终态：不可复活
   └─────────┘ └─────────┘ └──────────┘ └──────────┘
```

> 自查：`INPUT_REQUIRED` 是"出错了"吗？为什么这样设计更好？

---

# 第 9 章 错误：出错了怎么说话

## 9.1 九种标准错误

A2A 定义了一组语义化的错误类型。**⚠️ v1.0 变更**：错误体系改成了基于 `google.rpc.Status` / `ErrorInfo` 的分类，**新增了三个**（`-32007` / `-32008` / `-32009`）。

| 错误类型 | JSON-RPC 码 | 人话 |
|---|---|---|
| `TaskNotFoundError` | `-32001` | 这个 taskId 不存在，或者你无权看 |
| `TaskNotCancelableError` | `-32002` | 这个任务现在不能取消（比如已经完成了） |
| `PushNotificationNotSupportedError` | `-32003` | 对方不支持推送通知 |
| `UnsupportedOperationError` | `-32004` | 这个操作对方不做（比如没开流式、或往终态 task 发消息） |
| `ContentTypeNotSupportedError` | `-32005` | 你发的 MIME 类型对方不认 |
| `InvalidAgentResponseError` | `-32006` | **对方返回的东西不符合规范**（注意：这是"对方错了"） |
| `ExtendedAgentCardNotConfiguredError` | `-32007` | 对方声明支持详细名片，但没配 |
| `ExtensionSupportRequiredError` | `-32008` | 需要某个扩展但你不支持 |
| `VersionNotSupportedError` | `-32009` | 协议版本不匹配 |

**记住前几个的直觉就够了**。但有两个值得单独说：

**`-32004 UnsupportedOperationError` 会出现在一个你意想不到的地方**：往**终态**的 Task 发消息。规范明确说了：

> Messages sent to Tasks that are in a terminal state cannot accept further messages.

**这是第 5.3 节"终态不可复活"的实际体现。** 你的代码如果没处理好"这个任务已经完了，用户又说了一句"，就会撞上这个错误。正确做法是：检测到终态 → **开新 Task**（同一个 contextId）。

**`-32006 InvalidAgentResponseError` 的定位很特别**：它表达的**不是"请求有问题"，而是"对方的实现有问题"**。它对应的是"Agent 返回了不符合当前方法规范的东西"。规范里列的触发场景很具体（这些是硬性错误）：

- 在 Task 模式下发 Message（混用模式）
- 发了多个 Message
- 在 Message 模式下发 Task/更新事件
- 在初始 Task 之前发状态更新事件

**这几个正好对应第 7.3 节讲的那两条流式规矩。** 也就是说：**违反流式规矩 = 用 `-32006` 告诉对方"你实现了 bug"。**

## 9.2 三种绑定，三套写法，同一个语义

这是 A2A v1.0 的一个核心设计：**错误是抽象语义，每个绑定把它映射成自己的形式。**

| 错误类型 | JSON-RPC 码 | gRPC Status | HTTP 状态 |
|---|---|---|---|
| `TaskNotFoundError` | `-32001` | `NOT_FOUND` | `404` |
| `TaskNotCancelableError` | `-32002` | `FAILED_PRECONDITION` | `400` |
| `PushNotificationNotSupportedError` | `-32003` | `FAILED_PRECONDITION` | `400` |
| `UnsupportedOperationError` | `-32004` | `FAILED_PRECONDITION` | `400` |
| `ContentTypeNotSupportedError` | `-32005` | `INVALID_ARGUMENT` | `400` |
| `InvalidAgentResponseError` | `-32006` | `INTERNAL` | `500` |
| `ExtendedAgentCardNotConfiguredError` | `-32007` | `FAILED_PRECONDITION` | `400` |
| `ExtensionSupportRequiredError` | `-32008` | `FAILED_PRECONDITION` | `400` |
| `VersionNotSupportedError` | `-32009` | `FAILED_PRECONDITION` | `400` |

**注意 `-32006` 映射到 500 而不是 400**——因为它是"服务端自己坏了"，不是"客户端请求错了"。这个区分在排查问题时有实际价值：**收到 500 说明是对面的锅，收到 400 说明是你的锅。**

**为什么这个表有意义**：它是 A2A 的**分层设计**（数据模型 / 抽象操作 / 协议绑定）的具体体现。同一套语义可以在 JSON-RPC、gRPC、REST 三个传输上表达，而**语义不变**。你换传输不用换业务逻辑。

## 9.3 一条实践建议

你现在的错误处理方式是把异常压成 `{"error": "..."}` 字符串（`src/core/registry.ts:87-96`）：

```ts
} catch (error) {
  return JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  });
}
```

**这对本地工具是对的**——模型能读懂，也很灵活。

**但对 A2A 不够**：跨进程协作需要**机器可判别的错误分类**。调用方要能程序化地回答"我该重试吗？该降级吗？该换一个 Agent 吗？"——靠解析一段自然语言错误消息做不到。

所以你要在 A2A 层保持结构化错误，**只在把结果喂给模型时才降级成文本**。这个"结构化对外，文本对内"的分层是个重要原则，进阶篇第 10 章会展开。

> 自查：你收到 `-32006`，是你的问题还是对方的问题？

---

# 第 10 章 串起来：一次"帮我写份报告"全程直播

这一章把前面所有概念串成一次真实调用。**跟着数字走。**

## 场景

你（或你的 Agent）想委托远端 Agent 写一份报告。

## 第 ① 步：发现

你的客户端知道对方域名，去拉名片：

```http
GET /.well-known/agent-card.json HTTP/1.1
Host: research-agent.example.com
```

拿到（截取关键部分）：

```json
{
  "name": "研究助手",
  "supportedInterfaces": [
    { "url": "https://research-agent.example.com/a2a/v1", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }
  ],
  "capabilities": { "streaming": true, "pushNotifications": true },
  "skills": [
    { "id": "write-report", "name": "报告撰写", "description": "撰写带引用的研究报告",
      "inputModes": ["text/plain"], "outputModes": ["text/plain"] }
  ],
  "securitySchemes": { "bearer": { "httpAuthSecurityScheme": { "scheme": "Bearer" } } }
}
```

**你从名片里读到四件关键事**：

1. 地址是 `https://research-agent.example.com/a2a/v1`（**用哪个 URL 由 `supportedInterfaces` 决定，不是猜的**）
2. 它支持流式和推送
3. 它会 `write-report` 这个 skill
4. **它要 Bearer token**

## 第 ② 步：认证（带外）

按名片要求，走标准 OAuth2 流程拿到一个 JWT。**这一步不通过 A2A 协议**——是标准的 Web 认证。

## 第 ③ 步：发消息（选流式，因为写报告要一会儿）

```http
POST /a2a/v1 HTTP/1.1
Host: research-agent.example.com
Content-Type: application/a2a+json
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
A2A-Version: 1.0

{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "SendStreamingMessage",
  "params": {
    "message": {
      "role": "ROLE_USER",
      "messageId": "msg-a1b2c3",
      "parts": [{ "text": "写一份关于 2026 年 AI Agent 协议标准的详细报告。" }]
    }
  }
}
```

**读一下这个报文**（如果你读过 `docs/MCP入门篇.md` 第 3 章，这部分你已经熟了）：

- `jsonrpc: "2.0"` —— JSON-RPC 版本
- `id: "req-001"` —— 你自己编的请求 ID，用来配对响应
- `method: "SendStreamingMessage"` —— **要调的方法**（⚠️ 方法名改过两次：`0.1.0` 是 `tasks/sendSubscribe`；`0.2.0` 起改成 `message/stream` 这种"分类/动作"写法；`1.0` 起改成与 gRPC 一致的 PascalCase `SendStreamingMessage`。**v1.0 里 `message/stream` 这个名字已经不存在了。**）
- `params` —— 参数，里面装着 `message`
- **另外别忘了 HTTP 头**：`Content-Type: application/a2a+json`（v1.0 新注册的媒体类型）和 `A2A-Version: 1.0`。见进阶篇。

## 第 ④ 步：服务端建立流

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
```

连接不关。开始推事件。

## 第 ⑤ 步：第一个事件必须是 Task

```
data: {"task": {"id": "task-9f8e7d", "contextId": "ctx-abc123", "status": {"state": "TASK_STATE_SUBMITTED"}}}
```

**记住第 7.3 节的硬规矩**：Task 模式流的第一个事件必须是 `Task` 对象。你从这条事件里**记下两样东西**：`taskId = task-9f8e7d`、`contextId = ctx-abc123`。后面全要用。

## 第 ⑥ 步：状态更新（开始干活了）

```
data: {"statusUpdate": {"taskId": "task-9f8e7d", "contextId": "ctx-abc123", "status": {"state": "TASK_STATE_WORKING"}}}
```

**判别方式**：这条 JSON 里有 `statusUpdate` 字段 → 是 `TaskStatusUpdateEvent`。（v0.3 是靠 `"kind": "status-update"` 判断的，v1.0 删了。）

## 第 ⑦ 步：产物增量到达

```
data: {"artifactUpdate": {"taskId": "task-9f8e7d", "contextId": "ctx-abc123", "artifact": {"artifactId": "art-001", "name": "report.md", "parts": [{"text": "# 2026 年 AI Agent 协议标准\n\n"}]}}}
```

```
data: {"artifactUpdate": {"taskId": "task-9f8e7d", "contextId": "ctx-abc123", "artifact": {"artifactId": "art-001", "name": "report.md", "parts": [{"text": "## 1. 概述\n\n"}]}, "append": true}}
```

**两个细节**：

- 第二条带 `"append": true` → 表示**追加到已有产物上**，不是替换。这是分块传输的拼接机制。
- 两条的 `name` 都是 `report.md`（同一个产物），`artifactId` 也相同。

## 第 ⑧ 步：卡住了，要你补信息

```
data: {"statusUpdate": {"taskId": "task-9f8e7d", "contextId": "ctx-abc123",
       "status": {"state": "TASK_STATE_INPUT_REQUIRED",
                  "message": {"role": "ROLE_AGENT", "parts": [{"text": "你希望报告侧重技术实现还是商业影响？"}]}}}}
```

**流在这里关闭**（中断态也算"可以停了"）。任务**没失败，是挂起了**。

## 第 ⑨ 步：你回答，继续同一个任务

```http
POST /a2a/v1 HTTP/1.1
Content-Type: application/a2a+json
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

{
  "jsonrpc": "2.0",
  "id": "req-002",
  "method": "SendMessage",
  "params": {
    "message": {
      "taskId": "task-9f8e7d",
      "contextId": "ctx-abc123",
      "role": "ROLE_USER",
      "messageId": "msg-d4e5f6",
      "parts": [{ "text": "侧重技术实现。" }]
    }
  }
}
```

**注意**：带上 `taskId` **和** `contextId`。`taskId` 说"接着这个任务干"，`contextId` 说"还在同一个会话里"。

## 第 ⑩ 步：完成

```
data: {"task": {"id": "task-9f8e7d", "contextId": "ctx-abc123",
       "status": {"state": "TASK_STATE_COMPLETED", "timestamp": "2026-01-15T10:30:00.000Z"},
       "artifacts": [{"artifactId": "art-001", "name": "report.md", "parts": [{"text": "（完整报告正文）"}]}]}}
```

流关闭（终态）。

## 第 ⑪ 步：想改？开新 Task

用户说"再加一节讲安全风险"。

**不能**往 `task-9f8e7d` 发消息——它已经 `COMPLETED`，是终态。再发会得到 `-32004 UnsupportedOperationError`。

正确做法：

```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "method": "SendMessage",
  "params": {
    "message": {
      "contextId": "ctx-abc123",
      "referenceTaskIds": ["task-9f8e7d"],
      "role": "ROLE_USER",
      "messageId": "msg-g7h8i9",
      "parts": [{ "text": "在 report.md 里加一节讲安全风险。" }]
    }
  }
}
```

**注意三处**：同一个 `contextId`（还在这个会话）、**新的** taskId（服务端生成）、`referenceTaskIds` 指向老任务（"我说的是这个"）。

服务端会生成一个新 task（比如 `task-1a2b3c`）**并复用产物名 `report.md`** —— 你的客户端就靠"名字相同"知道这是同一个文档的新版本（第 5.4 节）。

## 全流程回看

| 步骤 | 用了哪个概念 | 对应你代码里的什么 |
|---|---|---|
| ① 发现 | Agent Card | 无（要新增） |
| ② 认证 | `securitySchemes` + 带外 OAuth | 无（要新增） |
| ③ 发消息 | JSON-RPC `SendStreamingMessage` | `Agent.run()` 的输入侧 |
| ④ 建流 | SSE + `text/event-stream` | `AgentEventBus` 的订阅侧 |
| ⑤ Task | `Task` + `taskId`/`contextId` | `AgentResult`（要先投影，见评估文档 2.1） |
| ⑥ 状态 | `TaskStatusUpdateEvent` | `step` 事件（`events.ts:26-28`） |
| ⑦ 产物 | `TaskArtifactUpdateEvent` + `append` | 工具执行结果（要挑出"交付物"） |
| ⑧ 要信息 | `TASK_STATE_INPUT_REQUIRED` | `requestHuman`（`types.ts:16`）—— 但语义要改造成异步 |
| ⑨ 续话 | `taskId` + `contextId` | `SessionStore` 的续聊（`session_store.ts`） |
| ⑩ 完成 | `TASK_STATE_COMPLETED` + `artifacts` | `result.finalAnswer` + `success` |
| ⑪ 迭代 | **新 Task** + `referenceTaskIds` | 无（要新增） |

**看最后一列**：你会发现左边（A2A 概念）和中间（你已有的东西）几乎是**一对一**的。这就是 `docs/A2A适配性评估.md` 说"缺的是加一层，不是重写"的具体含义。

> 自查：第 ⑪ 步为什么不能往老 task 发消息？

---

# 第 11 章 三个你自己能跑的小观察

这三个观察只需要 `curl`（或者你习惯用 PowerShell 的 `Invoke-WebRequest`）和一个公开的 A2A Agent。**目的是让你亲眼看到本文讲的东西，而不是只读文字。**

> ⚠️ **先说清楚**：A2A 生态还在早期，公开可访问的 Agent 不多且可能变动。如果下面的地址失效了，去看 [a2a-samples](https://github.com/a2aproject/a2a-samples) 里的示例，本地起一个（需要 Python）。**本文不保证任何第三方地址长期可用——跑之前先确认。**

## 观察 1：看一份真实的 Agent Card

```bash
curl -s https://example.com/.well-known/agent-card.json | head -50
```

**你要重点看三样**：

1. `supportedInterfaces` 里 `protocolBinding` 是什么值（`JSONRPC` / `HTTP+JSON` / `GRPC`）
2. `capabilities` 里 `streaming` / `pushNotifications` 是 true 还是 false
3. `skills` 里每个 skill 的 `id` 和 `inputModes` / `outputModes`

**然后问自己**：如果我要调它，我该往哪个 URL 发、用什么方法、发什么 MIME 类型？**这三个问题的答案全在名片里**——这就是"发现"的价值。

## 观察 2：看清一条 SSE 流长什么样

对着一个支持流式的 Agent（或本地示例）发：

```bash
curl -N -X POST https://<agent>/a2a/v1 \
  -H "Content-Type: application/a2a+json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "role": "ROLE_USER",
        "messageId": "msg-1",
        "parts": [{"text": "写一份 200 字的产品介绍"}]
      }
    }
  }'
```

`-N` 是关掉 curl 的缓冲，让你能**实时**看到 `data:` 一行行冒出来。

**你要重点确认四件事**：

1. 响应头是不是 `Content-Type: text/event-stream`
2. **第一个事件是不是 `task`**（规范硬要求）
3. 状态更新的 JSON 里**是不是有 `statusUpdate` 字段**（v1.0 靠字段名判别，没有 `kind` 了）
4. **流是不是在终态时关闭的**

**如果你看到 `data:` 里出现了 `"kind": "status-update"`，或者 `"final": true`** —— 恭喜你，你碰到了一个 **v0.3（或更早）的实现**。这两个字段在 v1.0 都被**删掉了**：判别改用 JSON 成员名（看是 `statusUpdate` 还是 `artifactUpdate`），流结束改用**连接关闭**表示。这正是第 4/6/7/8 节反复提醒的版本陷阱。

## 观察 3：感受"终态不可复活"

做完观察 2 后，拿那个已经 `COMPLETED` 的 `taskId` 再发一条消息：

```bash
curl -X POST https://<agent>/a2a/v1 \
  -H "Content-Type: application/a2a+json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "SendMessage",
    "params": {
      "message": {
        "taskId": "<刚才那个已完成的 taskId>",
        "role": "ROLE_USER",
        "messageId": "msg-2",
        "parts": [{"text": "再改改"}]
      }
    }
  }'
```

**预期**：得到一个 JSON-RPC 错误，`code` 是 **`-32004`**（`UnsupportedOperationError`）。

**这个观察的价值**：你亲身验证了「Task 终态不可复活」不是文档里的一句空话，而是**协议强制、有专门错误码的行为**。也顺手让你看到了一次真实的 A2A 错误报文长什么样——比读十遍错误表都管用。

---

# 第 12 章 自测 20 题

先自己答，再看后面的答案。

1. A2A 解决的核心问题和 MCP 有什么不同？用一句话说。
2. 把远端 Agent 包成 MCP 工具，最要紧的那个问题是什么（不是"多轮"和"进度"）？
3. A2A 的三个角色分别是什么？"User" 只能是人类吗？
4. 同一个 Agent 能不能既是 A2A Client 又是 A2A Server？
5. 官方用哪两个词区分 A2A 和 MCP 的连接方向？各是什么意思？
6. Well-known URI 的完整路径是什么？v1.0 和更早实现有差异吗？
7. v0.3 的 `AgentCard.url` 在 v1.0 里变成了什么？为什么要这样改？
8. `securitySchemes` 声明了认证要求，但凭据是怎么拿到的？通过 A2A 协议吗？
9. 为什么要给 Agent Card 签名？签名前必须做什么处理？签名时要排除哪个字段？
10. `SendMessage` 可能返回哪两种东西？判断标准是什么？
11. 服务端可以有三档风格，哪一档最适合你现在的 Agent？为什么？
12. Task 到了终态之后，能在同一个 Task 上继续吗？那"想改改"该怎么做？
13. `contextId` 和 `taskId` 各是什么？谁可以包含多个谁？
14. A2A 的 `Part` 有哪四种内容？v1.0 相比 v0.3 在这里做了什么改动？
15. `Artifact` 和 `Message` 都用 `Part` 装内容，它们的差别在哪？
16. 三种收消息方式分别是什么？各适合什么场景？payload 格式一样吗？
17. 流式的时候，如果返回 `Task`，流的第一个事件必须是什么？违反了会怎样？
18. `TASK_STATE_INPUT_REQUIRED` 是错误吗？它和 `requestHuman` 这类同步询问的本质差别在哪？
19. `TASK_STATE_AUTH_REQUIRED` 有哪些 MUST 要求？规范说进入这个状态本身意味着什么？
20. `-32006 InvalidAgentResponseError` 映射到 HTTP 500 而不是 400，为什么这个区分有意义？

## 答案

**1.** MCP 让一个 Agent 能"用"工具和数据（竖着往下连，给单个 Agent 增加深度）；A2A 让 Agent 之间能"互相找人"协作（横着往旁边连，给系统增加广度）。

**2.** **把对方的输出直接灌进了你的上下文。** 工具返回的内容会进你的消息历史，而你没法控制另一个 Agent 会说什么——它可能被注入、可能有自己的目标。A2A 用 Opaque Execution 原则划清了这条边界。

**3.** User（用户，**可以是人也可以是自动化服务**）、A2A Client / Client Agent（发起请求的一方）、A2A Server / Remote Agent（提供能力的一方，对客户端是不透明的黑盒）。

**4.** **能，而且很正常。** 角色是"这次交互里的位置"而不是"这个东西的属性"。跟"你的 Node 服务既是浏览器眼里的服务端，又是数据库眼里的客户端"一样。

**5.** **Vertical（竖）与 Horizontal（横）。** MCP 是竖着连（Agent → 工具/数据，加深单个 Agent）；A2A 是横着连（Agent ↔ Agent，跨越团队/部门的边界，扩大覆盖面）。

**6.** `https://{域名}/.well-known/agent-card.json`。**有差异**：v1.0 定为 `agent-card.json`，更早的草案/实现里出现过 `/.well-known/agent.json`。对接老实现时两个都要试——这是个很常见的"连不上"原因。

**7.** 变成了 **`supportedInterfaces`**（一个 `AgentInterface` 对象的列表），同时 `protocolVersion` 从名片顶层搬进了每个接口条目。**这样改的价值**：同一个 Agent 可以同时暴露多种传输、甚至**同时支持 v0.3 和 v1.0 两个协议版本**，靠接口条目区分——这是向后兼容的关键设计。

**8.** **不通过 A2A 协议，是带外（out-of-band）的。** 流程是：读名片知道要什么 → 走标准 OAuth/API Key 流程拿到凭据 → 每次 A2A 请求在 HTTP 头里带上。规范还明确建议**不要在名片里嵌静态密钥**（名片至少部分公开）。

**9.** 防止名片被篡改（比如 `url` 被换成攻击者的服务器，然后你的请求和凭据都发过去）。签名前必须按 **RFC 8785（JSON Canonicalization Scheme）** 做规范化（因为 JSON 字段顺序和空白不影响语义但会影响签名字节）；签名时**必须排除 `signatures` 字段本身**（否则循环依赖）。

**10.** **`Task` 或 `Message`。** 判断标准：**这件事结束后还需要记住状态吗？** 需要（长时/多轮/要产出物）→ `Task`；不需要（一问一答）→ `Message`。

**11.** **Hybrid（混合）**：用 `Message` 协商"要干什么"，确定要动手了再开 `Task`。**为什么适合你**：你的 Agent 本来就有"判断这个任务要不要调工具"的能力，这个判断时刻恰好就是从 Message 升级到 Task 的自然分界点。

**12.** **不能。** 规范：Task 到达终态（completed / canceled / rejected / failed）后**不可重启**。想改就开**新 Task**，用**同一个 `contextId`**，并用 **`referenceTaskIds`** 指向老任务。硬要往终态 Task 发消息会得到 `-32004 UnsupportedOperationError`。

**13.** `contextId` 是**归组**用的（把一串相关的 Task/Message 串成一个会话），`taskId` 标识**单个**工作单元。**一个 `contextId` 下可以有多个 `taskId`**（甚至可以并行跑，"订机票 + 订酒店 + 订雪地摩托"就在同一个 context 里）。反向不成立。

**14.** `text`（文本）、`raw`（内联二进制）、`url`（指向外部文件的 URI）、`data`（结构化 JSON）。**v1.0 把 v0.3 的四种 Part 子类型（`TextPart`/`FilePart`/`DataPart` + `FileWithBytes`/`FileWithUri`）合并成一个统一的 `Part`**，直接用这四个字段。这是 v1.0 最大的破坏性变更。

**15.** 差别在**语义角色**，不在内容形式。`Message.parts` 是"这一轮说的话"，`Artifact.parts` 是"这次任务的交付物"。Artifact 还有 `artifactId` 和 `name`——**`name` 在迭代场景里是关键**：同一产物的新版本要复用同一个 `name`，客户端靠它认出版本关系。

**16.** 轮询（`GetTask`，简单可靠，不实时）、SSE 流式（实时进度和中间产物，需要连接常驻）、推送通知（webhook，适合超长任务和会断线的客户端）。**payload 格式完全一样**——都是 `StreamResponse`，含 `task` / `message` / `statusUpdate` / `artifactUpdate` 四选一。所以"处理一条更新"的代码可以三种模式共用。

**17.** **必须是 `Task` 对象。** 如果返回的是 `Message`，那么流里**必须恰好有一个** Message 然后立刻关闭。**违反会被判为 `-32006 InvalidAgentResponseError`**（混用模式、发多个 Message、在 Task 前发状态更新事件，都是硬错误）。

**18.** **不是错误。** HTTP 是 200，Task 是活的，只是挂起了。它和同步询问的本质差别：`requestHuman`（你的 `src/core/types.ts:16`）是**同步阻塞**的、只面向**本地终端**的、活在**一次工具调用内部**；`INPUT_REQUIRED` 是**异步持久化的状态**，可跨进程跨网络，把"等"变成了一个有 ID、可查询、可被通知的状态。

**19.** 三条 MUST：**必须用一个 Task 来跟踪**这个操作；**必须**把状态转到 `TASK_STATE_AUTH_REQUIRED`；**必须**在 TaskStatus 的 message 里解释需要什么授权（除非已带外协商）。规范明确：**进入这个状态本身不构成对任何操作的授权**（`MUST NOT treat ... as authorization`）——授权的范围/表示/有效期/撤销语义协议一概不管，由实现、签发方或扩展定义。

**20.** 因为它们的**归责方不同**。`-32006` 表达的是"**服务端实现有问题**"——它返回了不符合规范的东西，是它的锅，所以映射 500（服务端错误）。而其他错误都是"客户端请求有问题"，映射 400。这个区分在排查时有直接价值：**收到 500 是对面的锅，收到 400 是你的锅。**

---

# 第 13 章 接下来读进阶篇哪几章

按你现在的需要跳读。

| 你的情况 / 想知道什么 | 读进阶篇哪章 |
|---|---|
| 我要给 `A:\ai_agent` 加 A2A，从哪下手 | 第 1 章（路线图）+ 第 6 章（投影层） |
| 我要选传输：JSON-RPC / gRPC / REST 选哪个 | 第 2 章（三种绑定） |
| 我要理解 v0.3 到 v1.0 的破坏性变更细节 | 第 3 章（版本陷阱） |
| 我要生成 Agent Card | 第 5 章 |
| 我要把 `AgentResult` 变成 A2A 响应 | 第 6 章 |
| 我要做委派（调别人的 Agent） | 第 7 章 |
| 我在想安全模型（最重要的一章） | 第 8 章 |
| 我要写系统提示词的协作纪律 | 第 9 章 |
| 我要做错误处理与可观测性 | 第 10 章 |
| 我要评估风险、看别人踩过的坑 | 第 11 章 |
| 我要看协议的演进史与未来走向 | 第 12 章 |

**另外强烈建议先读 `docs/A2A适配性评估.md`**——它把"你现在的代码缺什么、缺在哪一层、该按什么顺序补"讲清楚了。进阶篇是"怎么做"，评估文档是"你离能做什么还差几步"。

---

## 参考来源

- [A2A 协议规范 v1.0](https://a2a-protocol.org/latest/specification/) —— 本文所有字段名、枚举值、错误码的原始出处
- [A2A 官方文档索引 llms.txt](https://a2a-protocol.org/llms.txt) —— 官方维护的文档/速查/全文索引入口，写代码时比翻站点快
- [A2A Protocol Definition（规范 proto）](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto) —— **规范性唯一事实来源**（`docs/specification.md` 会引用它；JSON Schema 只是构建时生成的非规范产物）
- [A2A CHANGELOG](https://github.com/a2aproject/A2A/blob/main/CHANGELOG.md) —— 各版本的准确发布日期与破坏性变更清单
- [What is A2A?](https://a2a-protocol.org/latest/topics/what-is-a2a/) —— 设计原则、请求生命周期
- [Core Concepts](https://a2a-protocol.org/latest/topics/key-concepts/) —— 角色、Part 结构、Artifact
- [Life of a Task](https://a2a-protocol.org/latest/topics/life-of-a-task/) —— 任务生命周期、迭代、产物版本
- [Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/) —— 名片发现、缓存、保护
- [Streaming & Async](https://a2a-protocol.org/latest/topics/streaming-and-async/) —— SSE 与推送通知、webhook 安全
- [A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/) —— 竖/横对照、修车铺例子
- [What's New in v1.0](https://a2a-protocol.org/latest/whats-new-v1/) —— 全部破坏性变更
- [a2a-python v0.3 → v1.0 迁移指南](https://a2aproject.github.io/a2a-python/docs/migrations/v1_0/) —— 枚举值/Part/名片的逐项对照
- [A2A 加入 Agentic AI Foundation](https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/) —— 治理归属现状
- [AAIF 官方博客：A2A Joins AAIF](https://aaif.io/blog/a2a-joins-aaif) —— ACP 合并、生产案例、分层表述
- [Linux Foundation 成立 AAIF](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) —— MCP/goose/AGENTS.md 同为创始项目
- [A2A SDK 列表（6 种语言）](https://a2a-protocol.org/latest/sdk/) —— Python / JS-TS / Java / Go / .NET / Rust
- [a2a-inspector](https://github.com/a2aproject/a2a-inspector) / [a2a-tck](https://github.com/a2aproject/a2a-tck) —— 交互式调试器 / 一致性测试套件（进阶篇会讲怎么用）
