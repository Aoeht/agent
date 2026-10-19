# Web UI 入门篇（零前端基础，不预设你写过一行浏览器代码）

> **前置假设**：你熟悉这个项目的**后端**——知道 `Agent`、`AgentEventBus`、`SessionStore`、工具注册表、MCP 这些东西是什么（它们在 `docs/使用说明书.md` 和源码里）。前端方面**什么都不预设**：HTML、CSS、React、npm 这些词第一次出现都会先用人话解释。
>
> **配套代码**：前端在 `A:\ai_agent\web\`，它对接的后端在 `A:\ai_agent\src\server\`，两者的合同在 `A:\ai_agent\src\server\protocol.ts`。文中 `文件:位置` 都指向真实代码。
>
> **本文的定位**：前 3 章用人话把前端的地基名词补齐；**第 4～8 章是本文的重心——后端怎么接上前端**，每一处都写到"数据长什么样、走了哪个文件、界面上对应哪个控件"的粒度。读完你应该能自己回答："我点一下『发送』，数据到底经过了什么？"

---

## 目录

| 章 | 内容 | 读完你能回答 |
|---|---|---|
| 0 | 全景图：这套 UI 由哪几块组成 | 浏览器、两个端口、后端各是什么关系 |
| 1 | 浏览器三件套：HTML / CSS / JavaScript | 网页的骨架、皮肤、行为分别是什么 |
| 2 | TypeScript 与 React：为什么前端代码长那样 | "组件"是什么，界面为什么会自己变 |
| 3 | `web/` 目录导览 | 每个文件对应后端的哪个概念 |
| 4 | 开发时到底在跑什么：两个端口 | 5173 和 8787 各是谁，"代理"干嘛的 |
| 5 | 接续·合同篇：`protocol.ts` | 前后端唯一约定的东西是什么样 |
| 6 | 接续·通道篇：REST 与 SSE | 一问一答和广播的区别、SSE 帧长什么样 |
| 7 | 接续·端点总表 | 每个按钮背后是哪个端点、哪段后端代码 |
| 8 | 接续·一次回合全程直播 | 从点"发送"到字出现在屏幕上的 12 步 |
| 9 | 会话与历史：为什么刷新不丢 | JSONL 历史怎么变成界面上的气泡 |
| 10 | 三种人工参与：审批 / 输入 / 停止 | 确认弹窗是怎么"暂停"住后端的 |
| 11 | Mock：没有后端 UI 也能跑的秘密 | 一个接口、两套实现 |
| 12 | 动手：加一个新功能要动哪些文件 | 照着清单就能扩展 |
| 13 | 症状速查表 | 白屏/下拉空/标题是文件名…先查这里 |
| 14 | 自测 12 题 | 检验是否真懂了 |

---

# 第 0 章 全景图：这套 UI 由哪几块组成

先把你已知的东西摆出来。你在终端里用过的那套 agent（`bun run src/index.ts`）是这么工作的：

```
你（终端打字） → REPL → Agent.run() → 事件总线 → 终端打印 / trace 落盘
```

Web UI **没有改动这条链路的任何一环**。它只是在事件总线上多接了一个消费者，再把打印到终端的内容改成画到浏览器里：

```
┌──────────┐   REST（你点按钮时发）     ┌─────────────────┐
│  浏览器   │ ────────────────────────→ │  UI 服务器        │
│  web/    │ ←──────────────────────── │  src/server/     │
│ (React)  │   SSE（后端有事件就推）      │  Bun.serve       │
└──────────┘                           └───────┬─────────┘
                                               │ 直接调用（同进程）
                                       ┌───────▼─────────┐
                                       │ Agent + 工具 + MCP │
                                       │ （你已经懂的全部）   │
                                       └─────────────────┘
