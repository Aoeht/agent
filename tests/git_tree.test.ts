// git_tree 工具回归：在真实临时 git 仓库上验证目录树渲染（.gitignore 过滤、中文文件名、
// depth 折叠、path 限定与越界拒绝）与 log 提交图（无提交的友好报错、limit 截断、非仓库报错）。
// 运行：bun run tests/git_tree.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitTreeTool, runGit } from "../src/tools/git_tree";

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

// 嵌套仓库放在外仓（本仓库）的 .sand-box 下：自己 git init 后自成一仓，互不影响。
// "非 git 仓库"的对照目录必须放到外仓之外（系统临时目录），否则 git 向上发现外仓 .git 就不会报错了
const ROOT = path.resolve(".sand-box/.tmp-git-tree-test");
const PLAIN = path.join(os.tmpdir(), "tmp-git-tree-plain");

interface TreeResult {
  mode: string;
  file_count: number;
  dir_count: number;
  truncated: boolean;
  text: string;
}
interface LogResult {
  mode: string;
  commit_count: number;
  text: string;
}

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function commitAll(message: string): Promise<void> {
  const add = await runGit(["add", "-A"], ROOT);
  if (add.code !== 0) throw new Error(`git add 失败: ${add.stderr}`);
  const commit = await runGit(["-c", "user.name=test", "-c", "user.email=test@test.local", "commit", "-q", "-m", message], ROOT);
  if (commit.code !== 0) throw new Error(`git commit 失败: ${commit.stderr}`);
}

async function main(): Promise<void> {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.rm(PLAIN, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(PLAIN, { recursive: true });
  const init = await runGit(["init", "-q"], ROOT);
  check(init.code === 0, "临时仓库 git init 成功", init);

  await write("README.md", "# demo\n");
  await write(".gitignore", "node_modules/\n");
  await write("src/core/agent.ts", "export {};\n");
  await write("src/index.ts", "console.log(1);\n");
  await write("docs/说明文档.md", "中文文件名\n");
  await write("node_modules/junk/index.js", "should be ignored\n");

  const tool = createGitTreeTool({ repoRoot: ROOT });

  // —— tree 模式（尚未提交：未跟踪但未忽略的文件也要出现）——
  const tree = (await tool.execute({ mode: "tree" })) as unknown as TreeResult;
  check(tree.file_count === 5, "列出 5 个有效文件（node_modules 被 .gitignore 过滤）", tree);
  check(tree.text.includes("src/") && tree.text.includes("core/") && tree.text.includes("agent.ts"), "目录树层级正确", tree.text);
  check(tree.text.includes("说明文档.md") && !/\\\d{3}/.test(tree.text), "中文文件名不被 quotepath 转义", tree.text);
  check(!tree.text.includes("node_modules"), "被忽略目录不出现", tree.text);

  const shallow = (await tool.execute({ mode: "tree", depth: 1 })) as unknown as TreeResult;
  check(shallow.text.includes("src/ …") && shallow.text.includes("docs/ …"), "depth=1 折叠深层目录", shallow.text);
  check(!shallow.text.includes("agent.ts"), "折叠后不出现深层文件", shallow.text);

  const scoped = (await tool.execute({ mode: "tree", path: "src" })) as unknown as TreeResult;
  check(scoped.file_count === 2 && scoped.text.includes("index.ts") && !scoped.text.includes("README.md"), "path 限定子目录", scoped);
  check(!scoped.text.includes("src/core"), "作用域路径前缀被剥掉（不重复套一层 src）", scoped.text);

  const escape = await rejects(tool.execute({ mode: "tree", path: "../outside" }));
  check(escape instanceof Error && escape.message.includes("越出仓库根"), "path 越界被拒绝", escape);

  // —— log 模式 ——
  const noCommit = await rejects(tool.execute({ mode: "log" }));
  check(noCommit instanceof Error && noCommit.message.includes("还没有任何提交"), "空仓库 log 给可行动的错误", noCommit);

  await commitAll("first commit");
  await write("CHANGELOG.md", "v1\n");
  await commitAll("second commit");

  const log = (await tool.execute({ mode: "log", limit: 5 })) as unknown as LogResult;
  check(log.commit_count === 2, "提交计数正确", log);
  check(log.text.includes("first commit") && log.text.includes("second commit"), "提交图包含两条提交", log.text);

  const limited = (await tool.execute({ mode: "log", limit: 1 })) as unknown as LogResult;
  check(limited.commit_count === 1 && limited.text.includes("second commit") && !limited.text.includes("first commit"), "limit 截断只保留最新", limited.text);

  // —— 非 git 仓库 ——
  const plainTool = createGitTreeTool({ repoRoot: PLAIN });
  const notRepo = await rejects(plainTool.execute({ mode: "tree" }));
  check(notRepo instanceof Error && notRepo.message.includes("不是 git 仓库"), "非 git 仓库给明确错误", notRepo);

  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.rm(PLAIN, { recursive: true, force: true });

  console.log(failures === 0 ? "\n🎉 全部通过" : `\n💥 ${failures} 项失败`);
  if (failures > 0) process.exitCode = 1;
}

main();
