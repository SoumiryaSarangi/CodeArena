import { describe, expect, it } from 'vitest';
import { sampleMatches } from './sample-match';

describe('FR-SUB-05: a sample run is compared the way the problem checks it', () => {
  const float = { kind: 'float', eps: 1e-6 };

  it('float: an extra digit or tiny rounding is a match (the Fractional Loot case)', () => {
    expect(sampleMatches(float, '240.0000000000\n', '240.000000000\n')).toBe(true);
    expect(sampleMatches(float, '5.0000004', '5.000000000')).toBe(true);
    expect(sampleMatches(float, '5', '5.000000000')).toBe(true);
  });

  it('float: a real difference, a different token count, or text, is not', () => {
    expect(sampleMatches(float, '5.01', '5.000000000')).toBe(false);
    expect(sampleMatches(float, '5 6', '5')).toBe(false);
    expect(sampleMatches(float, 'five', '5')).toBe(false);
    expect(sampleMatches(float, '', '5')).toBe(false);
  });

  it('float: the tolerance is relative for large values, like the judge', () => {
    expect(sampleMatches(float, '1000000000.5', '1000000000')).toBe(true); // 0.5 <= 1e-6 * 1e9 = 1000
    expect(sampleMatches(float, '1000002000', '1000000000')).toBe(false);
  });

  it('float without a usable eps says nothing', () => {
    expect(sampleMatches({ kind: 'float' }, '1', '1')).toBeNull();
    expect(sampleMatches({ kind: 'float', eps: -1 }, '1', '1')).toBeNull();
  });

  it('tokens ignore whitespace layout; exact only ignores line-end blanks and one final newline', () => {
    const t = { kind: 'tokens' };
    expect(sampleMatches(t, '1  2\n3', '1 2 3\n')).toBe(true);
    expect(sampleMatches(t, '1 2', '1 3')).toBe(false);
    const e = { kind: 'exact' };
    expect(sampleMatches(e, 'a b  \nc\n', 'a b\nc')).toBe(true);
    expect(sampleMatches(e, 'a  b\nc', 'a b\nc')).toBe(false);
    expect(sampleMatches(e, 'a\n\n', 'a\n')).toBe(false);
  });

  it('a testlib checker may accept many outputs, so no verdict on "differs"', () => {
    expect(sampleMatches({ kind: 'testlib' }, '1', '2')).toBeNull();
    expect(sampleMatches(undefined, '1', '1')).toBeNull();
  });
});