```

三个角色：

- **浏览器里的界面**（`web/` 目录）——这叫**前端**。它跑在访问者的浏览器里，不在你的服务器上。
- **UI 服务器**（`src/server/`，`bun run src/server/main.ts` 启动）——一个普通的 Bun 程序，对外说 HTTP 这门"普通话"，对内直接 `new Agent()`、订阅事件总线。它叫**后端**（广义上你原来那套 agent 也是后端，这里特指加的这层壳）。
- **协议合同**（`src/server/protocol.ts`）——前后端之间"说什么话"的完整约定，第 5 章细讲。

一个关键直觉：**UI 服务器是事件总线的第三个消费者**。终端打印和 trace 落盘是前两个，UI 服务器订阅同样的事件，翻译成 JSON，推给浏览器。Agent 至今不知道 UI 的存在。

---

# 第 1 章 浏览器三件套：HTML / CSS / JavaScript

浏览器只会认三种东西，所有前端框架最终都被编译成这三种：

- **HTML**——骨架。它描述"页面上有什么"：一个标题、一个输入框、一个按钮。用尖括号标签书写，比如 `<button>发送</button>` 就是一个按钮。
- **CSS**——皮肤。它描述"这些东西长什么样"：按钮是什么颜色、圆角多大。我们的米白色板和圆角就全是 CSS。
- **JavaScript（JS）**——行为。它描述"点了之后发生什么"：读取输入框内容、发请求、把新消息画上去。它是唯一能在浏览器里跑的编程语言。

类比写后端的话：HTML 像数据库表结构（有什么字段），CSS 像日志格式化规则（长什么样），JS 像 main 函数（干什么）。

**TypeScript（TS）** 是 JavaScript 加上类型标注的版本——写法和你后端里的 TS 完全一样。浏览器不认识 TS，所以需要一个工具在运行前把类型"剥掉"，这件事由第 4 章的 Vite 自动完成。`web/` 下所有 `.ts`/`.tsx` 文件都是 TS。

---

# 第 2 章 TypeScript 与 React：为什么前端代码长那样

## 2.1 React 的核心主张：界面 = 状态的函数

传统写法是"拿到数据，然后手动操作页面"：加一条消息就 `页面上插入一个气泡`。消息一多、状态一复杂（流式中、工具执行中、审批弹出…），手动同步必然出错。

**React** 换了个思路：**你只声明"界面长什么样是数据的函数"，数据变了 React 自动重画**。你看 `web/src/components/ChatPanel.tsx` 的渲染逻辑，本质就是一句伪代码：

```
界面 = items.map(item => 按 item.kind 画成 气泡/工具卡/提示条)
```

`items` 是数据（消息数组）。流式输出时数据每个几十毫秒变一次，你**从不需要手动"往屏幕上加字"**——只改数组，React 负责剩下的。

## 2.2 一个组件长什么样

组件就是一个返回界面的函数。看一个删减版的真实代码（`web/src/components/ChatPanel.tsx`）：

```tsx
function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <div className="...">{item.text}</div>;      // 右对齐的米色气泡
    case "tool":
      return <ToolCard item={item} />;                     // 可折叠的工具调用卡
    case "notice":
      return <div className="...">{item.text}</div>;       // 居中的提示条
  }
}
```

- `ChatItem` 是 TS 类型，**就是 `state/store.tsx` 里定义的消息模型**——它的形状与后端协议一一对应（第 5 章）。
- `className="..."` 里那些单词是 CSS 类名（Tailwind，2.3 节）。
- 文件后缀 `.tsx` 表示"这个 TS 文件里混着 HTML 标签"。

## 2.3 状态存在哪

`web/src/state/store.tsx` 是整个应用唯一的状态仓库（一个 `useReducer`）。它持有：

- 会话列表、当前选中的会话、每个会话的消息数组 `items`；
- 计划步骤、审批弹窗数据、运行统计、上下文占用……

**只有 `store.tsx` 允许根据后端事件修改状态**，组件只负责读状态画界面。所以"后端事件 → 界面变化"的映射规则全部集中在 `store.tsx` 的 `applyEvent()` 一个函数里——这是你排查"界面为什么显示成这样"的第一入口。

## 2.4 Tailwind：写在标签里的 CSS

你会在代码里看到大量 `rounded-2xl border border-cream-300 bg-cream-50` 这样的单词串。这是 **Tailwind**：每个单词是一个现成的 CSS 样式（圆角、边框、底色），拼起来就是完整样式。颜色名（`cream`、`clay`）是我们自定义的色板，定义在 `web/src/styles.css` 的 `@theme` 里——**想换配色只改这一个文件**。

---

# 第 3 章 `web/` 目录导览

```
web/
├── package.json          前端自己的依赖清单（与后端 bun.lock 互不影响）
├── vite.config.ts        开发服务器配置：端口、代理（4.3 节）、@protocol 别名
├── index.html            唯一的 HTML：一个空的 <div id="root">，其余全由 JS 画出
├── dist/                 生产构建产物（bun run build 生成；后端 8787 直接托管它）
└── src/
    ├── main.tsx          启动入口：选择 Transport（真后端 or Mock）并挂载应用
    ├── App.tsx           整体布局：左栏 + 中栏 + 右栏 + 各弹窗
    ├── styles.css        Tailwind 色板与 markdown 排版样式
    ├── lib/
    │   ├── transport.ts  ★ 传输接口：前端到后端"能做的所有事"的方法签名
    │   ├── http.ts       ★ 真实实现：fetch 发 REST + EventSource 收 SSE
    │   └── mock.ts       演示实现：不连后端，本地按协议造假事件
    ├── state/
    │   └── store.tsx     ★ 状态仓库：后端事件 → 界面状态 的唯一归约点
    └── components/
        ├── Sidebar.tsx   左栏：会话列表、新会话
        ├── ChatPanel.tsx 中栏：消息气泡、工具卡、提示条、流式光标
        ├── Composer.tsx  输入区：文本框、发送/停止、⚙模型参数弹层
        ├── RightPanel.tsx 右栏：任务计划、工具开关、运行统计、环境卡
        └── Modals.tsx    弹窗：审批、人工输入、沙箱目录
