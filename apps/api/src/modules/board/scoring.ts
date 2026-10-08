/**
 * ICPC scoring (PRD §9.1) as pure functions: the live update, the rebuild and the tests all use
 * these, so a rebuilt board equals the live one by construction (FR-BOARD-03).
 */

/** SD-§9.2 packing: score = S·2^27 + (2^17 − 1 − P)·2^10 + (1023 − T). */
export const SOLVED_UNIT = 2 ** 27;
export const PENALTY_MAX = 2 ** 17 - 1;
export const MINUTE_MAX = 1023;
/** Rejected attempts counted per problem (keeps P ≤ 26 · (1023 + 40 · 99) < 2^17). */
export const ATTEMPTS_CAP = 99;
export const MAX_PROBLEMS = 26;

export interface Totals {
  solved: number;
  penalty: number;
  /** Minute of the last first-AC, null with nothing solved. */
  lastAc: number | null;
}

export function pack(t: Totals): number {
  const p = Math.min(Math.max(t.penalty, 0), PENALTY_MAX);
  const m = Math.min(Math.max(t.lastAc ?? 0, 0), MINUTE_MAX);
  return t.solved * SOLVED_UNIT + (PENALTY_MAX - p) * 1024 + (MINUTE_MAX - m);
}

export function unpack(score: number): Totals {
  const solved = Math.floor(score / SOLVED_UNIT);
  const rest = score - solved * SOLVED_UNIT;
  const penalty = PENALTY_MAX - Math.floor(rest / 1024);
  const lastAc = MINUTE_MAX - (rest % 1024);
  return { solved, penalty, lastAc: solved === 0 ? null : lastAc };
}

/** Equal scores share a rank: 1 + the number of strictly greater scores (SD-§9.2). */
export function ranks(scores: number[]): number[] {
  const sorted = [...scores].sort((a, b) => b - a);
  return scores.map((s) => 1 + sorted.findIndex((x) => x === s));
}

export interface BoardSub {
  id: string;
  createdAt: number;
  /** Whole minutes from the official start (PRD §9.1). */
  minute: number;
  status: 'queued' | 'judging' | 'done' | 'failed';
  verdict: string | null;
  disqualified: boolean;
  afterFreeze: boolean;
}

export interface Cell {
  /** Counted rejected attempts. */
  a: number;
  /** AC minute or null. */
  m: number | null;
  /** created_at (ms) of the AC, for first solves. */
  t: number | null;
  /** Pending: not judged yet, or (frozen view) attempted after the freeze. */
  p: number;
}

export const EMPTY_CELL: Cell = { a: 0, m: null, t: null, p: 0 };

const byTime = (x: BoardSub, y: BoardSub) =>
  x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * One (user, problem) cell from all of that user's submissions on it, in submission order.
 * Disqualified and System Error submissions do not exist for scoring; CE counts only with
 * `ceCountsAsAttempt`; nothing after the first AC counts. `frozen`: what the public sees during the
 * freeze — attempts made after the freeze are pending, whatever their verdict.
 */
export function computeCell(
  subs: BoardSub[],
  rules: { ceCountsAsAttempt: boolean },
  frozen = false,
): Cell {
  const cell: Cell = { ...EMPTY_CELL };
  for (const s of [...subs].sort(byTime)) {
    if (s.disqualified) continue;
    if (cell.m !== null) break;
    if (frozen && s.afterFreeze) {
      cell.p += 1;
      continue;
    }
    if (s.status === 'queued' || s.status === 'judging') {
      cell.p += 1;
      continue;
    }
    if (s.status === 'failed' || s.verdict === null || s.verdict === 'SE') continue;
    if (s.verdict === 'AC') {
      cell.m = Math.min(s.minute, MINUTE_MAX);
      cell.t = s.createdAt;
      break;
    }
    if (s.verdict === 'CE' && !rules.ceCountsAsAttempt) continue;
    cell.a = Math.min(cell.a + 1, ATTEMPTS_CAP);
  }
  return cell;
}

export function computeRow(cells: Cell[], rules: { penaltyMinutes: number }): Totals {
  let solved = 0;
  let penalty = 0;
  let lastAc: number | null = null;
  for (const c of cells) {
    if (c.m === null) continue;
    solved += 1;
    penalty += c.m + rules.penaltyMinutes * c.a;
    lastAc = lastAc === null ? c.m : Math.max(lastAc, c.m);
  }
  return { solved, penalty, lastAc };
}
