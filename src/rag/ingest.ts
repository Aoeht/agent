// src/rag/ingest.ts
import fs from "node:fs/promises";
import path from "node:path";
import { KnowledgeStoreApi } from "./knowledge_store";
import { createKnowledgeStore } from "./store_factory";
import { closePgPools } from "./pg_store";

/** 支持的内部资料类型：纯文本与 Markdown（不含 .json，那是缓存自身格式） */
export const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt"];

const FRONT_MATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*$/;
const FENCE = /^ {0,3}(```|~~~)/;

export interface MarkdownSection {
  /** 章节标题路径，如 "平台规则 / 退款诈骗"；无标题文件用文件名兜底 */
  title: string;
  body: string;
}

/**
 * 按标题层级切分 Markdown，每段带上完整的标题面包屑，让"退款"这种窄查询也能定位到具体小节。
 * 代码块内的 # 不当标题处理；未闭合的围栏按普通正文对待。
 */
export function splitMarkdown(text: string, fallbackTitle: string): MarkdownSection[] {
  const content = text.replace(FRONT_MATTER, "");
  const sections: MarkdownSection[] = [];
  const stack: { level: number; title: string }[] = [];
  let buffer: string[] = [];
  let fence: string | undefined;

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) sections.push({ title: stack.length > 0 ? stack.map((s) => s.title).join(" / ") : fallbackTitle, body });
    buffer = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      if (fence === undefined) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = undefined;
    } else if (fence === undefined) {
      const heading = line.match(HEADING);
      if (heading) {
        flush();
        const level = heading[1]!.length;
        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
        stack.push({ level, title: heading[2]!.trim() });
        continue;
      }
    }
    buffer.push(line);
  }
  flush();

  if (sections.length === 0) {
    const body = content.trim();
    return body ? [{ title: fallbackTitle, body }] : [];
  }
  return sections;
}

/** 同一文件的同标题章节指向同一 source，重复导入即覆盖；标题变更则视为新章节 */
export function internalSource(fileKey: string, title: string, fallbackTitle: string): string {
  const base = `internal://${fileKey}`;
  return !title || title === fallbackTitle ? base : `${base}#${title.replace(/#/g, "%23")}`;
}

export interface CollectedSection extends MarkdownSection {
  source: string;
  file: string;
}

async function* walk(target: string): AsyncGenerator<string> {
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) yield full;
  }
}

export interface CollectOptions {
  /** source 里使用的相对路径基准，默认进程工作目录 */
  rootDir?: string;
}

