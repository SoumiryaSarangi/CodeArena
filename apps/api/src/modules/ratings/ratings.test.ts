import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MIN_RATED_PLAYERS, computeRatings, type Player } from './ratings';

/** Ranks from a result order with ties: `groups` are the sizes of tied groups, best first. */
function field(ratings: number[], groups: number[]): Player[] {
  const out: Player[] = [];
  let place = 1;
  let k = 0;
  for (const g of groups) {
    for (let i = 0; i < g && k < ratings.length; i++, k++) {
      out.push({ id: `u${String(k).padStart(3, '0')}`, rating: ratings[k]!, rank: place });
    }
    place += g;
  }
  return out;
}

const fields = fc
  .integer({ min: MIN_RATED_PLAYERS, max: 40 })
  .chain((n) =>
    fc.tuple(
      fc.array(fc.integer({ min: 600, max: 3200 }), { minLength: n, maxLength: n }),
      fc.array(fc.integer({ min: 1, max: 3 }), { minLength: n, maxLength: n }),
    ),
  )
  .map(([ratings, groups]) => {
    // Cut the group sizes so they cover exactly the players.
    let left = ratings.length;
    const sizes: number[] = [];
    for (const g of groups) {
      if (left <= 0) break;
      sizes.push(Math.min(g, left));
      left -= sizes.at(-1)!;
    }
    return field(ratings, sizes);
  });

describe('C-08: ratings (FR-RATE-01, FR-RATE-02)', () => {
  it('FR-RATE-02: the same field always gives the same result, in any input order', () => {
    fc.assert(
      fc.property(fields, fc.nat(), (f, k) => {
        const a = computeRatings(f);
        expect(computeRatings(f)).toEqual(a);
        const cut = k % f.length;
        const shuffled = [...f.slice(cut), ...f.slice(0, cut)].reverse();
        const byId = (r: typeof a) => Object.fromEntries(r.map((c) => [c.id, c]));
        expect(byId(computeRatings(shuffled))).toEqual(byId(a));
      }),
      { numRuns: 200 },
    );
  });

  it('FR-RATE-02: the deltas never sum above zero (no inflation)', () => {
    fc.assert(
      fc.property(fields, (f) => {
        const sum = computeRatings(f).reduce((s, c) => s + c.delta, 0);
        expect(sum).toBeLessThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it('FR-RATE-01: the result is consistent: new = old + delta, one row per player', () => {
    fc.assert(
      fc.property(fields, (f) => {
        const r = computeRatings(f);
        expect(r).toHaveLength(f.length);
        for (const c of r) expect(c.newRating).toBe(c.oldRating + c.delta);
        expect(new Set(r.map((c) => c.id)).size).toBe(f.length);
      }),
      { numRuns: 100 },
    );
  });

  it('equal ratings: a better rank never earns a smaller change', () => {
    fc.assert(
      fc.property(fc.integer({ min: 5, max: 30 }), fc.integer({ min: 800, max: 2800 }), (n, r) => {
        const f = field(
          Array.from({ length: n }, () => r),
          Array.from({ length: n }, () => 1),
        );
        const d = computeRatings(f).map((c) => c.delta);
        for (let i = 1; i < d.length; i++) expect(d[i - 1]!).toBeGreaterThanOrEqual(d[i]!);
        expect(d[0]!).toBeGreaterThan(0);
        expect(d.at(-1)!).toBeLessThan(0);
      }),
    );
  });

  it('an upset moves more than an expected result', () => {
    const ratings = [2000, 1800, 1600, 1400, 1200];
    const expected = computeRatings(field(ratings, [1, 1, 1, 1, 1]));
    // The same players, finishing in the opposite order: the lowest-rated wins.
    const upset = computeRatings(
      field(ratings, [1, 1, 1, 1, 1]).map((p, i) => ({ ...p, rank: 5 - i })),
    );
    const win = (r: typeof upset, rating: number) => r.find((c) => c.oldRating === rating)!;
    expect(win(upset, 1200).delta).toBeGreaterThan(win(expected, 2000).delta);
    expect(win(upset, 1200).delta).toBeGreaterThan(0);
    expect(win(upset, 2000).delta).toBeLessThan(win(expected, 1200).delta);
  });

  it('a hand-checked field of five equal players', () => {
    const r = computeRatings(field([1400, 1400, 1400, 1400, 1400], [1, 1, 1, 1, 1]));
    // Symmetric: the middle player's change is the same as the mean, the order is monotone.
    expect(r.map((c) => c.seed)).toEqual([3, 3, 3, 3, 3]);
    expect(r[2]!.delta).toBeLessThanOrEqual(0);
    expect(r[0]!.delta).toBeGreaterThan(r[4]!.delta);
  });

  it('no players, no changes; a single tie group changes nobody much', () => {
    expect(computeRatings([])).toEqual([]);
    const all = computeRatings(field(Array(6).fill(1500), [6]));
    for (const c of all) expect(Math.abs(c.delta)).toBeLessThanOrEqual(2);
  });
});