```

打 ★ 的三个文件是**前后端接续的全部所在**：`transport.ts` 定义"能做什么"，`http.ts` 定义"怎么发"，`store.tsx` 定义"收到了放进哪个状态"。第 6～8 章全部围绕它们展开。

---

# 第 4 章 开发时到底在跑什么：两个端口

## 4.1 两个进程

```
bun run src/server/main.ts   →  127.0.0.1:8787   UI 服务器（你熟悉的后端 + HTTP 壳）
cd web && bun run dev        →  localhost:5173   Vite 开发服务器（前端）
```

**Vite** 是前端的开发工具箱：把 TS 编译成浏览器能跑的 JS、样式热更新（改代码浏览器立刻变）、开发期顺带当静态文件服务器。

## 4.2 为什么浏览器访问 5173 却能调到 8787 的接口

前端的请求写的是相对路径（如 `POST /sessions`），浏览器会发到 `localhost:5173`——但 5173 上并没有 `/sessions` 这个后端。 Vite 的**代理（proxy）**在这里接力：`web/vite.config.ts` 里配置了"凡是 `/sessions`、`/approvals`、`/inputs`、`/status`、`/models`、`/settings` 开头的请求，都转发给 `127.0.0.1:8787`"。

对浏览器来说它始终只跟 5173 说话（同源，没有跨域问题）；对后端来说它只管接 8787 的请求。**代理清单漏了哪个路径，哪个功能就会静默 404**——我们真实踩过这个坑（模型下拉空了，原因就是没配 `/models`）。

## 4.3 生产形态：一个端口

`cd web && bun run build` 会产出 `web/dist/`（纯静态文件）。UI 服务器会自动托管这个目录——**生产环境只有一个 8787 端口**，不需要 Vite。这也是为什么 `vite.config.ts` 的改动只在开发期有意义。

---

# 第 5 章 接续·合同篇：`protocol.ts` 是唯一约定

前后端是两个独立进程、可以分别重写，它们之间**只**通过 `src/server/protocol.ts` 里的约定通信。这份合同里有两类东西。

## 5.1 下行事件（后端 → 前端，走 SSE）

用 zod 定义的一个大联合类型，每个事件一种形状。全部 15 种：

| 事件 | 什么时候发 | 前端拿它干什么 |
|---|---|---|
| `hello` | SSE 连上后第一条 | 填右栏环境卡（模型/沙箱/技能/MCP 状态） |
| `run_start` | 每回合开始 | 顶栏变"运行中"，出现停止按钮 |
| `token` | 流式每个增量 | 往当前气泡追加一个字 |
| `tool_call_start` | 工具开始执行 | 新建一个转圈的工具卡 |
| `tool_call_end` | 工具执行完 | 工具卡填结果、变绿点、自动收起 |
| `step` | 一轮 LLM 调用完成 | 记录 token 用量（画上下文占用条） |
| `plan_update` | 模型调 update_plan | 右栏计划清单整体刷新 |
| `compact` | 上下文压缩 | 一条"🗜️ 上下文压缩"提示条 |
| `retry` | LLM 请求重试 | 一条"⚠️ 第 N 次重试"提示条 |
| `approval_request` | 需要人工确认 | 弹出审批模态框 |
| `human_input_request` | 需要用户敲字 | 弹出输入模态框（当前版本保留未用） |
| `run_end` | 回合结束 | 状态回"空闲"、统计卡更新 |
| `session_config` | 模型/参数被修改 | 胶囊按钮、环境卡实时刷新 |
| `session_name` | 会话名生成 | 顶栏标题和侧栏改名 |
| `error` | 后端异常 | 一条红色错误提示条 |

注意三件事：

1. **这些事件和 `core/events.ts` 的事件总线几乎一一对应**。`AgentEventBus` 发什么，UI 服务器就转发什么——多出来的 `hello / tool_call_* / approval_request / session_config / session_name` 是 UI 专属的，由服务器自己产生（工具的开始/结束来自注册表中间件，审批来自人工确认桥）。
2. **事件只增不改**。新增事件、给老事件加可选字段都向后兼容；改语义或删字段必须两边同步。这条纪律写在 `protocol.ts` 头注释里。
3. 事件是**带类型的**：前端 `import type { ServerEvent } from "@protocol"`——后端改了合同没改前端，前端编译直接报错，不用等运行时炸。

## 5.2 上行请求（前端 → 后端，走 REST）

前端能"主动做"的事也全部在合同里列了端点（`protocol.ts` 头注释就是完整清单）。DTO（数据传输对象）如 `SessionSummaryDTO` 也是共享类型——后端返回什么字段，前端就有什么字段。

---

# 第 6 章 接续·通道篇：REST 与 SSE

前后端之间只有两种通道，选型标准就一条：**谁主动**。

## 6.1 REST：前端主动的一问一答

**REST** 就是最普通的 HTTP 请求：前端 `fetch` 一个地址，后端回一个 JSON，结束。适合"前端发起、后端立刻答"的事——发消息、切模型、开关工具。

前端侧的全部封装在 `web/src/lib/http.ts`，比如：

```ts
async sendMessage(sessionId: string, text: string): Promise<void> {
  await this.request(`/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}
```

和你后端里熟悉的 HTTP 客户端调用没有本质区别。

## 6.2 SSE：后端主动的广播

回合运行时，事件是**后端产生、前端被动接收**的——总不能让前端每 100ms 来问一次"有新字吗"。我们用的是 **SSE（Server-Sent Events，服务器推送事件）**：前端用浏览器内置的 `EventSource` 打开一个长连接，后端有事件就往连接里写一行 `data: ...`，浏览器自动触发回调。

线上的一帧长这样（真实抓包）：

```
data: {"type":"token","delta":"好"}

data: {"type":"run_end","success":true,"finalAnswer":"好","totalTokens":6636,...}
```

格式就是"每条消息一行 `data: <JSON>`，空行分隔"。前端侧在 `http.ts` 的 `subscribe()` 里：

```ts
const source = new EventSource(`/sessions/${id}/events`);
source.onmessage = (message) => onEvent(JSON.parse(message.data));
return () => source.close();   // 退订 = 关连接
```

SSE 三个对你重要的性质：

1. **自动重连**：连接断了浏览器自己重连（后端会在重连后重发 `hello` 和未决审批，所以刷新页面不会丢审批弹窗）。
2. **单向**：SSE 只能后端→前端。所以"取消""应答审批"这类上行走 REST（第 10 章）。
3. **心跳**：后端每 15 秒发一行注释 `: ping` 防止中间设备掐断空闲连接（`src/server/main.ts` 的 `sseResponse`）。

## 6.3 消息的入口只有一个

前端收到任何事件，都只会做一件事：`dispatch({ type: "event", id: 会话id, event })` 丢给 `store.tsx`。**协议事件 → 界面状态** 的全部翻译逻辑集中在 `store.tsx` 的 `applyEvent()` 纯函数里（每个事件一个 case）。想知道"某事件会改变界面上的什么"，看那一个 switch 就够。

---

# 第 7 章 接续·端点总表：每个控件背后是谁

这张表是前后端的"接线图"。左列是你在界面上能碰到的东西，右列是它调用的端点与后端落点。

| 界面控件 | 前端调用（http.ts） | 端点 | 后端落点 |
|---|---|---|---|
| 侧栏会话列表 | `listSessions()` | `GET /sessions` | `SessionManager.list()` → `SessionStore.list()` |
| ＋ 新会话 | `createSession()` | `POST /sessions` | `newSession()`（session_picker） |
| 选一个会话 | `openSession()` + `subscribe()` | `GET .../history` + `GET .../events` | `store.load()` + SSE 挂连接 |
| 输入框发送 | `sendMessage()` | `POST .../messages` | `SessionManager.sendMessage()` → `agent.run()` |
| ⏹ 停止 | `cancel()` | `POST .../cancel` | `controller.abort()` + 未决审批收口 |
| 审批弹窗 允许/拒绝 | `respondApproval()` | `POST /approvals/:id` | `UiBridge.resolveApproval()` |
| ⚙ 模型参数 应用 | `applySessionConfig()` | `POST .../config` | `agent.setModel/setTemperature/...` |
| ⚙ 模型下拉 | `listModels()` | `GET /models` | live 查服务商 `/models` + env 合并 |
| 更改沙箱目录 | `setSandboxRoot()` | `POST /settings/sandbox` | `rebuildRuntimeWithSandboxRoot()` 整栈重建 |
| 工具开关勾选 | `setToolState()` | `POST .../tools` | 会话注册表反注册/恢复 |
| 右栏环境卡 | `getSettings()` / hello 事件 | `GET /settings` / SSE | `runtime.sandboxRoot` 等 |

注意两个设计点：

- **发消息是 202 而不是 200**：`POST messages` 立刻返回"收到"，回合在后台跑，过程与结果全部经 SSE 推送。忙时返回 **409**（同一会话同时只允许一个回合）。
- **同一会话的两次发送不会混**：每个会话一个 Agent 实例、一份独立注册表（多会话还能并行，这属于进阶篇）。

---

# 第 8 章 接续·一次回合全程直播

把第 5～7 章串起来。场景：你在输入框打"只回答一个字：好"，点发送。

**第 1 步 · 前端发出请求。** `Composer` 组件调用 `onSend` → `store.tsx` 的 `send()`：先在本地立刻插入一条用户气泡（不用等网络），再 `POST /sessions/<id>/messages`，body 是 `{"text":"只回答一个字：好"}`。

**第 2 步 · 后端接单。** `src/server/main.ts` 路由检查会话是否忙（忙则 409），不忙返回 **202**，然后后台调 `SessionManager.sendMessage()`。

**第 3 步 · 组装回合。** `sendMessage` 保证该会话没有并发回合，然后 `runTurn()`：必要时先 `ensureAgent()`（第一次会给这个会话建独立的 Agent、工具注册表、计划仓），再用 AsyncLocalStorage 把"当前会话是谁"包进运行上下文，最后调 `agent.run(text, { signal, requestHuman })`——**到这里就进入了你已经熟悉的后端世界**。

**第 4 步 · 事件开始流出。** Agent 发 `run_start` 到事件总线；UI 服务器的事件转发器（`attachEventRelay`）把它翻译成协议事件：

```json
data: {"type":"run_start","userMessage":"只回答一个字：好","promptHash":"a319abb112d9"}
```

**第 5 步 · 流式打字。** 模型每吐几个字，Agent 发 `token` 事件 → 服务器转发 → 前端 `applyEvent` 的 `case "token"`：如果最后一条是"流式中的助手气泡"就追加文字，否则新建一个。你看到的打字机效果就是这一步。

**第 6 步 · 工具执行（如果模型调了工具）。** Agent 调 `registry.execute()`，会话注册表上的**中间件**在执行前后各发一个事件：

```json
data: {"type":"tool_call_start","callId":"tool-xxx","name":"git_tree","arguments":"{\"maxDepth\":2}"}
data: {"type":"tool_call_end","callId":"tool-xxx","result":"src/\n  core/ ..."}
```

前端据此画一张工具卡：开始时转圈，结束时填入结果并自动收起。

**第 7 步 · 人工确认（如果工具需要）。** `run_script` 执行前会调 `requestHuman` ——这是 UI 服务器的审批桥：生成一个审批 id，向该会话的所有 SSE 连接广播 `approval_request`，然后**原地挂起等待**。前端弹出确认框；你点"允许执行"→ `POST /approvals/<id>` → 桥接层返回 `"y"`，后端继续执行脚本。**120 秒无人应答自动按拒绝处理**——审批永远不默认放行。

**第 8 步 · 计划与压缩。** 模型调 `update_plan` → Agent 发 `plan_update` → 右栏清单刷新；上下文压缩 → `compact` 事件 → 提示条。对你来说都只是事件总线上的普通事件。

**第 9 步 · 回合结束。** `agent.run()` 返回 `AgentResult`，`runTurn` 用**返回值**（而不是总线事件）发 `run_end`——因为它有总线事件里没有的 `finalAnswer`：

```json
data: {"type":"run_end","success":true,"finalAnswer":"好","totalTokens":6636,"toolCallsCount":0,"iterations":1}
```

**第 10 步 · 界面收尾。** 前端把流式气泡定格、状态回"空闲"、统计卡更新（Token/工具调用/迭代）、上下文占用条按最新一轮的 promptTokens 重画。

**第 11 步 · 起名（仅新会话第一次成功回合）。** 服务器用摘要模型生成会话名 → `recordSessionName` 落盘 → 发 `session_name` → 顶栏和侧栏改名。

**第 12 步 · 长期记忆。** 后台长期摘要折叠照常发生（你可能看到一条 🗜️ 提示）——这完全是你原来那套机制，UI 只是转述。

---

# 第 9 章 会话与历史：为什么刷新不丢

历史的唯一事实来源是后端的 `.agent-sessions/<id>.jsonl`（和 CLI 共用！）。前端**不持久化任何东西**：

1. 页面加载 → `GET /sessions` 拿列表（会话名、消息数、最近更新时间都来自 `SessionStore.list()`）；
2. 选中某个会话 → `GET /sessions/<id>/history` 拿完整历史（`store.load()` 的结果，元记录已被剔除）；
3. 前端把历史数组转成消息项渲染；之后的实时事件继续追加。

所以刷新页面、换浏览器、甚至后端重启，只要 JSONL 在，对话就在。侧栏标题的回退顺序是：会话名 → 首条消息预览 → 文件名（`Sidebar.tsx` 的 `sessionTitle()`）。

---

# 第 10 章 三种人工参与

| 你做的动作 | 界面 | 通道 | 后端语义 |
|---|---|---|---|
| 允许/拒绝脚本或敏感工具 | 审批弹窗（带表单） | SSE 收 `approval_request` → REST 应答 | requestHuman / Confirmer 的返回值 |
| 提交自由文本 | 输入弹窗 | 同上（`human_input_request`，当前版本保留） | requestHuman 的字符串返回值 |
| 点"停止" | 停止按钮 | REST `POST .../cancel` | AbortController 中止 run；未决审批按拒绝收口 |

共同纪律：**等待人工期间后端是挂起的**（一个未决 Promise）；超时（默认 120 秒）一律按拒绝/取消处理——审批绝不可能因为断线而变成放行。

---

# 第 11 章 Mock：没有后端 UI 也能跑

`main.tsx` 里有一行选择：

```ts
const transport = import.meta.env.VITE_TRANSPORT === "mock" ? new MockTransport() : new HttpTransport();
```

`Transport` 接口（`lib/transport.ts`）列出前端需要的全部能力；`HttpTransport` 用真网络实现它，`MockTransport` 用定时器按协议造假事件实现它。**组件只认接口，不认实现**——所以：

- 纯前端开发/演示：`VITE_TRANSPORT=mock bun run dev`，一个后端都不用起；
- 接真实后端：默认即可，改一行都不用。

这就是"前后端分离"的实际含义：**合同（protocol + Transport 接口）不变，两边各改各的**。

---

# 第 12 章 动手：加一个新功能要动哪些文件

以"给侧栏加一个删除会话按钮"为例，完整清单：

1. **合同**：`protocol.ts` 端点清单加一行 `DELETE /sessions/:id`（无需新事件）；
2. **后端**：`SessionManager` 加 `remove(sessionId)`（abort + disposeSession + 删 JSONL + entries 移除）；`main.ts` 加路由；
3. **前端接口**：`transport.ts` 的 `Transport` 加 `removeSession()`；`http.ts` 实现；`mock.ts` 实现；
4. **前端状态**：删除成功后从 `sessions` 列表移除（可加一个 action 或复用 sessions_loaded）；
5. **前端界面**：`Sidebar.tsx` 加按钮。

记住这个顺序：**合同先行，后端跟上，前端接口、状态、界面收尾**。进阶篇里有更细的"最小 diff"清单。

---

# 第 13 章 症状速查表

| 症状 | 先查什么 |
|---|---|
| 页面全白 | 浏览器控制台（F12）看报错；多半是刚改了代码 HMR 没接上，刷新即可 |
| 模型下拉是空的 | `vite.config.ts` 代理清单里有没有 `/models`；`GET /models` 直接 curl 是否 200 |
| 界面数据不更新但后端正常 | 页面左上角刷新；SSE 断线重连后应自动恢复，连不上先看 8787 是否活着 |
| 标题是 session-xxx 文件名 | 该会话还没生成过会话名；属正常回退（首条消息预览会优先显示） |
| 会话内容出现 � 乱码 | 是用 git-bash curl 发中文测试造成的（curl 以本地 GBK 编码发送）；浏览器不会 |
| 工具卡一直转圈 | 后端日志看工具是否卡在等待人工确认（审批超时 120 秒自动拒绝） |
| 点击没反应（自动化测试时） | Playwright 点击超时是内嵌浏览器 known-issue，用 `evaluate(() => btn.click())` 代替 |
| 改了 web/ 代码页面没变 | Vite 热更新偶尔失灵，`bun run dev` 重启 + 浏览器刷新 |

---

# 第 14 章 自测 12 题

1. 浏览器访问 5173，后端在 8787，中间是谁在转发？转发清单在哪个文件？
2. `protocol.ts` 里的 15 种事件，哪 5 种是 UI 服务器自己产生的（不是事件总线直通）？
3. 为什么发消息返回 202 而不是等结果？答案从哪条通道来？
4. `token` 事件和 `step` 事件都带模型输出，为什么流式时前端只消费前者？
5. SSE 断线后前端要写重连代码吗？刷新页面后未决审批为什么不会丢？
6. 审批 120 秒超时后，后端的行为是什么？为什么不能是"放行"？
7. 工具卡"执行中"的转圈状态靠哪个事件？它由后端哪段代码产生（提示：不是事件总线原生事件）？
8. 上下文占用条的分子分母分别来自哪两个事件/字段？
9. 前端刷新页面后，对话内容从哪里恢复？靠哪个端点？
10. `VITE_TRANSPORT=mock` 之后，哪些文件还在工作、哪些完全不参与？
11. 为什么同一个会话连点两次发送，第二次会 409？跨会话为什么可以并行？
12. 想加"导出会话为 Markdown"按钮，最少要动哪几个文件？

（答案都能在第 4～12 章找到；第 12 题照第 12 章清单套用。）

---

> **读完做什么**：把两个进程跑起来，打开浏览器 F12 的 Network 面板，发一条消息——你会亲眼看到第 8 章的每一步：一条 202 的 POST、一条挂起的 `events` 连接、源源不断的 SSE 帧。然后去读 `docs/WebUI进阶篇.md`，那里讲"为什么这么设计、坑在哪、怎么扩展"。
