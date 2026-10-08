import { describe, expect, it } from 'vitest';
import { avoidTermsFor, filterHint, GENERIC_HINTS, isCodeLike } from './hint-filter';
import { parseSufficiency } from './hints.service';

describe('FR-AI-03: the deterministic hint filter', () => {
  const prose =
    'Think about what happens when the same value appears twice. A `map` from value to its last position can answer each query quickly, so the total work stays linear in the input size.';

  it('lets plain prose and short names in backticks through', () => {
    expect(filterHint(prose, 2)).toEqual({ ok: true, reasons: [] });
  });

  it('rejects fenced code (backticks or tildes)', () => {
    expect(filterHint('Try this:\n```cpp\nint x = 0;\n```', 3).reasons).toContain('fenced-code');
    expect(filterHint('Try:\n~~~\nx\n~~~', 3).reasons).toContain('fenced-code');
  });

  it('rejects two or more consecutive code-like lines, but not one', () => {
    const two = 'First do this\nfor (int i = 0; i < n; i++) {\n    sum += a[i];\nthen stop';
    expect(filterHint(two, 3).reasons).toContain('code-lines');
    expect(filterHint('Loop over the array\nsum += a[i];\nand you are done', 3).ok).toBe(true);
    const py = 'Idea:\ndef solve(a):\n    return sorted(a)[0]\nThat is it.';
    expect(filterHint(py, 3).reasons).toContain('code-lines');
  });

  it('rejects an inline code span that is a statement, not a name', () => {
    expect(filterHint('Use `for (i = 0; i < n; i++)` here', 3).reasons).toContain('inline-code');
    expect(filterHint('Use `dp[i][j]` here', 3).ok).toBe(true);
    expect(filterHint(`Use \`${'a'.repeat(41)}\``, 3).reasons).toContain('inline-code');
  });

  it('recognises code-like lines', () => {
    for (const l of [
      'int x = 5;',
      'return a + b',
      'while (lo < hi) {',
      '#include <vector>',
      '    foo(bar);',
      'x += 1',
      'print(x)',
    ])
      expect(isCodeLike(l), l).toBe(true);
    for (const l of [
      'Think about the smallest case.',
      'The answer grows with n.',
      '- first idea',
      '',
    ])
      expect(isCodeLike(l), l).toBe(false);
  });

  it('avoid-set: avoidSet[n] binds levels up to n; word-bounded and case-insensitive', () => {
    const avoid = { '1': ['segment tree'], '2': ['Fenwick', 'binary search'] };
    expect(avoidTermsFor(avoid, 1).sort()).toEqual(['Fenwick', 'binary search', 'segment tree']);
    expect(avoidTermsFor(avoid, 2)).toEqual(['Fenwick', 'binary search']);
    expect(avoidTermsFor(avoid, 3)).toEqual([]);
    expect(filterHint('A Segment Tree helps here.', 1, avoid).reasons).toEqual([
      'avoid:segment tree',
    ]);
    expect(filterHint('A segment tree helps here.', 2, avoid).ok).toBe(true); // allowed from level 2
    expect(filterHint('Use FENWICK trees.', 2, avoid).reasons).toEqual(['avoid:Fenwick']);
    expect(filterHint('Use FENWICK trees.', 3, avoid).ok).toBe(true);
    expect(filterHint('A fenwickian idea', 2, avoid).ok).toBe(true); // not a whole word
  });

  it('the generic fallbacks themselves pass the filter at every level', () => {
    for (const level of [1, 2, 3] as const) {
      expect(filterHint(GENERIC_HINTS[level], level, { '1': ['x'], '2': ['y'] }).ok).toBe(true);
    }
  });

  it('the sufficiency answer is read leniently: fenced or broken JSON counts as sufficient', () => {
    expect(parseSufficiency('{"sufficient": false, "nudge": "Run it first."}')).toEqual({
      sufficient: false,
      nudge: 'Run it first.',
    });
    expect(parseSufficiency('```json\n{"sufficient": false, "nudge": "x"}\n```').sufficient).toBe(
      false,
    );
    expect(parseSufficiency('not json').sufficient).toBe(true);
    expect(parseSufficiency('{"sufficient": true}')).toEqual({ sufficient: true, nudge: '' });
  });
});
