import type { SubmissionDetail } from '@codearena/contracts';

export interface JourneyStep {
  key: 'submitted' | 'claimed' | 'compiled' | 'tests' | 'verdict';
  label: string;
  /** What happened, in words (judge name, duration, counts). */
  detail?: string;
  /** ISO time the step began, when known. */
  at?: string;
  /** "+1.8 s" since the submission was made, when known. */
  relative?: string;
  state: 'done' | 'current' | 'pending' | 'failed';
}

/** `+850 ms`, `+1.8 s`, `+1:05` (UI_UX §7 JourneyTimeline). */
export function formatRelative(ms: number): string {
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `+${n} ms`;
  if (n < 60_000) return `+${(n / 1000).toFixed(1)} s`;
  const s = Math.round(n / 1000);
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A duration without the plus: `850 ms`, `1.6 s`. */
export const formatSpan = (ms: number) => formatRelative(ms).slice(1);

/**
 * The steps a submission went through (PRD US-3.3): submitted (lane), claimed by which judge,
 * compiled (how long), tests, verdict published, each with when it began. Timings come from the
 * worker's progress events, kept with the verdict; a submission without them still gets the steps
 * it can prove (submitted, verdict) and says the rest were not recorded.
 */
export function buildJourney(d: SubmissionDetail): { steps: JourneyStep[]; recorded: boolean } {
  const t = (phase: string) => d.journey.steps.find((s) => s.phase === phase)?.at;
  const ms = (iso?: string) => (iso ? Date.parse(iso) : undefined);
  const start = Date.parse(d.journey.submittedAt);
  const rel = (iso?: string) => (iso ? formatRelative(Date.parse(iso) - start) : undefined);
  const finished = d.status === 'done' || d.status === 'failed';
  const recorded = d.journey.steps.length > 0;

  const claimed = t('claimed');
  const compiling = t('compiling');
  const running = t('running');
  const done = t('done');
  const compileMs =
    ms(running) !== undefined && ms(compiling) !== undefined
      ? ms(running)! - ms(compiling)!
      : undefined;
  const testMs =
    ms(done) !== undefined && ms(running) !== undefined ? ms(done)! - ms(running)! : undefined;
  const ce = d.verdict === 'CE';
  const passed = d.tests.filter((x) => x.verdict === 'AC').length;

  const steps: JourneyStep[] = [
    {
      key: 'submitted',
      label: 'Submitted',
      detail: `Lane: ${d.lane}`,
      at: d.journey.submittedAt,
      relative: '+0 ms',
      state: 'done',
    },
  ];
  if (recorded) {
    steps.push({
      key: 'claimed',
      label: 'Claimed',
      detail: d.journey.workerId ? `by ${d.journey.workerId}` : undefined,
      at: claimed,
      relative: rel(claimed),
      state: claimed ? 'done' : 'pending',
    });
    steps.push({
      key: 'compiled',
      label: ce ? 'Compilation failed' : 'Compiled',
      detail: compileMs !== undefined ? `in ${formatSpan(compileMs)}` : undefined,
      at: compiling,
      relative: rel(compiling),
      state: ce ? 'failed' : compiling ? 'done' : 'pending',
    });
    if (!ce) {
      steps.push({
        key: 'tests',
        label: 'Tests',
        detail:
          d.tests.length === 0
            ? undefined
            : d.failedTest
              ? `${passed} passed, stopped at test ${d.failedTest}${testMs !== undefined ? ` · ${formatSpan(testMs)}` : ''}`
              : `${d.tests.length}/${d.tests.length} passed${testMs !== undefined ? ` · ${formatSpan(testMs)}` : ''}`,
        at: running,
        relative: rel(running),
        state: running ? (finished ? 'done' : 'current') : 'pending',
      });
    }
  }
  steps.push({
    key: 'verdict',
    label: 'Verdict published',
    detail: d.verdict ? `${d.verdict}${d.failedTest ? ` on test ${d.failedTest}` : ''}` : undefined,
    at: finished ? (d.journey.judgedAt ?? done) : undefined,
    relative: finished ? rel(d.journey.judgedAt ?? done) : undefined,
    state: finished ? (d.status === 'failed' ? 'failed' : 'done') : 'pending',
  });
  return { steps, recorded };
}
