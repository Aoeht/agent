// src/skills/loader.ts
/**
 * Agent Skill（SKILL.md 规范，背景见 docs/技能三层辨析.md 第 3/8/9 章）的发现与元数据加载。
 *
 * 职责边界：
 * - 只做「发现 + frontmatter 解析 + 附带文件清单」；正文按需由 load_skill 工具读取（渐进披露），
 *   本文件不读正文 —— 系统提示里只出现 name + description。
 * - skills-lock.json（bun run skill:add / skills CLI 写入）只当来源元数据读：实测其 computedHash
 *   与本机 SKILL.md 字节的 sha256 不符（安装器对本地副本做过改写，配方未核实），因此这里不做
 *   本地哈希校验，防篡改靠围栏：技能内容无论进提示还是进工具返回，一律套不可信数据围栏。
 *
 * 信任模型（技能三层辨析 8.2/8.4）：name/description 是第三方声明的数据，调用方必须把它当
 * 数据而非指令对待 —— 系统提示清单段与 load_skill 返回都走 core/untrusted.ts 的围栏。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** description 会整个进系统提示，超长直接拒绝该技能而不是截断（第三方内容不猜意图） */
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_NAME_CHARS = 64;
/** 附带文件清单上限：防止病态目录把清单撑爆 */
const MAX_FILES = 100;

/** 与 skills CLI 的默认安装位置一致；AGENT_SKILLS_DIR 可覆盖 */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

const FrontmatterSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_CHARS)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "name 只允许字母数字点下划线连字符"),
  description: z.string().trim().min(1).max(MAX_DESCRIPTION_CHARS),
});

export interface SkillManifest {
  name: string;
  description: string;
  /** 技能目录绝对路径（含 SKILL.md 与附带文件） */
  dir: string;
  /** 目录内附带文件（相对路径，不含 SKILL.md），模型按需用 load_skill(name, file) 读取 */
  files: string[];
  /** 安装来源（skills-lock.json 登记，如 "github:QianWen-AI/qianwen-ai"）；本机手放的技能没有 */
  source?: string;
}

export interface LoadSkillsResult {
  skills: SkillManifest[];
  /** 解析失败被跳过的目录与原因（坏技能不影响其它技能加载） */
  issues: { dir: string; error: string }[];
}

/** 最小 YAML 子集：BOM 容忍、CRLF 归一、`---` 围起来的 `key: value`（可带成对引号）。
 *  不支持块标量/嵌套/多行折叠 —— 官方规范字段都是单行标量，超出的行按普通 frontmatter 行忽略。 */
export function parseFrontmatter(raw: string): Record<string, string> | undefined {
  const content = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const data: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z_-]*):\s?(.*)$/);
    if (!match) continue;
    const value = match[2]!.trim();
    const unquoted = value.match(/^(["'])(.*)\1$/s);
    data[match[1]!] = unquoted ? unquoted[2]! : value;
  }
  return data;
}

/** 去掉 frontmatter，返回说明书正文（load_skill 的返回内容） */
export function stripFrontmatter(raw: string): string {
  const content = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return content;
  return content.slice(content.indexOf("\n", end + 1) + 1).trim();
}

/**
 * 扫描技能目录下的每个子目录，有 SKILL.md 的当技能解析。目录不存在安静返回空
 * （没装技能是正常状态，不是错误）；单个技能解析失败记入 issues，不影响其它技能。
 */
export async function loadSkills(options: { dir?: string } = {}): Promise<LoadSkillsResult> {
  const root = path.resolve(options.dir ?? DEFAULT_SKILLS_DIR);
  const result: LoadSkillsResult = { skills: [], issues: [] };
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return result;

  const lock = await readSkillLock(root);
  const seen = new Set<string>();
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, entry.name);
    const raw = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8").catch(() => undefined);
    if (raw === undefined) continue; // 没有 SKILL.md 的子目录不是技能（杂物/缓存），跳过
    try {
      const fields = FrontmatterSchema.parse(parseFrontmatter(raw) ?? {});
      if (seen.has(fields.name)) throw new Error(`技能名与其它目录重复：${fields.name}`);
      seen.add(fields.name);
      const source = lock.get(fields.name);
      result.skills.push({
        name: fields.name,
        description: fields.description,
        dir,
        files: await listFiles(dir),
        ...(source !== undefined ? { source } : {}),
      });
    } catch (error) {
      result.issues.push({ dir, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** skills-lock.json 的 name → 展示用来源串（"github:owner/repo"）；找不到锁文件返回空 Map */
async function readSkillLock(skillsDir: string): Promise<Map<string, string>> {
  const candidates = [
    path.join(skillsDir, "skills-lock.json"),
    path.join(path.dirname(skillsDir), "skills-lock.json"),
    path.resolve("skills-lock.json"),
  ];
  for (const file of candidates) {
    const raw = await fs.readFile(file, "utf-8").catch(() => undefined);
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as { skills?: Record<string, { source?: string; sourceType?: string }> };
      const lock = new Map<string, string>();
      for (const [name, meta] of Object.entries(parsed.skills ?? {})) {
        if (typeof meta.source === "string" && meta.source) {
          lock.set(name, `${meta.sourceType ?? "source"}:${meta.source}`);
        }
      }
      return lock;
    } catch {
      continue; // 锁文件坏了当没有来源，不影响技能本身
    }
  }
  return new Map();
}

/** 附带文件清单：递归、跳过隐藏目录与 node_modules、跳过 SKILL.md 本身（正文单独读）、超上限即停 */
async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name !== "SKILL.md") {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}
