/**
 * IN-01 (SD-§14): what the server derives from code. Advisory only; nothing here changes a score.
 */

const KEYWORDS = new Set(
  (
    'if else for while do switch case break continue return int long short char float double void bool auto const static ' +
    'struct class public private new delete try catch throw def import from as in not and or is None True False lambda ' +
    'pass with yield elif except finally global print include using namespace template typename std vector string map set ' +
    'function var let async await null true false this super extends implements final'
  ).split(' '),
);

const bucket = (n: number, edges: number[]) => {
  let i = 0;
  while (i < edges.length && n > edges[i]!) i++;
  return i;
};

/**
 * The shape of how someone writes, as a bag of features: keywords, punctuation, identifier length classes, number and
 * string literals, indentation of each line, line length classes, comment markers. Names themselves are not kept, only
 * their length class, so the same style on another problem looks alike.
 */
export function styleFeatures(source: string): Map<string, number> {
  const f = new Map<string, number>();
  const add = (k: string) => f.set(k, (f.get(k) ?? 0) + 1);
  for (const line of source.split('\n')) {
    if (line.trim() === '') continue;
    const indent = /^[ \t]*/.exec(line)![0];
    add(`indent:${indent.includes('\t') ? 'tab' : Math.min(indent.length, 16)}`);
    add(`line:${bucket(line.length, [20, 40, 60, 80, 100])}`);
    if (/(^|\s)(\/\/|#)/.test(line)) add('comment');
  }
  const tokens =
    source.match(/[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'|[^\sA-Za-z_0-9]/g) ?? [];
  for (const t of tokens) {
    if (/^[A-Za-z_]/.test(t)) {
      add(
        KEYWORDS.has(t)
          ? `kw:${t}`
          : `id:${bucket(t.length, [1, 2, 4, 7, 12])}${t.includes('_') ? 'u' : /[a-z][A-Z]/.test(t) ? 'c' : ''}`,
      );
    } else if (/^\d/.test(t)) add('num');
    else if (t[0] === '"' || t[0] === "'") add('str');
    else add(`p:${t}`);
  }
  return f;
}

const normalise = (f: Map<string, number>) => {
  let total = 0;
  for (const v of f.values()) total += v;
  const out = new Map<string, number>();
  if (total === 0) return out;
  for (const [k, v] of f) out.set(k, v / total);
  return out;
};

/** Jensen-Shannon divergence in bits: 0 = the same distribution, 1 = nothing in common. */
export function jensenShannon(a: Map<string, number>, b: Map<string, number>): number {
  const p = normalise(a);
  const q = normalise(b);
  let d = 0;
  for (const k of new Set([...p.keys(), ...q.keys()])) {
    const x = p.get(k) ?? 0;
    const y = q.get(k) ?? 0;
    const m = (x + y) / 2;
    if (x > 0) d += 0.5 * x * Math.log2(x / m);
    if (y > 0) d += 0.5 * y * Math.log2(y / m);
  }
  return Math.min(1, Math.max(0, d));
}

/** Programs shorter than this say too little about a style. */
export const MIN_STYLE_CHARS = 120;
export const MIN_HISTORY = 3;

/**
 * Style shift of `current` against the person's own earlier programs (same language): the JS divergence between its
 * feature distribution and the pooled one of the history. `null` with fewer than 3 usable earlier programs.
 */
export function styleShift(current: string, history: string[]): number | null {
  if (current.length < MIN_STYLE_CHARS) return null;
  const usable = history.filter((h) => h.length >= MIN_STYLE_CHARS);
  if (usable.length < MIN_HISTORY) return null;
  const pooled = new Map<string, number>();
  for (const h of usable) {
    for (const [k, v] of normalise(styleFeatures(h))) pooled.set(k, (pooled.get(k) ?? 0) + v);
  }
  return jensenShannon(styleFeatures(current), pooled);
}

/** Whole minutes from first opening the problem to the first accepted submission; null if either is missing. */
export function timeToAcMinutes(openedAt: Date | null, firstAcAt: Date | null): number | null {
  if (!openedAt || !firstAcAt) return null;
  return Math.max(0, Math.round((firstAcAt.getTime() - openedAt.getTime()) / 60_000));
}
