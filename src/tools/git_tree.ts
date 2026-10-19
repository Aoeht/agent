// src/tools/git_tree.ts
/**
 * git 仓库结构工具：给模型一个"项目长什么样"的只读入口。
 * - mode=tree：把 git 跟踪 + 未被 .gitignore 忽略的未跟踪文件渲染成目录树（repo map），
 *   可用 path 限定子目录、depth 限制展开深度；
 * - mode=log：渲染最近的提交图（哈希 · 日期 · 作者 · 说明）。
 *
 * 边界与取舍：
 * - 只读：只有 ls-files / log 两条查询命令，不经 shell（spawn 参数逐个传递），
 *   无副作用所以免人工确认，可与同批只读工具并发（parallelSafe）；
 * - 体积双顶：git 输出收集端截断防内存失控，回给模型的 text 按行数/字符数封顶并标 truncated，
 *   与 MCP maxResultChars 同量级，大仓库不会撑爆上下文；
 * - path 只接受仓库根内的相对路径，越界直接拒绝（与 run_script 的路径守卫同一思路）；
 * - 中文文件名：git 默认按 core.quotepath 把非 ASCII 路径转义成八进制，这里显式关闭并
 *   强制 UTF-8 输出，Windows 中文环境的仓库树才不会变成 \346\226\207 乱码。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { ToolDefinition, defineTool } from "../core/types";

const GIT_TIMEOUT_MS = 15_000;
const GIT_OUTPUT_CAP = 200_000; // stdout/stderr 收集上限，防异常大输出拖垮内存
const MAX_TREE_ENTRIES = 3_000; // 目录树渲染行数上限
const MAX_TEXT_CHARS = 20_000; // 回给模型的 text 上限（与 MCP maxResultChars 同量级）

const GitTreeParamsSchema = z.object({
  mode: z.enum(["tree", "log"]).default("tree").describe("tree=目录树（默认），log=最近提交图"),
  path: z
    .string()
    .trim()
    .optional()
    .describe("tree 模式限定子目录：仓库根内的相对路径（如 src/core），缺省展示整仓"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("tree 模式最大展开深度（1=只看顶层，更深的目录折叠为 name/ …），缺省全部展开"),
  limit: z.number().int().min(1).max(100).default(20).describe("log 模式显示的提交条数（默认 20）"),
});

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑一条 git 查询命令：不经 shell，参数逐个传递；超时或取消即杀进程（导出供测试复用） */
export function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-c", "core.quotepath=off", "-c", "i18n.logoutputencoding=utf-8", ...args],
      { cwd, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < GIT_OUTPUT_CAP) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < GIT_OUTPUT_CAP) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    signal?.addEventListener("abort", () => child.kill(), { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** 把非零退出的 git 调用转成可行动的错误信息；"不是仓库"给专门文案 */
function gitError(command: string, result: GitResult, dir: string): Error {
  if (/not a git repository/i.test(result.stderr)) {
    return new Error(`目录不是 git 仓库（没有 .git）：${dir}`);
  }
  const firstLine = result.stderr.trim().split("\n")[0] ?? "";
  return new Error(`git ${command} 失败（退出码 ${result.code}）：${firstLine || "无错误输出"}`);
}

// —— 目录树构建与渲染：扁平路径列表 → 嵌套目录 → box-drawing 树 ——

interface DirNode {
  dirs: Map<string, DirNode>;
  files: Set<string>;
}

function buildTree(paths: string[]): DirNode {
  const root: DirNode = { dirs: new Map(), files: new Set() };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let child = node.dirs.get(dir);
      if (child === undefined) {
        child = { dirs: new Map(), files: new Set() };
        node.dirs.set(dir, child);
      }
      node = child;
    }
    node.files.add(parts[parts.length - 1]!);
  }
  return root;
}

interface RenderStats {
  dirs: number;
  truncated: boolean;
}

const byName = (a: string, b: string) => a.localeCompare(b);

function renderDir(
  node: DirNode,
  prefix: string,
  depth: number,
  maxDepth: number | undefined,
  lines: string[],
  stats: RenderStats
): void {
  if (stats.truncated) return;
  const dirs = [...node.dirs.keys()].sort(byName);
  const files = [...node.files].sort(byName);
  const total = dirs.length + files.length;
  for (let i = 0; i < total; i++) {
    if (lines.length >= MAX_TREE_ENTRIES) {
      stats.truncated = true;
      return;
    }
    const isDir = i < dirs.length;
    const name = isDir ? dirs[i]! : files[i - dirs.length]!;
    const branch = i === total - 1 ? "└── " : "├── ";
    if (!isDir) {
      lines.push(prefix + branch + name);
      continue;
    }
    const collapse = maxDepth !== undefined && depth >= maxDepth;
    lines.push(prefix + branch + name + "/" + (collapse ? " …" : ""));
    stats.dirs++;
    if (!collapse) {
      renderDir(node.dirs.get(name)!, prefix + (i === total - 1 ? "    " : "│   "), depth + 1, maxDepth, lines, stats);
    }
  }
}