/** 读取文件并切分成待入库的片段；不支持的类型与读取失败归入 issues，不影响其它文件入库 */
export async function collectSections(inputs: string[], options: CollectOptions = {}): Promise<{
  sections: CollectedSection[];
  issues: { file: string; error: string }[];
}> {
  const root = options.rootDir ?? process.cwd();
  const files: string[] = [];
  const issues: { file: string; error: string }[] = [];

  for (const input of inputs) {
    try {
      for await (const file of walk(input)) files.push(file);
    } catch (error) {
      issues.push({ file: input, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const sections: CollectedSection[] = [];
  for (const file of files.sort()) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      issues.push({ file, error: `不支持的文件类型 ${ext || "(无扩展名)"}` });
      continue;
    }
    const rel = path.relative(root, file).split(path.sep).join("/");
    const fallbackTitle = path.basename(file, ext);
    try {
      const text = await fs.readFile(file, "utf-8");
      for (const section of splitMarkdown(text, fallbackTitle)) {
        if (!section.body.trim()) continue;
        sections.push({ ...section, file, source: internalSource(rel, section.title, fallbackTitle) });
      }
    } catch (error) {
      issues.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { sections, issues };
}

export interface IngestOptions {
  store: KnowledgeStoreApi;
  rootDir?: string;
  /** 只统计不写盘 */
  dryRun?: boolean;
  /** 同步模式：删除本次扫描范围内（按文件路径前缀）不再存在的 internal 孤儿章节 */
  sync?: boolean;
}

export interface IngestReport {
  files: number;
  sections: number;
  added: number;
  updated: number;
  unchanged: number;
  /** sync 模式清理掉的孤儿章节，含标题与所属文件，便于展示 */
  removed: { source: string; title?: string; file?: string }[];
  truncated: { file: string; title: string; chars: number }[];
  issues: { file: string; error: string }[];
  dryRun: boolean;
}

/** sync 的删除范围：每个成功遍历到的目标都贡献一个 internal://<相对路径> 前缀；路径读取失败则不贡献，避免误删 */
async function collectSyncPrefixes(inputs: string[], root: string): Promise<string[]> {
  const prefixes: string[] = [];
  for (const input of inputs) {
    try {
      // walk 会 stat 目标；目录即使没有合法文件也贡献前缀（其旧章节应被清理）
      let any = false;
      for await (const file of walk(input)) {
        const rel = path.relative(root, file).split(path.sep).join("/");
        prefixes.push(`internal://${rel}`);
        any = true;
      }
      if (!any) prefixes.push(`internal://${path.relative(root, input).split(path.sep).join("/")}`);
    } catch {
      // 交给 collectSections 记 issue，这里只跳过前缀
    }
  }
  return [...new Set(prefixes)];
}

/** 把本地 Markdown/txt 以 trust=internal 写入知识缓存：不受 web TTL 过期影响，也不会在联网补充时被覆盖 */
export async function ingestPaths(inputs: string[], options: IngestOptions): Promise<IngestReport> {
  const { store, dryRun = false, sync = false } = options;
  const { sections, issues } = await collectSections(inputs, options);

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const truncated: IngestReport["truncated"] = [];

  for (const section of sections) {
    const id = store.docId(section.source);
    const existing = await store.get(id);
    if (existing) {
      if (existing.contentHash === store.fingerprint(section.body)) unchanged++;
      else updated++;
    } else {
      added++;
    }

    if (section.body.length > store.maxContentChars) {
      truncated.push({ file: section.file, title: section.title, chars: section.body.length });
    }
  }

  let removed: IngestReport["removed"] = [];
  if (!dryRun && sections.length > 0) {
    await store.upsert(
      sections.map((section) => ({
        source: section.source,
        title: section.title,
        content: section.body,
        trust: "internal" as const,
      }))
    );
  }

  if (sync) {
    const root = options.rootDir ?? process.cwd();
    const prefixes = await collectSyncPrefixes(inputs, root);
    const keepIds = new Set(sections.map((section) => store.docId(section.source)));
    const staleDocs = (await store.list()).filter(
      (doc) => doc.trust === "internal" && !keepIds.has(doc.id) && prefixes.some((prefix) => doc.source.startsWith(prefix))
    );
    if (!dryRun) await store.pruneInternal(prefixes, keepIds);
    removed = staleDocs.map((doc) => ({ source: doc.source, ...(doc.title ? { title: doc.title } : {}) }));
  }

  return {
    files: new Set(sections.map((s) => s.file)).size,
    sections: sections.length,
    added,
    updated,
    unchanged,
    removed,
    truncated,
    issues,
    dryRun,
  };
}

const USAGE = `用法：bun src/rag/ingest.ts [--dry-run] [--sync] <文件或目录> [...]
  --dry-run / -n   只扫描并统计，不写入缓存
  --sync / -s      同步模式：删除本次扫描范围内已不存在的 internal 章节（改名/删除的文件留下的孤儿）
示例：bun src/rag/ingest.ts --sync docs/平台规则/
后端由 RAG_PG_URL 决定：配置了写 PostgreSQL（schema 见 RAG_PG_SCHEMA），否则写 .rag-cache/knowledge.json。`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");
  const sync = argv.includes("--sync") || argv.includes("-s");
  const targets = argv.filter((a) => !a.startsWith("-"));

  if (targets.length === 0) {
    console.log(USAGE);
    process.exit(1);
  }

  const store = createKnowledgeStore();
  try {
    const report = await ingestPaths(targets, { store, ...(dryRun ? { dryRun: true } : {}), ...(sync ? { sync: true } : {}) });

    console.log(
      `${report.dryRun ? "🔍 [dry-run] " : "📥 "}扫描 ${report.files} 个文件 / ${report.sections} 个片段：新增 ${report.added}、更新 ${report.updated}、未变 ${report.unchanged}${report.removed.length > 0 ? `、清理孤儿 ${report.removed.length}` : ""}`
    );
    if (!report.dryRun && report.sections > 0) console.log(`   已写入 ${store.filePath}`);
    for (const item of report.removed) {
      console.warn(`🗑️  ${report.dryRun ? "[dry-run] 将删除" : "已删除"}孤儿章节：${item.title ?? item.source}`);
    }
    for (const item of report.truncated) {
      console.warn(`⚠️  超长截断（${store.maxContentChars} 字符）：${item.file} → ${item.title}（实际 ${item.chars} 字符），建议拆分该章节`);
    }
    for (const issue of report.issues) {
      console.warn(`⚠️  跳过 ${issue.file}: ${issue.error}`);
    }
  } finally {
    // PG 后端持有连接池，不关进程不退出；JSON 后端这是空操作
    await closePgPools();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
