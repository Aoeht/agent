import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AcceptanceCriterion, Verification } from "./task_types";

const MAX_BYTES = 5_000_000;
const protectedPart = /^(\.env(?:\..*)?|\.git|\.aws|\.codex|\.agents|\.ssh)$/i;
export function validateAcceptancePaths(root: string, criteria: AcceptanceCriterion[]): void {
  for (const criterion of criteria) {
    const relative = criterion.path.replace(/\\/g, "/");
    if (path.isAbsolute(relative) || relative.includes(":") || relative.split("/").some(p =>
      p === ".." || protectedPart.test(p) || p !== p.trim() || (p !== "." && p.endsWith(".")))) {
      throw new Error("验收只允许工作区内的普通相对文件路径，不能读取凭据或受保护目录");
    }
    const resolved = path.relative(path.resolve(root), path.resolve(root, relative));
    if (!resolved || resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error("验收路径超出工作区");
  }
}

/** Runs outside the model loop. Checks real files and records hashes, never trusting
 * the model's completion claim or a tool's self-reported success. */
export async function verifyTask(root: string, criteria: AcceptanceCriterion[], signal?: AbortSignal): Promise<Verification> {
  if (!criteria.length) return { status: "not_configured", checks: [] };
  const checks: Verification["checks"] = [];
  for (const criterion of criteria) {
    try {
      signal?.throwIfAborted();
      validateAcceptancePaths(root, [criterion]);
      const realRoot = await fs.realpath(root);
      const filename = path.resolve(root, criterion.path);
      // Reject symlinks/junctions at every path component, not just the leaf.
      let current = path.resolve(root);
      for (const component of path.relative(current, filename).split(path.sep)) {
        current = path.join(current, component);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("验收路径不能经过符号链接");
      }
      const realFile = await fs.realpath(filename);
      const relative = path.relative(realRoot, realFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("验收路径超出工作区");
      validateAcceptancePaths(realRoot, [{ ...criterion, path: relative }]);
      const handle = await fs.open(realFile, "r");
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("只支持不超过 5 MB 的普通文件");
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          signal?.throwIfAborted();
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > MAX_BYTES) throw new Error("文件超出验收大小限制");
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      signal?.throwIfAborted();
      const digest = createHash("sha256").update(bytes).digest("hex");
      let passed = false;
      if (criterion.kind === "file_exists") passed = bytes.length >= criterion.minBytes;
      if (criterion.kind === "text_contains") passed = bytes.toString("utf8").includes(criterion.text);
      if (criterion.kind === "sha256") passed = digest === criterion.digest.toLowerCase();
      if (criterion.kind === "json_equals") {
        let value: unknown = JSON.parse(bytes.toString("utf8"));
        for (const key of criterion.keys) {
          if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("JSON 字段不存在");
          value = (value as Record<string, unknown>)[key];
        }
        passed = isDeepStrictEqual(value, criterion.expected);
      }
      checks.push({ description: criterion.description, path: criterion.path, passed,
        detail: passed ? "文件实测符合条件" : "文件实测不符合条件", sha256: digest });
    } catch (error) {
      checks.push({ description: criterion.description, path: criterion.path, passed: false,
        detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { status: checks.every(c => c.passed) ? "passed" : "failed", checkedAt: new Date().toISOString(), checks };
}
