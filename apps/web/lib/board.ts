import type { BoardDiffData, BoardRow, BoardSnapshot } from '@codearena/contracts';

/** Row order of a board: score descending, ties by handle (they share a rank anyway). */
export function rankRows(rows: Omit<BoardRow, 'rank'>[]): BoardRow[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
  const scores = sorted.map((r) => r.score);
  return sorted.map((r, i) => ({ ...r, rank: 1 + scores.findIndex((s) => s === scores[i]) }));
}

function summarise(problems: BoardSnapshot['problems'], rows: BoardRow[]) {
  return problems.map((p) => {
    let solvedCount = 0;
    let firstSolverId: string | null = null;
    for (const r of rows) {
      const c = r.cells[p.label];
      if (!c) continue;
      if (c.acMinute !== null) solvedCount += 1;
      if (c.first) firstSolverId = r.userId;
    }
    return { label: p.label, solvedCount, firstSolverId };
  });
}

export interface Applied {
  board: BoardSnapshot;
  /** The diff cannot be applied exactly (a first solve moved to someone we have not seen). */
  resync: boolean;
  /** `userId:label` of cells that just became the first solve (they flash once). */
  newFirsts: string[];
}

/**
 * Patches a snapshot with a `board.diff` (SD-§10, FR-BOARD-04). A diff that is not newer than the
 * snapshot is already included and changes nothing. Changed rows replace their old versions, then
 * everything is ranked by `score` again, so other rows' ranks shift correctly.
 */
export function applyDiff(board: BoardSnapshot, diff: BoardDiffData): Applied {
  if (diff.version <= board.version) return { board, resync: false, newFirsts: [] };
  const changed = new Map(diff.rows.map((r) => [r.userId, r]));
  const kept = board.rows.filter((r) => !changed.has(r.userId));
  // A row that claims a first solve takes the flag away from whoever had it.
  const claimed = new Set<string>();
  for (const r of diff.rows) {
    for (const [label, c] of Object.entries(r.cells)) if (c.first) claimed.add(label);
  }
  const cleared = kept.map((r) => {
    const stolen = Object.entries(r.cells).filter(([l, c]) => c.first && claimed.has(l));
    if (stolen.length === 0) return r;
    const cells = { ...r.cells };
    for (const [l, c] of stolen) cells[l] = { ...c, first: false };
    return { ...r, cells };
  });
  const rows = rankRows([...cleared, ...diff.rows]);
  const problems = summarise(board.problems, rows);
  const resync = problems.some((p, i) => {
    const before = board.problems[i]!.firstSolverId;
    return before !== null && p.firstSolverId === null;
  });
  const wasFirst = new Set(
    board.rows.flatMap((r) =>
      Object.entries(r.cells)
        .filter(([, c]) => c.first)
        .map(([l]) => `${r.userId}:${l}`),
    ),
  );
  const newFirsts = rows.flatMap((r) =>
    Object.entries(r.cells)
      .filter(([l, c]) => c.first && !wasFirst.has(`${r.userId}:${l}`))
      .map(([l]) => `${r.userId}:${l}`),
  );
  return {
    board: {
      ...board,
      version: diff.version,
      frozen: board.frozen || diff.frozen,
      problems,
      rows,
    },
    resync,
    newFirsts,
  };
}

/** What a screen reader hears for a cell (the visible text is glyphs and numbers). */
export function describeCell(c: {
  attempts: number;
  acMinute: number | null;
  pending: number;
  first: boolean;
}): string {
  const tries = (n: number) => `${n} rejected attempt${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (c.acMinute !== null) {
    parts.push(`Solved at minute ${c.acMinute}`);
    if (c.attempts > 0) parts.push(tries(c.attempts));
    if (c.first) parts.push('first to solve');
    return parts.join(', ');
  }
  if (c.attempts > 0) parts.push(tries(c.attempts));
  if (c.pending > 0) parts.push(`${c.pending} pending`);
  return parts.length > 0 ? parts.join(', ') : 'Not attempted';
}
