// checkpoint_store 回归：真实 git 上的回合快照与恢复（改动回退/新增清除/删除找回、
// 工作区内 .gitignore 不影响快照范围、空目录清理、中文文件名、超量裁剪、会话截断），
// 以及最重要的隔离验证：嵌在外层 git 仓库里快照/恢复，外仓的 HEAD、refs、对象库纹丝不动。
// 运行：bun run tests/checkpoint_store.test.ts
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "../src/core/checkpoint_store";
import { SessionStore } from "../src/core/session_store";

let failures = 0;
function check(condition: boolean, label: string, detail?: unknown): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) {
    failures++;
    if (detail !== undefined) console.log("    实际:", detail);
  }
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

interface RawGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 测试自用的裸 git 调用（不经 CheckpointStore，用于布置外层仓库与交叉验证） */
function rawGit(args: string[], cwd?: string): Promise<RawGitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: Error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const TMP = path.join(os.tmpdir(), `ckpt-test-${process.pid}`);
const OUTER = path.join(TMP, "outer-repo"); // 外层 git 仓库（模拟项目根）
const SANDBOX = path.join(OUTER, "ws"); // 工作区：嵌在外层仓库里面（隔离的真正考验）
const SHADOW = path.join(OUTER, ".agent-sessions", "checkpoints", "s1"); // 影子仓库也放外层仓库里
const SESSION_DIR = path.join(TMP, "sessions");

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(SANDBOX, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(path.join(SANDBOX, rel));
    return true;
  } catch {
    return false;
  }
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(SANDBOX, rel), "utf-8");
}

