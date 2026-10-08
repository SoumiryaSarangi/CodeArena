/**
 * Whether a sample run's output matches the sample's expected output the way the problem's own
 * checker would compare them (FR-SUB-05). It mirrors the Go checkers (`apps/worker/internal/judge/
 * checker.go`) so the Console never says "differs" for an answer the judge accepts. A testlib
 * checker may accept many outputs, so for it nothing can be said (null).
 */
export type CheckerSpec = { kind: string; eps?: number | null };

const tokens = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** Trailing spaces, tabs and CRs of every line, and one final newline, do not count. */
const normalized = (s: string) => {
  const lines = s.split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.map((l) => l.replace(/[ \t\r]+$/, '')).join('\n');
};

export function sampleMatches(
  checker: CheckerSpec | null | undefined,
  output: string,
  expected: string,
): boolean | null {
  switch (checker?.kind) {
    case 'exact':
      return normalized(output) === normalized(expected);
    case 'float': {
      const eps = checker.eps;
      if (typeof eps !== 'number' || !(eps >= 0)) return null;
      const got = tokens(output);
      const want = tokens(expected);
      if (got.length !== want.length) return false;
      return got.every((g, i) => {
        const w = want[i]!;
        if (g === w) return true;
        const gn = Number(g);
        const wn = Number(w);
        if (g === '' || w === '' || Number.isNaN(gn) || Number.isNaN(wn)) return false;
        if (!Number.isFinite(gn) || !Number.isFinite(wn)) return gn === wn;
        return Math.abs(gn - wn) <= eps * Math.max(1, Math.abs(wn));
      });
    }
    case 'tokens': {
      const got = tokens(output);
      const want = tokens(expected);
      return got.length === want.length && got.every((g, i) => g === want[i]);
    }
    default:
      return null;
  }
}
