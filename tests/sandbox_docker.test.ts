// docker 沙箱后端的离线单测：docker run 参数表（纯函数）与后端解析决策。
// 不需要起真容器；涉及 daemon 的分支按本机环境自动跳过。
// 运行：bun run tests/sandbox_docker.test.ts
import { buildDockerRunArgs, dockerDaemonAvailable, resolveScriptSandbox, type DockerRunSpec } from "../src/tools/sandbox_docker";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

async function rejects(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const SPEC: DockerRunSpec = {
  containerName: "ai-agent-run-test",
  image: "ai-agent-sandbox:latest",
  network: "none",
  workspaceHostPath: "C:\\work\\sb",
  argv: ["python3", "/workspace/ok.py", "--x", "1"],
};

async function main(): Promise<void> {
  const args = buildDockerRunArgs(SPEC);
  const joined = args.join(" ");

  check(args[0] === "run" && args.includes("--rm"), "一次性容器：run + --rm", joined);
  check(args[args.indexOf("--network") + 1] === "none", "默认断网（--network none）", joined);
  check(!joined.includes("bridge"), "none 档位下不出现 bridge", joined);
  check(
    joined.includes("--cap-drop ALL") && joined.includes("--security-opt no-new-privileges") && args.includes("--read-only"),
    "安全基线：去能力 + 禁提权 + rootfs 只读",
    joined
  );
  check(
    joined.includes("--cpus 1") && joined.includes("--memory 512m") && joined.includes("--pids-limit 64"),
    "资源硬顶：CPU/内存/pids",
    joined
  );
  check(
    args[args.indexOf("--memory-swap") + 1] === args[args.indexOf("--memory") + 1],
    "swap 总闸与 --memory 等值（无 2x 放大面）",
    joined
  );
  check(args.includes("--init"), "init 进程收割僵尸（PID 1 非脚本本身）", joined);
  check(
    joined.includes("--ulimit nofile=256:256") && joined.includes("--ulimit fsize=1073741824:1073741824"),
    "ulimit：句柄 + 单文件体积上限",
    joined
  );
  check(
    joined.includes("/tmp:rw,size=64m,nosuid,nodev") &&
      joined.includes("/home/sandbox:rw,uid=1000,gid=1000,size=64m,nosuid,nodev") &&
      !joined.includes("noexec"),
    "tmpfs nosuid,nodev（且不加 noexec，避免误伤 wheel dlopen）",
    joined
  );
  check(args.includes("C:\\work\\sb:/workspace") && args[args.indexOf("-w") + 1] === "/workspace", "工作区挂载为 /workspace 并设为工作目录", joined);
  check(args.includes("-u") && args[args.indexOf("-u") + 1] === "1000:1000", "非 root（uid 1000）运行", joined);
  check(!args.includes("-e") && !args.includes("--env") && !args.includes("--env-file"), "宿主环境变量零透传（无 -e）", joined);
  check(!args.includes("-i") && !args.includes("-t"), "不分配 stdin/tty", joined);
  check(
    args[args.indexOf(SPEC.image) + 1] === SPEC.argv[0] && joined.endsWith(SPEC.argv.join(" ")),
    "镜像之后是解释器 argv，逐个传递不经 shell",
    joined
  );

  const bridge = buildDockerRunArgs({ ...SPEC, network: "bridge" });
  check(bridge[bridge.indexOf("--network") + 1] === "bridge", "bridge 档位显式放开网络", bridge.join(" "));

  // 后端解析：host 模式确定回宿主机；daemon 相关分支按本机环境走
  const options = { image: "ai-agent-sandbox:latest", network: "none" as const };
  const hostRes = await resolveScriptSandbox("host", options);
  check(hostRes.backend === "host", "host 模式直接返回宿主机后端", hostRes);

  const daemon = await dockerDaemonAvailable();
  check(typeof daemon === "boolean", "docker 守护进程探测返回布尔（本机实际: " + daemon + "）");
  if (!daemon) {
    const autoRes = await resolveScriptSandbox("auto", options);
    check(autoRes.backend === "host" && autoRes.reason.includes("docker"), "无 docker 时 auto 显式回退并给出原因", autoRes);
    const dockerErr = await rejects(resolveScriptSandbox("docker", options));
    check(dockerErr?.message.includes("AGENT_SANDBOX=docker") ?? false, "无 docker 时 docker 模式抛错不降级", dockerErr?.message);
  } else {
    const missingImage = "ai-agent-sandbox-must-not-exist:test";
    const autoRes = await resolveScriptSandbox("auto", { ...options, image: missingImage });
    check(autoRes.backend === "host" && autoRes.reason.includes("镜像"), "有 daemon 无镜像时 auto 回退并给出构建命令", autoRes);
    const dockerErr = await rejects(resolveScriptSandbox("docker", { ...options, image: missingImage }));
    check(dockerErr?.message.includes("镜像") ?? false, "有 daemon 无镜像时 docker 模式抛错不降级", dockerErr?.message);
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
    if (failures > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("TEST CRASHED:", error);
    process.exitCode = 1;
  });
