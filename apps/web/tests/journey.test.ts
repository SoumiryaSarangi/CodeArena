import type { SubmissionDetail } from '@codearena/contracts';
import { describe, expect, it } from 'vitest';
import { buildJourney, formatRelative, formatSpan } from '@/lib/journey';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const detail = (
  over: Partial<SubmissionDetail> = {},
  steps: [string, number][] = [],
): SubmissionDetail =>
  ({
    id: 's1',
    problemSlug: 'p',
    problemTitle: 'P',
    language: 'cpp17',
    status: 'done',
    verdict: 'AC',
    timeMs: 40,
    memKb: 2048,
    failedTest: null,
    lane: 'practice',
    createdAt: iso(0),
    source: 'x',
    problemVersion: 1,
    runVersion: 1,
    tests: [
      { no: 1, verdict: 'AC', timeMs: 3, memKb: 1000, checkerMsg: null },
      { no: 2, verdict: 'AC', timeMs: 4, memKb: 1000, checkerMsg: null },
    ],
    compileLog: null,
    journey: {
      submittedAt: iso(0),
      judgedAt: iso(4200),
      workerId: 'judge-2',
      steps: steps.map(([phase, at]) => ({
        phase,
        at: iso(at),
      })) as SubmissionDetail['journey']['steps'],
    },
    ...over,
  }) as SubmissionDetail;

const FULL: [string, number][] = [
  ['claimed', 1800],
  ['compiling', 1900],
  ['running', 3500],
  ['done', 4100],
];

describe('UI-03: relative times (UI_UX §7)', () => {
  it('formats milliseconds, seconds and minutes', () => {
    expect(formatRelative(0)).toBe('+0 ms');
    expect(formatRelative(850)).toBe('+850 ms');
    expect(formatRelative(1800)).toBe('+1.8 s');
    expect(formatRelative(59_949)).toBe('+59.9 s');
    expect(formatRelative(65_000)).toBe('+1:05');
    expect(formatRelative(-5)).toBe('+0 ms');
    expect(formatSpan(1600)).toBe('1.6 s');
  });
});

describe('UI-03 / US-3.3: the journey', () => {
  it('lists submitted, claimed by which judge, compiled in how long, tests, verdict, each with when', () => {
    const { steps, recorded } = buildJourney(detail({}, FULL));
    expect(recorded).toBe(true);
    expect(steps.map((s) => s.label)).toEqual([
      'Submitted',
      'Claimed',
      'Compiled',
      'Tests',
      'Verdict published',
    ]);
    expect(steps.map((s) => s.relative)).toEqual(['+0 ms', '+1.8 s', '+1.9 s', '+3.5 s', '+4.2 s']);
    expect(steps[0]!.detail).toBe('Lane: practice');
    expect(steps[1]!.detail).toBe('by judge-2');
    expect(steps[2]!.detail).toBe('in 1.6 s');
    expect(steps[3]!.detail).toBe('2/2 passed · 600 ms');
    expect(steps[4]!.detail).toBe('AC');
    expect(steps.every((s) => s.state === 'done')).toBe(true);
    expect(steps[1]!.at).toBe(iso(1800));
  });

  it('a wrong answer says where it stopped', () => {
    const d = detail(
      {
        verdict: 'WA',
        failedTest: 2,
        tests: [
          { no: 1, verdict: 'AC', timeMs: 3, memKb: 1, checkerMsg: null },
          { no: 2, verdict: 'WA', timeMs: 4, memKb: 1, checkerMsg: null },
        ],
      },
      FULL,
    );
    const { steps } = buildJourney(d);
    expect(steps.find((s) => s.key === 'tests')!.detail).toBe(
      '1 passed, stopped at test 2 · 600 ms',
    );
    expect(steps.at(-1)!.detail).toBe('WA on test 2');
  });

  it('a compile error has no test step and marks compilation failed', () => {
    const { steps } = buildJourney(
      detail({ verdict: 'CE', tests: [], compileLog: 'error' }, [
        ['claimed', 1000],
        ['compiling', 1100],
        ['done', 2000],
      ]),
    );
    expect(steps.map((s) => s.key)).toEqual(['submitted', 'claimed', 'compiled', 'verdict']);
    expect(steps.find((s) => s.key === 'compiled')).toMatchObject({
      label: 'Compilation failed',
      state: 'failed',
    });
  });

  it('without recorded timings it shows only what it can prove', () => {
    const { steps, recorded } = buildJourney(detail());
    expect(recorded).toBe(false);
    expect(steps.map((s) => s.key)).toEqual(['submitted', 'verdict']);
    expect(steps[1]!.relative).toBe('+4.2 s');
  });

  it('a partial timeline (judge died after claiming) leaves later steps pending, not invented', () => {
    const { steps } = buildJourney(
      detail({
        status: 'judging' as never,
        verdict: null,
        tests: [],
        journey: {
          ...detail().journey,
          judgedAt: null,
          steps: [{ phase: 'claimed', at: iso(1000) }],
        },
      }),
    );
    expect(steps.find((s) => s.key === 'claimed')!.state).toBe('done');
    expect(steps.find((s) => s.key === 'compiled')!.state).toBe('pending');
    expect(steps.find((s) => s.key === 'tests')!.state).toBe('pending');
    const last = steps.at(-1)!;
    expect(last).toMatchObject({ state: 'pending', at: undefined, relative: undefined });
  });

  it('a submission the judge could not run (status failed) ends in a failed verdict step', () => {
    const { steps } = buildJourney(detail({ status: 'failed', verdict: 'SE', tests: [] }));
    expect(steps.at(-1)).toMatchObject({ state: 'failed', detail: 'SE' });
  });
});
