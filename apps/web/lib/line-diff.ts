export interface DiffLine {
  no: number;
  expected: string | null;
  actual: string | null;
  same: boolean;
}

/**
 * Line by line, expected next to yours (UI_UX S05 sample diff). Trailing whitespace and trailing
 * blank lines are ignored, like the `tokens` checker would; a missing line shows as null.
 */
export function lineDiff(expected: string, actual: string): DiffLine[] {
  const split = (s: string) => {
    const lines = s
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''));
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines;
  };
  const e = split(expected);
  const a = split(actual);
  return Array.from({ length: Math.max(e.length, a.length) }, (_, i) => ({
    no: i + 1,
    expected: e[i] ?? null,
    actual: a[i] ?? null,
    same: e[i] === a[i],
  }));
}
