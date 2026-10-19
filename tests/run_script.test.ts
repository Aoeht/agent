// 沙箱脚本执行器：路径守卫、解释器白名单、人工确认闸门、超时终止、输出截断、非零退出码透传。
// docker 后端：守卫与确认行为与 host 一致；真实容器执行仅在守护进程与镜像就绪的机器上运行。
// 运行：bun run tests/run_script.test.ts
import fs from "node:fs/promises";
import path from "node:path";
import { createRunScriptTool } from "../src/tools/run_script";
import { dockerDaemonAvailable, sandboxImagePresent } from "../src/tools/sandbox_docker";

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

const ROOT = path.resolve(".sand-box/.tmp-run-script");
const allow = async () => "y";

async function main(): Promise<void> {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  const tool = createRunScriptTool({ sandboxRoot: ROOT });

  await fs.writeFile(path.join(ROOT, "ok.js"), `console.log("hello " + (process.argv[2] ?? "nobody"));`, "utf-8");
  await fs.writeFile(path.join(ROOT, "fail.js"), `console.error("boom"); process.exit(3);`, "utf-8");
  await fs.writeFile(path.join(ROOT, "args.js"), `console.log(JSON.stringify(process.argv.slice(2)));`, "utf-8");
  await fs.writeFile(path.join(ROOT, "slow.js"), `setTimeout(() => {}, 30_000);`, "utf-8");
  await fs.writeFile(path.join(ROOT, "big.js"), `console.log("大".repeat(30_000));`, "utf-8");
  await fs.writeFile(path.join(ROOT, "note.txt"), "这不是脚本", "utf-8");

  try {
    const ok = (await tool.execute({ script: "ok.js", args: ["世界"] }, { requestHuman: allow })) as {
      exit_code: number;
      stdout: string;
    };
    check(ok.exit_code === 0 && ok.stdout.includes("hello 世界"), "脚本执行并捕获 stdout 与参数", ok);

    const fail = (await tool.execute({ script: "fail.js" }, { requestHuman: allow })) as {
      exit_code: number;
      stderr: string;
    };
    check(fail.exit_code === 3 && fail.stderr.includes("boom"), "非零退出码与 stderr 照常返回而不是抛错", fail);

    const args = (await tool.execute({ script: "args.js", args: ["a", "b c"] }, { requestHuman: allow })) as {
      stdout: string;
    };
    check(args.stdout.includes('["a","b c"]'), "参数逐个传递（无 shell 拼接）", args.stdout);

    check(
      (await rejects(tool.execute({ script: "../outside.js" }, { requestHuman: allow })))?.message.includes("越出工作区") ??
        false,
      "相对路径越界被拒"
    );
    check(
      (await rejects(tool.execute({ script: path.resolve(ROOT, "..", "outside.js") }, { requestHuman: allow })))?.message.includes(
        "越出工作区"
      ) ?? false,
      "绝对路径越界被拒"
    );
    check(
      (await rejects(tool.execute({ script: "missing.js" }, { requestHuman: allow })))?.message.includes("不存在") ?? false,
      "脚本不存在被拒"
    );
    check(
      (await rejects(tool.execute({ script: "note.txt" }, { requestHuman: allow })))?.message.includes("不支持的脚本类型") ?? false,
      "解释器白名单外的扩展名被拒"
    );

    const denied = await rejects(tool.execute({ script: "ok.js" }, { requestHuman: async () => "n" }));
    check(denied?.message.includes("用户回复：n") ?? false, "用户拒绝后不执行并透出回复", denied?.message);
    const cancelled = await rejects(tool.execute({ script: "ok.js" }, { requestHuman: async () => null }));
    check(cancelled?.message.includes("用户取消") ?? false, "确认通道返回 null 视为取消");
    const noChannel = await rejects(tool.execute({ script: "ok.js" }));
    check(noChannel?.message.includes("人工确认通道") ?? false, "无确认通道时直接拒绝（安全默认）", noChannel?.message);

    const timedOut = (await tool.execute({ script: "slow.js", timeout_ms: 1_000 }, { requestHuman: allow })) as {
      timed_out?: boolean;
      exit_code: number;
    };
    check(timedOut.timed_out === true && timedOut.exit_code === 124, "超时强制终止并标注", timedOut);

    const big = (await tool.execute({ script: "big.js" }, { requestHuman: allow })) as {
      stdout: string;
      stdout_truncated?: boolean;
    };
    check(big.stdout.length === 10_000 && big.stdout_truncated === true, "超长输出截断并标注", {
      len: big.stdout.length,
      truncated: big.stdout_truncated,
    });

    // ===== docker 后端：不依赖 daemon 的守卫部分（与 host 共用同一套硬边界）=====
    const dockerTool = createRunScriptTool({
      sandboxRoot: ROOT,
      backend: { kind: "docker", image: "ai-agent-sandbox:latest", network: "none" },
    });
    await fs.writeFile(path.join(ROOT, "d.py"), "print('py-ok')", "utf-8");
    await fs.writeFile(path.join(ROOT, "d.ps1"), "Write-Output 'x'", "utf-8");

    check(
      (await rejects(dockerTool.execute({ script: "../outside.py" }, { requestHuman: allow })))?.message.includes("越出工作区") ?? false,
      "docker 后端同样执行路径守卫"
    );
    check(
      (await rejects(dockerTool.execute({ script: "d.ps1" }, { requestHuman: allow })))?.message.includes(".ps1") ?? false,
      "docker 后端拒绝 .ps1（容器内无对应解释器）"
    );
    check(
      (await rejects(dockerTool.execute({ script: "d.py" })))?.message.includes("人工确认通道") ?? false,
      "docker 后端同样要求人工确认通道"
    );
    const seenPrompts: string[] = [];
    const deniedDocker = await rejects(
      dockerTool.execute({ script: "d.py" }, { requestHuman: async (p) => { seenPrompts.push(p); return "n"; } })
    );
    check(deniedDocker?.message.includes("用户回复：n") ?? false, "docker 后端确认拒绝后不执行", deniedDocker?.message);
    check(
      (seenPrompts[0]?.includes("docker") && seenPrompts[0]?.includes("断开")) ?? false,
      "确认提示展示容器执行形态与网络档位（透明性）",
      seenPrompts[0]
    );

    // ===== docker 后端：真实容器执行（守护进程 + 沙箱镜像就绪才跑）=====
    const dockerReady = (await dockerDaemonAvailable()) && (await sandboxImagePresent("ai-agent-sandbox:latest"));
    if (dockerReady) {
      const py = (await dockerTool.execute({ script: "d.py" }, { requestHuman: allow })) as {
        exit_code: number;
        stdout: string;
        sandbox?: string;
      };
      check(py.exit_code === 0 && py.stdout.includes("py-ok") && py.sandbox === "docker", "docker 后端真实执行 python 脚本", py);

      await fs.writeFile(
        path.join(ROOT, "net.py"),
        `import urllib.request\nurllib.request.urlopen("http://example.com", timeout=3)\nprint("online")`,
        "utf-8"
      );
      const net = (await dockerTool.execute({ script: "net.py" }, { requestHuman: allow })) as { exit_code: number; stdout: string };
      check(net.exit_code !== 0 && !net.stdout.includes("online"), "docker 后端默认断网（外联失败）", net);

      await fs.writeFile(path.join(ROOT, "slow.py"), "import time\ntime.sleep(30)", "utf-8");
      const slow = (await dockerTool.execute({ script: "slow.py", timeout_ms: 2_000 }, { requestHuman: allow })) as {
        timed_out?: boolean;
        exit_code: number;
      };
      check(slow.timed_out === true && slow.exit_code === 124, "docker 后端超时终止容器并标注", slow);
    } else {
      console.log("⏭️  跳过 docker 真实执行用例（守护进程未运行或镜像未构建：docker build -t ai-agent-sandbox:latest tools/sandbox/）");
    }
  } finally {
    await fs.rm(ROOT, { recursive: true, force: true });
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
