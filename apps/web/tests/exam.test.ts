import { describe, expect, it } from 'vitest';
import {
  COALESCE_MS,
  examReducer,
  initialExam,
  shouldReport,
  warningLine,
  type ExamAction,
  type ExamState,
} from '@/lib/exam';

const run = (actions: ExamAction[], from: ExamState = initialExam) =>
  actions.reduce(examReducer, from);
const counted = (strikes: number, finished = false): ExamAction => ({
  type: 'counted',
  result: { strikes, remaining: Math.max(0, 3 - strikes), finished, counted: true },
});

describe('FR-EXAM-02: the strike state machine', () => {
  it('starts at the gate and only "start" arms the test', () => {
    expect(initialExam.phase).toBe('gate');
    expect(run([{ type: 'left' }]).phase).toBe('gate'); // leaving before the test counts for nothing
    expect(run([{ type: 'start' }]).phase).toBe('armed');
  });

  it('a leave while armed opens a warning; the server count fills in the strikes', () => {
    const s = run([{ type: 'start' }, { type: 'left' }, counted(1)]);
    expect(s).toEqual({ phase: 'warning', strikes: 1, reason: null });
  });

  it('nothing counts while a warning is open, and "continue" re-arms', () => {
    const s = run([{ type: 'start' }, { type: 'left' }, { type: 'left' }, { type: 'left' }]);
    expect(s.phase).toBe('warning');
    expect(run([{ type: 'continue' }], s).phase).toBe('armed');
    expect(run([{ type: 'continue' }]).phase).toBe('gate'); // nothing to continue
  });

  it('two warnings, then the third leave finishes the test as left-window', () => {
    const s = run([
      { type: 'start' },
      { type: 'left' },
      counted(1),
      { type: 'continue' },
      { type: 'left' },
      counted(2),
      { type: 'continue' },
      { type: 'left' },
      counted(3, true),
    ]);
    expect(s).toEqual({ phase: 'finished', strikes: 3, reason: 'left-window' });
  });

  it('a finished test stays finished whatever happens next', () => {
    const done = run([{ type: 'finished', reason: 'self' }]);
    expect(done.phase).toBe('finished');
    expect(run([{ type: 'start' }, { type: 'left' }, { type: 'continue' }], done).phase).toBe(
      'finished',
    );
  });
});

describe('FR-EXAM-03: the server state wins (reload, another tab)', () => {
  const sync = (
    finishedAt: string | null,
    strikes: number,
    reason: 'self' | 'left-window' | null,
  ) =>
    ({ type: 'sync', exam: { finishedAt, finishReason: reason, strikes, maxStrikes: 3 } }) as const;

  it('a finished test from the server finishes this tab', () => {
    expect(run([sync('2026-10-10T14:00:00Z', 3, 'left-window')])).toEqual({
      phase: 'finished',
      strikes: 3,
      reason: 'left-window',
    });
  });

  it('after a reload the strikes are kept but the test waits at the gate again, with no new strike', () => {
    const s = run([sync(null, 2, null)]);
    expect(s).toEqual({ phase: 'gate', strikes: 2, reason: null });
  });

  it('a missing exam state (no exam mode) changes nothing', () => {
    expect(run([{ type: 'sync', exam: null }])).toEqual(initialExam);
  });
});

describe('FR-EXAM-02: coalescing and wording', () => {
  it('two events inside the window are one leave', () => {
    expect(shouldReport(1000, null)).toBe(true);
    expect(shouldReport(1000 + COALESCE_MS - 1, 1000)).toBe(false);
    expect(shouldReport(1000 + COALESCE_MS, 1000)).toBe(true);
  });

  it('the warnings are numbered 1 and 2 of 2 and the second says what comes next', () => {
    expect(warningLine(1).title).toBe('Warning 1 of 2');
    expect(warningLine(2).title).toBe('Warning 2 of 2');
    expect(warningLine(2).body).toContain('next time, your test is submitted');
    expect(warningLine(1).body).not.toContain('submitted');
  });
});
