import { createHash } from "node:crypto";
import { chunkText, normalizeText } from "../rag/chunker";

export interface MemoryChunk {
  chunkId: string;
  sessionId: string;
  section: string;
  text: string;
}

/** 按 Markdown 章节切开，再按整句分块。ID 基于内容，前面插入章节不会使未变块的缓存失效。 */
export function chunkMemorySummary(sessionId: string, summary: string, maxChars = 500): MemoryChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 32) throw new Error("chunkChars 必须为至少 32 的整数");
  const chunks: MemoryChunk[] = [];
  const seen = new Set<string>();
  let section = "摘要";
  let lines: string[] = [];
  const flush = () => {
    // 预留固定尾部重叠：只回带整句会在超长无标点句子中失效，把编号/事实切成两半。
    const overlap = Math.min(80, Math.floor(maxChars / 4));
    const source = normalizeText(lines.join("\n"));
    const parts = chunkText(source, { maxChars: maxChars - overlap, overlapChars: 0 });
    let cursor = 0;
    for (const part of parts) {
      const start = source.indexOf(part, cursor);
      const end = start + part.length;
      // 从原文取重叠，不在硬切开的词中间插入分隔符。
      const text = source.slice(Math.max(0, start - overlap), end);
      cursor = end;
      const digest = createHash("sha256").update(`${section}\0${text}`).digest("hex").slice(0, 20);
      const chunkId = `${sessionId}:${digest}`;
      if (seen.has(chunkId)) continue;
      seen.add(chunkId);
      chunks.push({ chunkId, sessionId, section, text });
    }
    lines = [];
  };
  for (const line of normalizeText(summary).split("\n")) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      section = heading[1]!.trim().slice(0, 120);
    } else lines.push(line);
  }
  flush();
  return chunks;
}
