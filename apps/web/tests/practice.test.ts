import { describe, expect, it } from 'vitest';
import {
  difficultyLabel,
  hasFilters,
  parseFilters,
  rangeInvalid,
  toQuery,
  type Filters,
} from '@/lib/practice';

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));

describe('UI-01: practice filters live in the URL (FR-PROB-08)', () => {
  it('round-trips every filter', () => {
    const f: Filters = {
      q: 'path',
      tags: ['dp', 'graphs'],
      minDiff: 1000,
      maxDiff: 1500,
      status: 'attempted',
    };
    expect(parse(toQuery(f))).toEqual(f);
  });

  it('leaves empty filters out, so the same filters always give the same URL', () => {
    expect(toQuery({ q: '', tags: [] })).toBe('');
    expect(toQuery({ q: '  ', tags: [] })).toBe('');
    expect(hasFilters({ q: '', tags: [] })).toBe(false);
    expect(toQuery({ q: ' x ', tags: ['a'], status: 'new' })).toBe('q=x&tags=a&status=new');
  });

  it('ignores anything invalid instead of passing it to the API', () => {
    const f = parse('minDiff=abc&maxDiff=850&status=bogus&tags=,,a,,&q=' + 'x'.repeat(300));
    expect(f.minDiff).toBeUndefined();
    expect(f.maxDiff).toBeUndefined(); // not a multiple of 100
    expect(f.status).toBeUndefined();
    expect(f.tags).toEqual(['a']);
    expect(f.q).toHaveLength(100);
    expect(parse('minDiff=700').minDiff).toBeUndefined();
    expect(parse('maxDiff=3600').maxDiff).toBeUndefined();
    expect(parse('tags=' + Array(30).fill('t').join(',')).tags).toHaveLength(10);
  });

  it('detects a range that can never match', () => {
    expect(rangeInvalid({ q: '', tags: [], minDiff: 1500, maxDiff: 1000 })).toBe(true);
    expect(rangeInvalid({ q: '', tags: [], minDiff: 1000, maxDiff: 1000 })).toBe(false);
    expect(rangeInvalid({ q: '', tags: [], minDiff: 1000 })).toBe(false);
  });

  it('gives every difficulty a word next to the number', () => {
    expect([800, 1000, 1100, 1400, 1500, 1800, 1900, 3500].map(difficultyLabel)).toEqual([
      'Easy',
      'Easy',
      'Medium',
      'Medium',
      'Hard',
      'Hard',
      'Expert',
      'Expert',
    ]);
  });
});
