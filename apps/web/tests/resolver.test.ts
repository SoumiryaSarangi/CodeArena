import type { BoardCell, BoardRow, BoardSnapshot } from '@codearena/contracts';
import { describe, expect, it } from 'vitest';
import { rankRows } from '../lib/board';
import { finish, nextStep, packScore, startResolver, totalsOf } from '../lib/resolver';

const LABELS = ['A', 'B', 'C', 'D'];
const PM = 20;

/** A small seeded generator, so a failing board can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function rowOf(userId: string, handle: string, cells: Record<string, BoardCell>) {
  const t = totalsOf(cells, PM);
  return {
    userId,
    handle,
    solved: t.solved,
    penalty: t.penalty,
    lastAcMinute: t.lastAc,
    score: packScore(t),
    cells,
  } satisfies Omit<BoardRow, 'rank'>;
}

const snap = (rows: Omit<BoardRow, 'rank'>[], frozen: boolean): BoardSnapshot => ({
  contestId: 'c1',
  serverNow: '2026-10-10T15:40:00.000Z',
  version: 1,
  frozen,
  problems: LABELS.map((label) => ({ label, solvedCount: 0, firstSolverId: null })),
  rows: rankRows(rows),
});

/** Random contest: the live cells, and the frozen view that hides what happened after the freeze. */
function randomContest(seed: number, users: number) {
  const r = rng(seed);
  const live: Omit<BoardRow, 'rank'>[] = [];
  const frozen: Omit<BoardRow, 'rank'>[] = [];
  for (let u = 0; u < users; u++) {
    const lc: Record<string, BoardCell> = {};
    const fc: Record<string, BoardCell> = {};
    for (const l of LABELS) {
      if (r() < 0.25) continue; // never attempted
      const attempts = Math.floor(r() * 4);
      const ac = r() < 0.55 ? Math.floor(r() * 120) : null;
      lc[l] = { attempts, acMinute: ac, pending: 0, first: false };
      if (r() < 0.5) {
        // Decided before the freeze, or after it: then the frozen cell only shows "pending".
        fc[l] = { ...lc[l]! };
      } else {
        fc[l] = {
          attempts: Math.floor(attempts / 2),
          acMinute: null,
          pending: 1 + Math.floor(r() * 3),
          first: false,
        };
      }
    }
    live.push(rowOf(`u${u}`, `user${String(u).padStart(2, '0')}`, lc));
    frozen.push(rowOf(`u${u}`, `user${String(u).padStart(2, '0')}`, fc));
  }
  return { live: snap(live, false), frozen: snap(frozen, true) };
}

const view = (rows: BoardRow[]) =>
  rows.map((r) => ({
    id: r.userId,
    rank: r.rank,
    score: r.score,
    solved: r.solved,
    penalty: r.penalty,
    last: r.lastAcMinute,
    cells: r.cells,
  }));

describe('C-06: resolver (FR-BOARD-06)', () => {
  it('FR-BOARD-06: the ceremony ends on exactly the unfrozen board (200 random contests)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { live, frozen } = randomContest(seed, 2 + (seed % 14));
      const end = finish(startResolver(frozen, live, PM));
      expect(view(end.rows), `seed ${seed}`).toEqual(view(live.rows));
      expect(end.revealed).toBe(end.total);
    }
  });

  it('FR-BOARD-06: each step reveals the lowest-ranked row with something left, its leftmost cell', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { live, frozen } = randomContest(seed * 7, 3 + (seed % 9));
      let s = startResolver(frozen, live, PM);
      for (;;) {
        const n = nextStep(s);
        if (!n) break;
        const before = s.rows;
        const i = before.findIndex((r) => r.userId === n.step.userId);
        // Nobody below the revealed row had anything left to reveal.
        for (const lower of before.slice(i + 1)) {
          const t = s.target.get(lower.userId) ?? {};
          for (const l of s.labels) {
            const a = lower.cells[l];
            const b = t[l];
            expect(
              (a?.attempts ?? 0) === (b?.attempts ?? 0) &&
                (a?.acMinute ?? null) === (b?.acMinute ?? null) &&
                (a?.pending ?? 0) === (b?.pending ?? 0),
              `seed ${seed}`,
            ).toBe(true);
          }
        }
        // Everything left of the revealed cell in that row was already final.
        const t = s.target.get(n.step.userId) ?? {};
        for (const l of s.labels.slice(0, s.labels.indexOf(n.step.label))) {
          expect(before[i]!.cells[l]?.acMinute ?? null).toBe(t[l]?.acMinute ?? null);
          expect(before[i]!.cells[l]?.pending ?? 0).toBe(t[l]?.pending ?? 0);
        }
        s = n.state;
      }
    }
  });

  it('a solve can lift a row past one that solved less, and the step says so', () => {
    const cell = (acMinute: number | null, pending = 0): BoardCell => ({
      attempts: 0,
      acMinute,
      pending,
      first: false,
    });
    const frozen = snap(
      [
        rowOf('top', 'top', { A: cell(10), B: cell(20) }),
        rowOf('mid', 'mid', { A: cell(30) }),
        rowOf('low', 'low', { A: cell(40), B: cell(null, 1) }),
      ],
      true,
    );
    const live = snap(
      [
        rowOf('top', 'top', { A: cell(10), B: cell(20) }),
        rowOf('mid', 'mid', { A: cell(30) }),
        rowOf('low', 'low', { A: cell(40), B: cell(50) }),
      ],
      false,
    );
    const first = nextStep(startResolver(frozen, live, PM))!;
    expect(first.step).toMatchObject({ userId: 'low', label: 'B', solved: true });
    expect(first.step.rankBefore).toBe(3);
    expect(first.step.rankAfter).toBe(2); // two solves beat mid's one, but not top's lower penalty
    expect(nextStep(first.state)).toBeNull();
  });

  it('nothing frozen: no steps', () => {
    const { live } = randomContest(3, 5);
    const s = startResolver(live, live, PM);
    expect(s.total).toBe(0);
    expect(nextStep(s)).toBeNull();
  });

  it('FR-BOARD-02: the client score equals the API formula on its edges', () => {
    expect(packScore({ solved: 0, penalty: 0, lastAc: null })).toBe(1023 + (2 ** 17 - 1) * 1024);
    expect(packScore({ solved: 26, penalty: 129558, lastAc: 1023 })).toBeLessThan(2 ** 53);
    expect(packScore({ solved: 2, penalty: 5, lastAc: 5 })).toBeGreaterThan(
      packScore({ solved: 1, penalty: 0, lastAc: 0 }),
    );
  });
});
