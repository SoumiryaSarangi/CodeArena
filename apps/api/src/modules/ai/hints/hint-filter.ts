import type { HintLevel } from '@codearena/contracts';

export interface FilterResult {
  ok: boolean;
  /** Why it failed: `fenced-code`, `code-lines`, `inline-code`, or `avoid:<term>`. */
  reasons: string[];
}

const KEYWORD_LINE =
  /^\s*(for\s*\(|while\s*\(|if\s*\(|else\b|elif\b|return\b|def\s+\w+\s*\(|class\s+\w+|#include|import\s+\w|from\s+\w+\s+import|using\s+namespace|int\s+main|(?:int|long|double|string|bool|char|auto|var|let|const)\s+[\w[\]]+\s*(?:=|;|\()|vector\s*<|cout\b|cin\b|printf\s*\(|print\s*\(|System\.out)/;
const ASSIGNMENT = /^\s*[A-Za-z_]\w*(?:\[[^\]]*\])*\s*(?:[-+*/%|&^]|<<|>>)?=(?!=)\s*\S/;
const ENDS_LIKE_CODE = /[;{}]\s*$/;
const INDENTED_SYMBOLS = /^(?: {4}|\t)\s*\S.*[()[\]{};=]/;

/** A line that looks like source code rather than a sentence. */
export function isCodeLike(line: string): boolean {
  const t = line.trim();
  if (t.length < 2) return false;
  if (KEYWORD_LINE.test(line)) return true;
  if (ASSIGNMENT.test(line)) return true;
  if (ENDS_LIKE_CODE.test(t)) return true;
  return INDENTED_SYMBOLS.test(line);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Terms a hint of `level` must not use: every avoid-set entry for this level or a higher one (`avoidSet[n]` binds levels ≤ n). */
export function avoidTermsFor(avoidSet: Record<string, string[]>, level: HintLevel): string[] {
  return Object.entries(avoidSet)
    .filter(([n]) => level <= Number(n))
    .flatMap(([, terms]) => terms)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * SD-§12.2 step 6, FR-AI-03: the deterministic last line of defence, independent of any model. Rejects
 * fenced code, two or more consecutive code-like lines, an inline code span that is more than a name
 * (over 40 characters, or with `;` / `{`), and avoid-set terms for the level.
 */
export function filterHint(
  text: string,
  level: HintLevel,
  avoidSet: Record<string, string[]> = {},
): FilterResult {
  const reasons: string[] = [];
  if (/```|~~~/.test(text)) reasons.push('fenced-code');

  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (isCodeLike(lines[i - 1]!) && isCodeLike(lines[i]!)) {
      reasons.push('code-lines');
      break;
    }
  }

  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1]!;
    if (span.length > 40 || /[;{]/.test(span)) {
      reasons.push('inline-code');
      break;
    }
  }

  const lower = text.toLowerCase();
  for (const term of avoidTermsFor(avoidSet, level)) {
    const word = /^\w.*\w$|^\w$/.test(term);
    const re = word
      ? new RegExp(`(?<![\\w])${escapeRe(term.toLowerCase())}(?![\\w])`)
      : new RegExp(escapeRe(term.toLowerCase()));
    if (re.test(lower)) reasons.push(`avoid:${term}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Shown when every try at a real hint failed the filter: safe, honest, no solution content. */
export const GENERIC_HINTS: Record<HintLevel, string> = {
  1: 'Re-read the statement and name, in one sentence, what you are asked to compute. Then think about which kind of technique fits that goal (searching, sorting, counting, dynamic programming, graphs...) and what the limits allow.',
  2: 'Write down, in plain words, the steps your solution takes on a tiny example by hand. Check each step against the sample, and think about how the time grows as the input gets as large as the limits allow.',
  3: 'Pick the smallest input where your program gives the wrong answer (or write a tiny one yourself), trace it by hand next to what your code does, and find the first place they differ. Check the edge cases: smallest and largest values, duplicates, empty parts.',
};
