import { describe, expect, it } from 'vitest';
import {
  DRAFT_DEBOUNCE_MS,
  clearDraft,
  loadDraft,
  loadLanguage,
  saveDraft,
  saveLanguage,
} from '@/lib/drafts';
import { LANGUAGES, languageInfo } from '@/lib/languages';
import { lineDiff } from '@/lib/line-diff';
import {
  applyEvent,
  gridTests,
  queueLine,
  startSubmission,
  type LiveSubmission,
} from '@/lib/live-submission';
import type { RealtimeEvent } from '@/lib/realtime';
import { safeReturnTo } from '@/lib/return-to';
import { handleProblem, suggestHandle } from '@/components/auth/onboarding';

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
};

describe('UI-02: drafts (per problem and language)', () => {
  it('saves and restores per problem+language, starting from the language template', () => {
    const s = mem();
    expect(loadDraft('a-plus-b', 'python3', s)).toBe(languageInfo('python3').template);
    saveDraft('a-plus-b', 'python3', 'print(1)', s);
    saveDraft('a-plus-b', 'cpp17', 'int main(){}', s);
    saveDraft('other', 'python3', 'print(2)', s);
    expect(loadDraft('a-plus-b', 'python3', s)).toBe('print(1)');
    expect(loadDraft('a-plus-b', 'cpp17', s)).toBe('int main(){}');
    expect(loadDraft('other', 'python3', s)).toBe('print(2)');
    clearDraft('a-plus-b', 'python3', s);
    expect(loadDraft('a-plus-b', 'python3', s)).toBe(languageInfo('python3').template);
    expect(s.m.has('draft:a-plus-b:python3')).toBe(false);
  });

  it('remembers the last language per problem', () => {
    const s = mem();
    expect(loadLanguage('p', 'cpp17', s)).toBe('cpp17');
    saveLanguage('p', 'java21', s);
    expect(loadLanguage('p', 'cpp17', s)).toBe('java21');
  });

  it('never throws when storage is missing or broken, and refuses oversized drafts', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadDraft('p', 'c', broken)).toBe(languageInfo('c').template);
    expect(() => saveDraft('p', 'c', 'x', broken)).not.toThrow();
    expect(() => clearDraft('p', 'c', broken)).not.toThrow();
    expect(loadLanguage('p', 'c', broken)).toBe('c');
    expect(loadDraft('p', 'c', null)).toBe(languageInfo('c').template);
    const s = mem();
    saveDraft('p', 'c', 'x'.repeat(64 * 1024 + 1), s);
    expect(s.m.size).toBe(0);
    expect(DRAFT_DEBOUNCE_MS).toBe(500);
  });

  it('has a template for every language the judge accepts', () => {
    expect(LANGUAGES.map((l) => l.id).sort()).toEqual([
      'c',
      'cpp17',
      'cpp20',
      'java21',
      'node',
      'python3',
    ]);
    for (const l of LANGUAGES) expect(l.template.length).toBeGreaterThan(10);
    expect(languageInfo('java21').template).toContain('class Main');
  });
});

describe('UI-02: sample diff (FR-SUB-05)', () => {
  it('compares line by line and ignores trailing whitespace and blank lines', () => {
    const d = lineDiff('3\n7 \n', '3\n7\n\n\n');
    expect(d).toEqual([
      { no: 1, expected: '3', actual: '3', same: true },
      { no: 2, expected: '7', actual: '7', same: true },
    ]);
  });
  it('shows a wrong, a missing and an extra line', () => {
    const d = lineDiff('1\n2\n3', '1\n9');
    expect(d.map((l) => l.same)).toEqual([true, false, false]);
    expect(d[2]).toEqual({ no: 3, expected: '3', actual: null, same: false });
    expect(lineDiff('1', '1\n2')[1]).toEqual({ no: 2, expected: null, actual: '2', same: false });
    expect(lineDiff('a\r\nb', 'a\nb').every((l) => l.same)).toBe(true);
  });
});

const ev = (
  type: RealtimeEvent['type'],
  data: object,
  id = 'x',
  topic = 'sub:S1',
): RealtimeEvent => ({
  id,
  topic,
  type,
  ts: 1,
  data: data as Record<string, unknown>,
});
const progress = (phase: string, extra: object = {}) =>
  ev('submission.progress', {
    submissionId: 'S1',
    runVersion: 1,
    phase,
    workerId: 'judge-2',
    ts: 1,
    ...extra,
  });
const test = (no: number, verdict = 'AC') =>
  progress('running', { test: { no, verdict, timeMs: no * 10, memKb: 2048 } });

