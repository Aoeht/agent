# Docker 沙箱使用备忘

run_script 的容器后端。镜像定义见同目录 `Dockerfile`，参数拼装见 `src/tools/sandbox_docker.ts`。
本机现状：Docker v29.8.2 + `ai-agent-sandbox:latest` 已就绪，`auto` 模式实测解析为 **docker** 后端。

---

## 1. 构建 / 重建镜像

```bash
# 在仓库根目录执行
docker build -t ai-agent-sandbox:latest tools/sandbox/
```

前置（只做一次）：Docker Desktop → Settings → Resources → File Sharing，把沙箱所在盘符（如 `A:\`）加进去，否则 `-v A:\...:/workspace` 挂载会失败。

重建后冒烟一下（见第 4 节）。

---

## 2. 三个开关（环境变量，写在 `.env`）

当前 `.env` 未设置以下任何一项，即全走默认值。

| 变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `AGENT_SANDBOX` | `auto` / `docker` / `host` | `auto` | `auto`=daemon+镜像就绪才用容器，否则回退 host；`docker`=硬承诺，缺环境直接报错不降级；`host`=不用容器 |
| `AGENT_SANDBOX_IMAGE` | 镜像名 | `ai-agent-sandbox:latest` | host 模式忽略 |
| `AGENT_SANDBOX_NET` | `none` / `bridge` | `none` | `none`=断网；`bridge`=放开外网（危险，见第 8 节）。host 模式忽略 |

切换示例（临时强制容器模式）：

```bash
AGENT_SANDBOX=docker bun run src/index.ts
```

要长期生效就把 `AGENT_SANDBOX=docker` 写进 `.env`。

---

## 3. 确认 agent 真的用了 docker 后端

`auto` 会静默回退 host，用这个探针确认（在仓库根目录跑）：

```bash
cat > _probe.ts <<'TS'
import { resolveScriptSandbox, dockerDaemonAvailable } from "./src/tools/sandbox_docker";
console.log("daemon:", await dockerDaemonAvailable());
console.log("auto  ->", JSON.stringify(await resolveScriptSandbox("auto", { image: "ai-agent-sandbox:latest", network: "none" })));
TS
bun run _probe.ts; rm -f _probe.ts
```

期望输出 `backend:"docker"`。若返回 `host`，`reason` 字段会说明原因（无 daemon / 无镜像）。

---

## 4. 冒烟自检（粘贴即跑）

> **Git Bash 坑**：Git Bash 会把 `/workspace`、`...:/workspace` 里的 POSIX 路径转义成 Windows 路径（`/workspace → D:/Git/workspace`）。手动在 Git Bash 里敲 `docker run` 必须加 `MSYS_NO_PATHCONV=1`。项目代码走 `spawn("docker", [...])` 直连、不经 shell，**没有**这个问题——这只是手测时的注意事项。

```bash
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker run --rm \
  --network none --cap-drop ALL --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,size=64m,nosuid,nodev \
  --tmpfs /home/sandbox:rw,uid=1000,gid=1000,size=64m,nosuid,nodev \
  -u 1000:1000 -w /workspace \
  ai-agent-sandbox:latest \
  sh -c 'id; python3 --version; bun --version; bash --version | head -1;
         touch /etc/x 2>/dev/null && echo "rootfs WRITABLE(bad)" || echo "rootfs read-only(good)";
         python3 -c "import socket;s=socket.socket();s.settimeout(3);s.connect((\"1.1.1.1\",53))" 2>&1 | tail -1'
```

逐条应为：`uid=1000(sandbox)` / Python 3.12.x / bun 1.4.x / bash 5.2.x / `read-only(good)` / `Network is unreachable`。

绑定挂载端到端（读写宿主目录）：

```bash
WS="A:\\ai_agent\\.mcp-sandbox\\_t"; mkdir -p /a/ai_agent/.mcp-sandbox/_t; echo hi > /a/ai_agent/.mcp-sandbox/_t/in.txt
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker run --rm --network none -u 1000:1000 \
  -v "$WS:/workspace" -w /workspace ai-agent-sandbox:latest \
  python3 -c "print(open('in.txt').read().strip()); open('out.txt','w').write('ok')"
cat /a/ai_agent/.mcp-sandbox/_t/out.txt; rm -rf /a/ai_agent/.mcp-sandbox/_t
```

---

## 5. 镜像里有什么（速查）

- 解释器白名单：`python3`（3.12）、`bun`（1.4）、`bash`（5.2）。容器模式不认 `.ps1`（那是 host 后端专属）。
- 用户：非 root，固定 `uid/gid 1000`（`sandbox`）。
- 文件系统：rootfs 只读；可写面仅 `/tmp`（64m）、`/home/sandbox`（64m）两块 tmpfs + `/workspace` 绑定挂载。
- 基础镜像 digest 锁定（见 Dockerfile），不吃浮动 tag 被上游偷换。

资源硬顶（`buildDockerRunArgs` 固定下发）：

| 限制 | 值 |
|---|---|
| CPU | `--cpus 1` |
| 内存 | `--memory 512m`，`--memory-swap 512m`（无 2x 放大） |
| 进程数 | `--pids-limit 64`（防 fork bomb） |
| 文件句柄 | `nofile=256` |
| 单文件体积 | `fsize=1GB` |
| 能力 | `--cap-drop ALL` + `no-new-privileges` |
| 环境 | 零 `-e`，宿主环境变量（含 API Key）不透传 |

---

## 6. 升级镜像（重新锁 digest）

1. 改 `Dockerfile` 里的 tag（如 `python:3.12-slim` → 新版本）。
2. 构建 + 冒烟：`docker build -t ai-agent-sandbox:latest tools/sandbox/` 后跑第 4 节。
3. 查新 digest（PowerShell，命令见 `Dockerfile` 顶部注释）回填 `@sha256:`。
4. 提交时 diff 里的 digest 变化即升级记录。

---

## 7. 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `resolveScriptSandbox(auto)` 返回 host，reason 提 docker | 守护进程没起 | 启动 Docker Desktop |
| reason 提"镜像" | 镜像没构建 | 跑第 1 节 build |
| `docker` 模式直接抛错不降级 | 这是设计：`AGENT_SANDBOX=docker` 是硬承诺 | 缺什么补什么，或临时改回 `auto` |
| `working directory '/workspace' is invalid` | Git Bash 路径转义 | 手测加 `MSYS_NO_PATHCONV=1`（代码不受影响） |
| 挂载后容器看不到宿主文件 | File Sharing 没含该盘符 | Settings → Resources → File Sharing 加 `A:\` |
| 脚本要联网却 `Network is unreachable` | 默认 `none` 断网 | 确需联网才设 `AGENT_SANDBOX_NET=bridge`（见下） |

---

## 8. 已知边界（不是 bug，是取舍）

- **`bridge` = 全开外网 + workspace 绑定挂载 + 任意代码**，是最危险组合，只在脚本确需联网（如 `pip install`）时临时开，用完改回 `none`。
- **Windows 下 `-u 1000:1000` 对绑定挂载的 workspace 基本空转**：Docker Desktop 是 Linux VM，Windows 侧文件无真实 POSIX uid。workspace 的实际边界是"挂载范围"不是"权限"——容器内脚本能读写删整个 workspace。误删/误改由 checkpoint `/rewind` 兜底。
- **workspace 无目录级总配额**：单文件受 `fsize=1GB` 限，但多文件总量不限。靠断网 + 每次 run_script 人工确认缓解。
- 每次 run_script 都要 `requestHuman` 确认，非交互场景直接拒绝。
