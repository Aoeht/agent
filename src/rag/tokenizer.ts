// src/rag/tokenizer.ts
/**
 * 中英混合分词：Intl.Segmenter 负责词边界，再给连续汉字补一层字二元组。
 * Segmenter 对专有名词常切偏（如"客服"→"客|服"），二元组保证这种情况仍能对上。
 */
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;

const STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "及", "或", "有", "被", "把", "对", "等", "吗", "呢", "啊", "这", "那",
  "the", "a", "an", "of", "to", "in", "and", "or", "is", "are", "was", "for", "on", "with", "by", "as", "at",
]);

export function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];

  for (const { segment, isWordLike } of segmenter.segment(normalized)) {
    if (!isWordLike || STOPWORDS.has(segment)) continue;
    // 单个汉字区分度太低，交给下面的二元组覆盖
    if (HAN.test(segment) && [...segment].length < 2) continue;
    tokens.push(segment);
  }

  for (const run of normalized.match(HAN_RUN) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      tokens.push(chars[i]! + chars[i + 1]!);
    }
  }

  return tokens;
}
