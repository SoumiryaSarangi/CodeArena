import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPTS_CAP,
  MAX_PROBLEMS,
  MINUTE_MAX,
  PENALTY_MAX,
  computeCell,
  computeRow,
  pack,
  ranks,
  unpack,
  type BoardSub,
} from './scoring';

const rules = { penaltyMinutes: 20, ceCountsAsAttempt: false };
let n = 0;
const sub = (minute: number, verdict: string | null, extra: Partial<BoardSub> = {}): BoardSub => ({
  id: `s${String(n++).padStart(4, '0')}`,
  createdAt: minute * 60_000 + n,
  minute,
  status: verdict === null ? 'queued' : verdict === 'SE' ? 'failed' : 'done',
  verdict,
  disqualified: false,
  afterFreeze: false,
  ...extra,
});

/** PRD §9.1 as a comparator: solved desc, penalty asc, last AC asc. */
const icpc = (
  x: { solved: number; penalty: number; lastAc: number },
  y: { solved: number; penalty: number; lastAc: number },
) => y.solved - x.solved || x.penalty - y.penalty || x.lastAc - y.lastAc;

const totals = fc.record({
  solved: fc.integer({ min: 0, max: MAX_PROBLEMS }),
  penalty: fc.integer({ min: 0, max: 26 * (MINUTE_MAX + 40 * ATTEMPTS_CAP) }),
  lastAc: fc.integer({ min: 0, max: MINUTE_MAX }),
});

describe('FR-BOARD-02: packed composite score', () => {
  it('the largest possible score stays below 2^53', () => {
    const max = pack({ solved: MAX_PROBLEMS, penalty: 0, lastAc: 0 });
    expect(max).toBeLessThan(2 ** 53);
    expect(Number.isSafeInteger(max)).toBe(true);
    // The worst real penalty fits its 17 bits (penaltyMinutes ≤ 40, ≤ 99 counted attempts).
    expect(MAX_PROBLEMS * (MINUTE_MAX + 40 * ATTEMPTS_CAP)).toBeLessThan(PENALTY_MAX);
  });

  it('ordering by score equals the ICPC comparator, for any two results', () => {
    fc.assert(
      fc.property(totals, totals, (x, y) => {
        const byScore = Math.sign(pack(y) - pack(x));
        expect(byScore).toBe(Math.sign(icpc(x, y)));
      }),
      { numRuns: 5000 },
    );
  });

  it('unpack inverts pack', () => {
    fc.assert(
      fc.property(totals, (t) => {
        const u = unpack(pack(t));
        expect(u.solved).toBe(t.solved);
        expect(u.penalty).toBe(t.penalty);
        expect(u.lastAc).toBe(t.solved === 0 ? null : t.lastAc);
      }),
    );
  });

  it('nothing solved packs the same however long ago, and below one solve', () => {
    expect(pack({ solved: 0, penalty: 0, lastAc: null })).toBeLessThan(
      pack({ solved: 1, penalty: PENALTY_MAX, lastAc: MINUTE_MAX }),
    );
  });
});

describe('FR-BOARD-01: ICPC cell and row rules (PRD §9.1)', () => {
  it('penalty = AC minute + 20 per rejected attempt before it; later submissions ignored', () => {
    const c = computeCell([sub(5, 'WA'), sub(9, 'TLE'), sub(30, 'AC'), sub(40, 'WA')], rules);
    expect(c).toMatchObject({ a: 2, m: 30, p: 0 });
    expect(computeRow([c], rules)).toEqual({ solved: 1, penalty: 70, lastAc: 30 });
  });

  it('compile errors do not count unless the contest says so; SE never counts', () => {
    const subs = [sub(1, 'CE'), sub(2, 'SE'), sub(3, 'WA'), sub(4, 'AC')];
    expect(computeCell(subs, rules).a).toBe(1);
    expect(computeCell(subs, { ceCountsAsAttempt: true }).a).toBe(2);
  });

  it('the order verdicts arrive in does not matter, only submission order', () => {
    const a = sub(5, 'WA');
    const b = sub(10, 'AC');
    expect(computeCell([b, a], rules)).toEqual(computeCell([a, b], rules));
    expect(computeCell([b, a], rules).a).toBe(1);
  });

  it('unjudged submissions are pending; disqualified ones do not exist', () => {
    expect(computeCell([sub(3, null), sub(4, 'WA')], rules)).toMatchObject({ a: 1, p: 1, m: null });
    expect(computeCell([sub(3, 'AC', { disqualified: true }), sub(9, 'AC')], rules)).toMatchObject({
      m: 9,
      a: 0,
    });
  });

  it('attempts are capped at 99', () => {
    const subs = Array.from({ length: 150 }, (_, i) => sub(i % 100, 'WA'));
    expect(computeCell(subs, rules).a).toBe(ATTEMPTS_CAP);
  });

  it('unsolved problems add no penalty; ties share a rank', () => {
    const unsolved = computeCell([sub(1, 'WA'), sub(2, 'WA')], rules);
    expect(computeRow([unsolved], rules)).toEqual({ solved: 0, penalty: 0, lastAc: null });
    expect(ranks([5, 9, 5, 1, 9])).toEqual([3, 1, 3, 5, 1]);
  });

  it('FR-BOARD-05: the frozen view keeps pre-freeze results and shows later attempts as pending', () => {
    const subs = [
      sub(50, 'WA'),
      sub(95, 'WA', { afterFreeze: true }),
      sub(100, 'AC', { afterFreeze: true }),
    ];
    expect(computeCell(subs, rules, true)).toEqual({ a: 1, m: null, t: null, p: 2 });
    expect(computeCell(subs, rules)).toMatchObject({ a: 2, m: 100, p: 0 });
    // Solved before the freeze: stays visible, later attempts are not pending.
    const early = [sub(10, 'AC'), sub(100, 'WA', { afterFreeze: true })];
    expect(computeCell(early, rules, true)).toMatchObject({ m: 10, p: 0 });
  });
});
