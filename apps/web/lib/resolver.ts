import type { BoardCell, BoardRow, BoardSnapshot } from '@codearena/contracts';
import { rankRows } from './board';

/** The packed score of SD-§9.2 (same constants as the API): S·2^27 + (2^17−1−P)·2^10 + (1023−T). */
const SOLVED_UNIT = 2 ** 27;
const PENALTY_MAX = 2 ** 17 - 1;
const MINUTE_MAX = 1023;

export function packScore(t: { solved: number; penalty: number; lastAc: number | null }): number {
  const p = Math.min(Math.max(t.penalty, 0), PENALTY_MAX);
  const m = Math.min(Math.max(t.lastAc ?? 0, 0), MINUTE_MAX);
  return t.solved * SOLVED_UNIT + (PENALTY_MAX - p) * 1024 + (MINUTE_MAX - m);
}

export function totalsOf(cells: Record<string, BoardCell>, penaltyMinutes: number) {
  let solved = 0;
  let penalty = 0;
  let lastAc: number | null = null;
  for (const c of Object.values(cells)) {
    if (c.acMinute === null) continue;
    solved += 1;
    penalty += c.acMinute + penaltyMinutes * c.attempts;
    lastAc = lastAc === null ? c.acMinute : Math.max(lastAc, c.acMinute);
  }
  return { solved, penalty, lastAc };
}

const same = (a: BoardCell | undefined, b: BoardCell | undefined) =>
  (a?.attempts ?? 0) === (b?.attempts ?? 0) &&
  (a?.acMinute ?? null) === (b?.acMinute ?? null) &&
  (a?.pending ?? 0) === (b?.pending ?? 0);

export interface Resolver {
  labels: string[];
  penaltyMinutes: number;
  /** The rows as they are now, ranked. */
  rows: BoardRow[];
  /** What each user's cells will become (the unfrozen board). */
  target: Map<string, Record<string, BoardCell>>;
  total: number;
  revealed: number;
}

export interface Step {
  userId: string;
  label: string;
  /** The cell turned into an accepted one. */
  solved: boolean;
  rankBefore: number;
  rankAfter: number;
}

/**
 * FR-BOARD-06 / SD-§5.6: start from the frozen board; each step takes the lowest-ranked row that
 * still has an unrevealed cell and reveals its leftmost one (the real result replaces the pending
 * cell, the row is re-scored and everyone re-ranked). When nothing is left the rows equal the live
 * board. A cell is "unrevealed" when the frozen and live cells differ.
 */
export function startResolver(
  frozen: BoardSnapshot,
  live: BoardSnapshot,
  penaltyMinutes: number,
): Resolver {
  const labels = live.problems.map((p) => p.label);
  const target = new Map(live.rows.map((r) => [r.userId, r.cells]));
  let total = 0;
  for (const r of frozen.rows) {
    const t = target.get(r.userId) ?? {};
    for (const l of labels) if (!same(r.cells[l], t[l])) total += 1;
  }
  return { labels, penaltyMinutes, rows: frozen.rows, target, total, revealed: 0 };
}

export function nextStep(s: Resolver): { state: Resolver; step: Step } | null {
  for (let i = s.rows.length - 1; i >= 0; i--) {
    const row = s.rows[i]!;
    const t = s.target.get(row.userId) ?? {};
    const label = s.labels.find((l) => !same(row.cells[l], t[l]));
    if (!label) continue;
    const next = t[label];
    const cells = { ...row.cells };
    if (next) cells[label] = next;
    else delete cells[label];
    const others = s.rows.map((r) => {
      // A revealed first solve takes the star from whoever held it on this problem.
      if (r.userId === row.userId || !next?.first || !r.cells[label]?.first) return r;
      return { ...r, cells: { ...r.cells, [label]: { ...r.cells[label]!, first: false } } };
    });
    const totals = totalsOf(cells, s.penaltyMinutes);
    const updated = {
      ...row,
      solved: totals.solved,
      penalty: totals.penalty,
      lastAcMinute: totals.lastAc,
      score: packScore(totals),
      cells,
    };
    const rows = rankRows(others.map((r) => (r.userId === row.userId ? updated : r)));
    return {
      state: { ...s, rows, revealed: s.revealed + 1 },
      step: {
        userId: row.userId,
        label,
        solved: next?.acMinute != null && row.cells[label]?.acMinute == null,
        rankBefore: row.rank,
        rankAfter: rows.find((r) => r.userId === row.userId)!.rank,
      },
    };
  }
  return null;
}

/** Runs every remaining step; the result is what the ceremony ends on. */
export function finish(s: Resolver): Resolver {
  let cur = s;
  for (;;) {
    const n = nextStep(cur);
    if (!n) return cur;
    cur = n.state;
  }
}
