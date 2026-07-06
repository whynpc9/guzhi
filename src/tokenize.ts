const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : null;

const STOP_WORDS = new Set([
  "的",
  "了",
  "和",
  "或",
  "及",
  "请问",
  "一般",
  "情况下",
  "怎么",
  "如何",
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
]);

export function tokenize(input: string): string[] {
  const normalized = input.toLowerCase().normalize("NFKC");
  const tokens: string[] = [];
  if (segmenter) {
    for (const segment of segmenter.segment(normalized)) {
      const word = segment.segment.trim();
      if (!word) continue;
      pushToken(tokens, word);
    }
  } else {
    for (const word of normalized.split(/[^\p{L}\p{N}.]+/u)) {
      pushToken(tokens, word);
    }
  }
  return Array.from(new Set(tokens));
}

function pushToken(tokens: string[], word: string): void {
  const cleaned = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!cleaned) return;
  if (STOP_WORDS.has(cleaned)) return;
  if (/^\p{Script=Han}$/u.test(cleaned)) return;
  if (cleaned.length < 2 && /^\p{Script=Han}+$/u.test(cleaned)) return;
  tokens.push(cleaned);
}

export function countTokenOccurrences(haystack: string, tokens: string[]): number {
  const normalized = haystack.toLowerCase().normalize("NFKC");
  let score = 0;
  for (const token of tokens) {
    let index = normalized.indexOf(token);
    while (index >= 0) {
      score += 1;
      index = normalized.indexOf(token, index + token.length);
    }
  }
  return score;
}

export function estimateTokens(text: string, cjkCharPerToken: number): number {
  const asciiWords = text.match(/[A-Za-z0-9_./+-]+/g)?.length ?? 0;
  const cjkChars = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const nonCjkChars = text.replace(/\p{Script=Han}/gu, "").length;
  return Math.max(1, Math.ceil(asciiWords + cjkChars / cjkCharPerToken + nonCjkChars / 8));
}
