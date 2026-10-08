/**
 * Contest ratings (C-08, PRD §9.4, SD-§9.5): the Codeforces-style multi-player Elo. Pure and
 * deterministic: the same field gives the same numbers on any run, in any input order.
 */

export interface Player {
  id: string;
  /** Rating before the contest. */
  rating: number;
  /** Standing: 1 + the number of players with a strictly better result (ties share a rank). */
  rank: number;
}

export interface RatingChange {
  id: string;
  oldRating: number;
  newRating: number;
  delta: number;
  /** Expected rank before the contest (1 = expected to win). */
  seed: number;
}

export const MIN_RATED_PLAYERS = 5;
const LOW = -4000;
const HIGH = 8000;
/** 100 halvings of a 12000-wide interval is far below double precision: a fixed, exact loop. */
const ITERATIONS = 100;

/** Probability that a player rated `a` beats one rated `b`. */
const wins = (a: number, b: number) => 1 / (1 + Math.pow(10, (b - a) / 400));

/** Expected rank of a player rated `r` against `others` (not including themselves). */
const seedAgainst = (r: number, others: readonly Player[]) => {
  let s = 1;
  for (const o of others) s += wins(o.rating, r);
  return s;
};

export function computeRatings(input: readonly Player[]): RatingChange[] {
  // A fixed order makes every floating-point sum, and so every result, reproducible.
  const players = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = players.length;
  if (n === 0) return [];

  // Tied players share the middle of the places they occupy, so a tie is neither a win nor a loss.
  const tied = new Map<number, number>();
  for (const p of players) tied.set(p.rank, (tied.get(p.rank) ?? 0) + 1);
  const place = (p: Player) => p.rank + ((tied.get(p.rank) ?? 1) - 1) / 2;

  const raw = players.map((p) => {
    const others = players.filter((o) => o !== p);
    const seed = seedAgainst(p.rating, others);
    const target = Math.sqrt(seed * place(p));
    // The rating at which the expected rank equals `target` (expected rank falls as rating rises).
    let lo = LOW;
    let hi = HIGH;
    for (let i = 0; i < ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (seedAgainst(mid, others) > target) lo = mid;
      else hi = mid;
    }
    return { p, seed, d: ((lo + hi) / 2 - p.rating) / 2 };
  });

  // Anti-inflation: the field as a whole must not gain rating...
  const inc = -raw.reduce((s, r) => s + r.d, 0) / n - 1;
  for (const r of raw) r.d += inc;
  // ...and the strongest players must not lose more than the field on average.
  const top = Math.min(n, Math.round(4 * Math.sqrt(n)));
  const strongest = [...raw]
    .sort((a, b) => b.p.rating - a.p.rating || (a.p.id < b.p.id ? -1 : 1))
    .slice(0, top);
  const inc2 = Math.min(Math.max(-strongest.reduce((s, r) => s + r.d, 0) / top, -10), 0);
  for (const r of raw) r.d += inc2;

  return raw.map(({ p, seed, d }) => {
    const delta = Math.round(d);
    return {
      id: p.id,
      oldRating: p.rating,
      newRating: p.rating + delta,
      delta,
      seed: Math.round(seed * 1e6) / 1e6,
    };
  });
}