describe('UI-02: live submission (SSE events → grid and queue line)', () => {
  const start = () => startSubmission('S1', 4, { lane: 'practice', position: 3, etaSeconds: 5 });

  it('queued: shows position and ETA, then updates from submission.queue events', () => {
    let s: LiveSubmission = start();
    expect(queueLine(s)).toBe('#3 in queue · ETA ~5 s');
    s = applyEvent(
      s,
      ev('submission.queue', { lane: 'practice', position: 1, etaSeconds: 95, capped: false }),
    );
    expect(queueLine(s)).toBe('#1 in queue · ETA ~2 min');
    s = applyEvent(
      s,
      ev('submission.queue', { lane: 'practice', position: 100, etaSeconds: 300, capped: true }),
    );
    expect(queueLine(s)).toBe('#100+ in queue · ETA ~5 min');
    s = applyEvent(
      s,
      ev('submission.queue', { lane: 'practice', position: 0, etaSeconds: 0, capped: false }),
    );
    expect(queueLine(s)).toBe('Waiting for a judge…');
    expect(queueLine(startSubmission('S1', 4))).toBe('Queued…');
  });

  it('judging: claimed → compiling → running n/total, and the grid fills in order', () => {
    let s = start();
    s = applyEvent(s, progress('claimed'));
    expect(queueLine(s)).toBe('Judging on judge-2');
    s = applyEvent(s, progress('compiling'));
    expect(queueLine(s)).toBe('Judging on judge-2 · compiling');
    expect(gridTests(s).map((t) => t.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
    s = applyEvent(s, progress('running'));
    expect(gridTests(s).map((t) => t.state)).toEqual(['running', 'pending', 'pending', 'pending']);
    s = applyEvent(s, test(1));
    s = applyEvent(s, test(2, 'WA'));
    expect(queueLine(s)).toBe('Judging on judge-2 · 2/4');
    expect(gridTests(s).map((t) => t.state)).toEqual(['AC', 'WA', 'running', 'pending']);
    expect(gridTests(s)[1]).toMatchObject({ no: 2, timeMs: 20, memKb: 2048 });
  });

  it('the verdict closes it: phase done, no queue line, tests not reported stay pending', () => {
    let s = applyEvent(start(), test(1));
    s = applyEvent(
      s,
      ev('submission.verdict', {
        submissionId: 'S1',
        runVersion: 1,
        status: 'done',
        verdict: 'WA',
        timeMs: 30,
        memKb: 2048,
        failedTest: 2,
      }),
    );
    expect(s).toMatchObject({ phase: 'done', verdict: 'WA', failedTest: 2, status: 'done' });
    expect(queueLine(s)).toBe('');
    expect(gridTests(s).map((t) => t.state)).toEqual(['AC', 'pending', 'pending', 'pending']);
    // late progress or queue events after the verdict change nothing
    expect(applyEvent(s, progress('running'))).toBe(s);
    expect(
      applyEvent(
        s,
        ev('submission.queue', { lane: 'practice', position: 5, etaSeconds: 1, capped: false }),
      ).position,
    ).toBe(3);
  });

  it('ignores events for another submission and phases that arrive out of order', () => {
    const s = applyEvent(start(), test(1));
    expect(
      applyEvent(
        s,
        ev('submission.progress', { phase: 'claimed', workerId: 'x' }, 'i', 'sub:OTHER'),
      ),
    ).toBe(s);
    const back = applyEvent(s, progress('claimed'));
    expect(back.phase).toBe('running');
    expect(applyEvent(s, ev('board.diff', {}))).toBe(s);
  });

  it('a stale queue event after a judge took the job does not bring the position back', () => {
    let s = applyEvent(start(), progress('claimed'));
    s = applyEvent(
      s,
      ev('submission.queue', { lane: 'practice', position: 2, etaSeconds: 4, capped: false }),
    );
    expect(s.position).toBe(3);
    expect(queueLine(s)).toBe('Judging on judge-2');
  });

  it('grows the grid if more tests report than expected', () => {
    const s = applyEvent(startSubmission('S1', 1), test(3));
    expect(gridTests(s)).toHaveLength(3);
  });
});

describe('UI-02: sign-in helpers', () => {
  it('safeReturnTo only allows same-site paths', () => {
    expect(safeReturnTo('/p/a-plus-b')).toBe('/p/a-plus-b');
    for (const bad of [
      '//evil.com',
      '/\\evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      '/x\ny',
      '',
      null,
      undefined,
    ])
      expect(safeReturnTo(bad as string)).toBe('/practice');
    expect(safeReturnTo('/' + 'a'.repeat(600))).toBe('/practice');
  });

  it('FR-AUTH-03: explains a bad or reserved handle before asking the server', () => {
    expect(handleProblem('ab')).toMatch(/3–20 characters/);
    expect(handleProblem('1abc')).toMatch(/starting with a letter/);
    expect(handleProblem('Upper')).toMatch(/a–z/);
    expect(handleProblem('admin')).toBe('That handle is reserved.');
    expect(handleProblem('riya_k')).toBeNull();
    expect(suggestHandle('riya_k')).toBe('riya_k_k2');
    expect(suggestHandle('a'.repeat(20))).toHaveLength(20);
    expect(handleProblem(suggestHandle('a'.repeat(20)))).toBeNull();
  });
});
