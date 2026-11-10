import { createHash } from "node:crypto";

/** Bound the exact serialized tool result using the same estimator as Agent's output guard. */
export function evidencePage(evidence: Record<string, unknown>, cursor: string | undefined,
  maxTokens: number, countTokens: (text: string) => number): string {
  const raw = JSON.stringify(evidence);
  if (!cursor && countTokens(raw) <= maxTokens) return raw;
  let version = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const match = cursor?.match(/^([a-f0-9]{16}):(\d+)$/);
  const start = match ? Number(match[2]) : 0;
  type Item = { path: (string | number)[]; value: unknown; offset?: number; continued?: boolean };
  const items: Item[] = [];
  const envelope = (values: Item[], next: number | null) => JSON.stringify({
    bvid: evidence.bvid, format: "evidence_pages/v1", items: values,
    next_cursor: next === null ? null : `${version}:${next}`,
  });
  const fits = (values: Item[]) => countTokens(envelope(values, Number.MAX_SAFE_INTEGER)) <= maxTokens;
  const add = (value: unknown, path: Item["path"]) => {
    if (fits([{ path, value }])) { items.push({ path, value }); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => add(item, [...path, index])); return; }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => add(item, [...path, key])); return;
    }
    if (typeof value !== "string") throw new Error("工具输出预算过小，无法容纳证据字段");
    // Oversized strings retain exact text with explicit offsets; never silently truncate a node.
    for (let offset = 0; offset < value.length;) {
      let low = 0, high = value.length - offset;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits([{ path, value: value.slice(offset, offset + mid), offset, continued: true }])) low = mid;
        else high = mid - 1;
      }
      // Prefer a complete tree-node boundary; only a single oversized node is fragmented.
      if (path[0] === "comment_threads" && offset + low < value.length) {
        const boundaries = [...value.slice(offset, offset + low).matchAll(/\n  (?:├|│|\?)/g)];
        const boundary = boundaries.at(-1)?.index;
        if (boundary && boundary > 0) low = boundary;
      }
      if (!low) throw new Error("工具输出预算过小，无法容纳证据片段");
      items.push({ path, value: value.slice(offset, offset + low), offset, continued: offset + low < value.length });
      offset += low;
    }
  };
  Object.entries(evidence).forEach(([key, value]) => add(value, [key]));
  // Also bind the cursor to page layout: changing model/budget must not skip evidence.
  version = createHash("sha256").update(JSON.stringify({ maxTokens, items })).digest("hex").slice(0, 16);
  if (cursor && (!match || match[1] !== version)) throw new Error("证据快照已变化或 cursor 无效，请从第一页重新读取");
  if (!Number.isSafeInteger(start) || start >= items.length) throw new Error("cursor 超出证据范围");
  const page: Item[] = [];
  let next = start;
  while (next < items.length && fits([...page, items[next]!])) page.push(items[next++]!);
  if (!page.length) throw new Error("工具输出预算过小");
  return envelope(page, next < items.length ? next : null);
}
