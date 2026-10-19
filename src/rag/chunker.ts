// src/rag/chunker.ts
export interface ChunkOptions {
  maxChars?: number;
  /** 相邻块之间按整句回带的重叠长度上限 */
  overlapChars?: number;
}

// 控制字符会混进网页抓取结果，保留 \t \n
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(text: string, maxChars: number): string[] {
  const sentences: string[] = [];
  for (const piece of text.split(/(?<=[。！？!?；;\n])|(?<=\.\s)/)) {
    if (!piece) continue;
    for (let i = 0; i < piece.length; i += maxChars) {
      sentences.push(piece.slice(i, i + maxChars));
    }
  }
  return sentences;
}

/** 按句子装箱成不超过 maxChars 的块，块尾若干整句回带到下一块开头作为重叠 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxChars = options.maxChars ?? 500;
  const overlapChars = Math.min(options.overlapChars ?? 80, Math.floor(maxChars / 2));
  const clean = normalizeText(text);
  if (!clean) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const sentence of splitSentences(clean, maxChars)) {
    if (length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.join("").trim());

      const carry: string[] = [];
      let carryLength = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const s = current[i]!;
        if (carryLength + s.length > overlapChars) break;
        carry.unshift(s);
        carryLength += s.length;
      }
      current = carry;
      length = carryLength;
      while (current.length > 0 && length + sentence.length > maxChars) {
        length -= current.shift()!.length;
      }
    }
    current.push(sentence);
    length += sentence.length;
  }
  if (current.length > 0) chunks.push(current.join("").trim());

  return chunks.filter((chunk) => chunk.length > 0);
}