export function createGitTreeTool(options: { repoRoot?: string } = {}): ToolDefinition {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());

  return defineTool({
    name: "git_tree",
    schema: GitTreeParamsSchema,
    parallelSafe: true,
    description:
      "查看当前项目的 git 仓库结构或提交历史（只读，无需确认）。" +
      "mode=tree（默认）：渲染目录树，包含 git 已跟踪与未被 .gitignore 忽略的未跟踪文件；path 限定子目录，depth 限制展开深度。" +
      "mode=log：显示最近提交图（哈希 日期 作者 说明），limit 控制条数（默认 20）。" +
      "回答「项目结构 / 有哪些文件 / 最近改了什么」类问题前先用它建立全景再决定读哪些文件；输出过大时用 path/depth/limit 收窄范围。",
    execute: async (params, runtime) => {
      if (params.mode === "log") {
        const logged = await runGit(
          ["log", "--graph", "--date=short", "--pretty=format:%h %ad %an %s", "-n", String(params.limit)],
          repoRoot,
          runtime?.signal
        );
        if (logged.code !== 0) {
          if (/does not have any commits yet/i.test(logged.stderr)) {
            throw new Error("仓库还没有任何提交，log 模式无内容可显示（可用 mode=tree 先看文件结构）");
          }
          throw gitError("log", logged, repoRoot);
        }
        const commitCount = logged.stdout.split("\n").filter((line) => /^\s*\*/.test(line)).length;
        let text = logged.stdout.trim();
        const truncated = text.length > MAX_TEXT_CHARS;
        if (truncated) text = text.slice(0, MAX_TEXT_CHARS) + "\n…（输出过长被截断，请调小 limit）";
        return { mode: "log", root: repoRoot, commit_count: commitCount, truncated, text };
      }

      // tree 模式：路径守卫 → ls-files（跟踪 + 未忽略未跟踪，NUL 分隔防文件名含空格）→ 渲染
      let scopeRel: string | undefined;
      if (params.path !== undefined && params.path !== "" && params.path !== ".") {
        const abs = path.resolve(repoRoot, params.path);
        if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) {
          throw new Error(`path 越出仓库根：${params.path}`);
        }
        scopeRel = path.relative(repoRoot, abs).split(path.sep).join("/") || undefined;
      }
      const lsArgs = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
      if (scopeRel !== undefined) lsArgs.push("--", scopeRel);
      const listed = await runGit(lsArgs, repoRoot, runtime?.signal);
      if (listed.code !== 0) throw gitError("ls-files", listed, repoRoot);

      // ls-files 的路径始终相对仓库根：限定子目录时剥掉 scope 前缀，树从该目录自身画起
      const scopePrefix = scopeRel !== undefined ? `${scopeRel}/` : "";
      const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))]
        .filter((p) => scopePrefix === "" || p.startsWith(scopePrefix))
        .map((p) => (scopePrefix === "" ? p : p.slice(scopePrefix.length)));
      const header = scopeRel !== undefined ? `${scopeRel}/` : `${path.basename(repoRoot)}/`;
      if (paths.length === 0) {
        return {
          mode: "tree",
          root: repoRoot,
          ...(scopeRel !== undefined ? { scope: scopeRel } : {}),
          file_count: 0,
          dir_count: 0,
          truncated: false,
          text: `${header}\n（没有可展示的文件：该范围内没有 git 跟踪或未忽略的文件）`,
        };
      }
      paths.sort(byName);
      const lines: string[] = [header];
      const stats: RenderStats = { dirs: 0, truncated: false };
      renderDir(buildTree(paths), "", 1, params.depth, lines, stats);
      if (stats.truncated) lines.push(`…（已达 ${MAX_TREE_ENTRIES} 行渲染上限，请用 path/depth 收窄范围）`);
      let text = lines.join("\n");
      const textTruncated = text.length > MAX_TEXT_CHARS;
      if (textTruncated) text = text.slice(0, MAX_TEXT_CHARS) + "\n…（输出过长被截断，请用 path/depth 收窄范围）";
      return {
        mode: "tree",
        root: repoRoot,
        ...(scopeRel !== undefined ? { scope: scopeRel } : {}),
        file_count: paths.length,
        dir_count: stats.dirs,
        truncated: stats.truncated || textTruncated,
        text,
      };
    },
  });
}