async function main(): Promise<void> {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(SANDBOX, { recursive: true });

  // 外层仓库：一次提交后 HEAD 固定，之后的任何检查点操作都不得改变它
  await write("../outer-file.txt", "outer\n");
  await rawGit(["init", "-q"], OUTER);
  await rawGit(["add", "-A"], OUTER);
  const commit = await rawGit(["-c", "user.name=t", "-c", "user.email=t@t.local", "commit", "-q", "-m", "base"], OUTER);
  check(commit.code === 0, "外层仓库初始化提交成功", commit);
  const headBefore = (await rawGit(["rev-parse", "HEAD"], OUTER)).stdout.trim();
  const refsBefore = (await rawGit(["for-each-ref"], OUTER)).stdout;

  // 会话与检查点：records 回调接真实 SessionStore，和线上装配一致
  const sessionStore = new SessionStore({ dir: SESSION_DIR, sessionId: "ckpt" });
  const checkpoints = new CheckpointStore({
    shadowRoot: SHADOW,
    sandboxRoot: SANDBOX,
    sessionRecordCount: () => sessionStore.recordCount(),
  });

  // —— 第 1 轮：初始状态 ——
  await write("a.txt", "A1");
  await write("src/b.txt", "B1");
  await write("文件-中文.txt", "中");
  await checkpoints.snapshot("第一轮");
  await sessionStore.append({ role: "user", content: "第一轮" });

  // —— 第 2 轮：改 / 增 / 删，并带上 agent 自己写的 .gitignore ——
  await write("a.txt", "A2");
  await write("c.txt", "C");
  await write(".gitignore", "secret.txt\n");
  await write("secret.txt", "S");
  await fs.rm(path.join(SANDBOX, "src", "b.txt"));
  await write("文件-中文.txt", "中二");
  await checkpoints.snapshot("第二轮");
  await sessionStore.append({ role: "user", content: "第二轮" });

  // —— 第 3 轮：继续改动 ——
  await fs.rm(path.join(SANDBOX, "secret.txt"));
  await fs.rm(path.join(SANDBOX, "c.txt"));
  await write("d.txt", "D");
  await checkpoints.snapshot("第三轮");
  await sessionStore.append({ role: "user", content: "第三轮" });

  const list = await checkpoints.list();
  check(list.length === 3 && list[0]!.seq === 3 && list[2]!.seq === 1, "检查点列表最新在前", list.map((c) => c.seq));
  check(list[0]!.input === "第三轮" && list[0]!.records === 2, "检查点元信息（输入预览 + 会话边界）随快照保存", list[0]);
  check(
    list[1]!.records === 1 && list[2]!.records === 0,
    "records 记录的是本轮用户消息落盘之前的会话条数",
    list.map((c) => c.records)
  );

  // —— 隔离验证：影子仓库的提交对象只存在于影子 odb，外层仓库纹丝不动 ——
  const ckptSha = (await rawGit(["--git-dir", path.join(SHADOW, ".git"), "rev-parse", "refs/checkpoints/000001"])).stdout.trim();
  check(ckptSha.length === 40, "影子仓库里存在检查点提交", ckptSha);
  const leaked = await rawGit(["cat-file", "-e", `${ckptSha}^{commit}`], OUTER);
  check(leaked.code !== 0, "检查点对象没有漏进外层仓库的对象库", leaked);
  check((await rawGit(["rev-parse", "HEAD"], OUTER)).stdout.trim() === headBefore, "外层仓库 HEAD 未被改变");
  check((await rawGit(["for-each-ref"], OUTER)).stdout === refsBefore, "外层仓库 refs 未被改变");

  // —— 恢复语义：第 N 号检查点 = 第 N 轮开始之前的状态（本轮及之后的改动全部撤销）。
  // tree2 是第二轮改动之前拍的：回到它 = a=A2、c 与 secret 在、src/b 已删、d 不存在
  const backToTree2 = await checkpoints.restore("refs/checkpoints/000002");
  check(backToTree2.restored === 5, "恢复写回 5 个文件", backToTree2);
  check((await read("a.txt")) === "A2" && (await read("文件-中文.txt")) === "中二", "修改被回退到该时点", backToTree2);
  check((await exists("c.txt")) && (await exists("secret.txt")), "该时点之后被删的文件被找回（含被 .gitignore 忽略的）", backToTree2);
  check(!(await exists("d.txt")), "该时点之后新增的文件被删除", backToTree2);
  check(!(await exists("src/b.txt")) && !(await exists("src")), "该时点已删除的文件保持删除，空目录一并清掉", backToTree2);

  const backToTree1 = await checkpoints.restore("refs/checkpoints/000001");
  check(backToTree1.restored === 3 && backToTree1.deleted === 3, "恢复到第 1 号检查点：3 写回 3 删除", backToTree1);
  check((await read("a.txt")) === "A1" && (await read("src/b.txt")) === "B1" && (await read("文件-中文.txt")) === "中", "首轮内容与中文文件名正确还原", backToTree1);
  check(
    !(await exists("c.txt")) && !(await exists("secret.txt")) && !(await exists(".gitignore")),
    "后两轮新增的文件（含 .gitignore 本身）全部清除",
    backToTree1
  );

  // —— 超量裁剪：上限 2，两个无文件变化的新快照也各自成锚点 ——
  const capped = new CheckpointStore({
    shadowRoot: SHADOW,
    sandboxRoot: SANDBOX,
    sessionRecordCount: () => sessionStore.recordCount(),
    maxCheckpoints: 2,
  });
  await capped.snapshot("第四轮");
  await capped.snapshot("第五轮");
  const pruned = await checkpoints.list();
  check(pruned.length === 2 && pruned[0]!.seq === 5 && pruned[1]!.seq === 4, "超过上限裁掉最老的检查点", pruned.map((c) => c.seq));
  const gone = await rejects(checkpoints.restore("refs/checkpoints/000001"));
  check(gone instanceof Error, "被裁剪的检查点不可再恢复", gone);

  // —— 会话回滚：截断到检查点边界 ——
  check((await sessionStore.recordCount()) === 3, "会话现有 3 条记录", await sessionStore.readAll());
  await sessionStore.truncateTo(1);
  const remaining = await sessionStore.readAll();
  check(remaining.length === 1 && remaining[0]!.content === "第一轮", "truncateTo 只保留边界之前的记录", remaining);

  await fs.rm(TMP, { recursive: true, force: true });

  console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
  if (failures > 0) process.exitCode = 1;
}

main();
