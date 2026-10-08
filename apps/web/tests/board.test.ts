import type { BoardCell, BoardDiffData, BoardRow, BoardSnapshot } from '@codearena/contracts';
import { describe, expect, it } from 'vitest';
import { applyDiff, describeCell, rankRows } from '../lib/board';

const cell = (over: Partial<BoardCell> = {}): BoardCell => ({
  attempts: 0,
  acMinute: null,
  pending: 0,
  first: false,
  ...over,
});
const row = (
  userId: string,
  handle: string,
  score: number,
  cells: Record<string, BoardCell> = {},
): Omit<BoardRow, 'rank'> => ({
  userId,
  handle,
  solved: 0,
  penalty: 0,
  lastAcMinute: null,
  score,
  cells,
});
const board = (rows: Omit<BoardRow, 'rank'>[], version = 1): BoardSnapshot => ({
  contestId: 'c1',
  serverNow: '2026-10-10T14:00:00.000Z',
  version,
  frozen: false,
  problems: [
    { label: 'A', solvedCount: 0, firstSolverId: null },
    { label: 'B', solvedCount: 0, firstSolverId: null },
  ],
  rows: rankRows(rows),
});
const diff = (rows: Omit<BoardRow, 'rank'>[], version: number, frozen = false): BoardDiffData => ({
  contestId: 'c1',
  version,
  frozen,
  rows,
});

describe('C-03: patching the board with diffs (FR-BOARD-04)', () => {
  it('ties share a rank, ordered by handle', () => {
    const r = rankRows([
      row('1', 'zed', 5),
      row('2', 'amy', 5),
      row('3', 'bob', 9),
      row('4', 'cy', 1),
    ]);
    expect(r.map((x) => [x.handle, x.rank])).toEqual([
      ['bob', 1],
      ['amy', 2],
      ['zed', 2],
      ['cy', 4],
    ]);
  });

  it('a changed row replaces its old version and the others re-rank', () => {
    const b = board([row('1', 'amy', 9), row('2', 'bob', 5), row('3', 'cy', 1)]);
    const { board: next } = applyDiff(b, diff([row('3', 'cy', 20)], 2));
    expect(next.rows.map((r) => [r.handle, r.rank])).toEqual([
      ['cy', 1],
      ['amy', 2],
      ['bob', 3],
    ]);
    expect(next.version).toBe(2);
  });

  it('a diff that is not newer than the snapshot changes nothing, and replays are harmless', () => {
    const b = board([row('1', 'amy', 9)], 5);
    expect(applyDiff(b, diff([row('1', 'amy', 99)], 5)).board).toBe(b);
    expect(applyDiff(b, diff([row('1', 'amy', 99)], 3)).board).toBe(b);
    const once = applyDiff(b, diff([row('1', 'amy', 99)], 6)).board;
    expect(applyDiff(once, diff([row('1', 'amy', 99)], 6)).board).toBe(once);
  });

  it('a new participant appears', () => {
    const b = board([row('1', 'amy', 9)]);
    expect(applyDiff(b, diff([row('2', 'bob', 0)], 2)).board.rows).toHaveLength(2);
  });

  it('solve counts and first solves follow the cells; a new first flashes', () => {
    const b = board([row('1', 'amy', 0), row('2', 'bob', 0)]);
    const a = applyDiff(
      b,
      diff([row('2', 'bob', 5, { A: cell({ acMinute: 12, first: true }) })], 2),
    );
    expect(a.board.problems[0]).toEqual({ label: 'A', solvedCount: 1, firstSolverId: '2' });
    expect(a.newFirsts).toEqual(['2:A']);
    const c = applyDiff(
      a.board,
      diff([row('1', 'amy', 6, { A: cell({ acMinute: 3, first: true }) })], 3),
    );
    expect(c.board.problems[0]).toEqual({ label: 'A', solvedCount: 2, firstSolverId: '1' });
    expect(c.board.rows.find((r) => r.userId === '2')!.cells.A!.first).toBe(false);
    expect(c.resync).toBe(false);
  });

  it('a first solve that disappears (a rejudge) asks for a fresh snapshot', () => {
    const b = board([row('1', 'amy', 5, { A: cell({ acMinute: 3, first: true }) })]);
    b.problems[0] = { label: 'A', solvedCount: 1, firstSolverId: '1' };
    const r = applyDiff(b, diff([row('1', 'amy', 0, { A: cell({ attempts: 1 }) })], 2));
    expect(r.resync).toBe(true);
  });

  it('the public view becoming frozen is remembered', () => {
    const b = board([row('1', 'amy', 5)]);
    expect(applyDiff(b, diff([row('1', 'amy', 5)], 2, true)).board.frozen).toBe(true);
  });

  it('cells are described in words for screen readers', () => {
    expect(describeCell(cell({ acMinute: 30, attempts: 2, first: true }))).toBe(
      'Solved at minute 30, 2 rejected attempts, first to solve',
    );
    expect(describeCell(cell({ attempts: 1, pending: 2 }))).toBe('1 rejected attempt, 2 pending');
    expect(describeCell(cell())).toBe('Not attempted');
  });
});
