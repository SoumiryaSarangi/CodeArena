import type {
  JudgeProgress,
  SubmissionQueueData,
  SubmissionVerdictData,
  Verdict,
} from '@codearena/contracts';
import type { GridTest } from '@/components/verdict-grid';
import type { RealtimeEvent } from './realtime';

/** What the Tests tab knows about one submission, built up from its SSE events (SD-§10). */
export interface LiveSubmission {
  id: string;
  phase: 'queued' | 'claimed' | 'compiling' | 'running' | 'done';
  lane?: string;
  position?: number;
  etaSeconds?: number;
  capped?: boolean;
  workerId?: string;
  total: number;
  /** Outcomes reported so far, by test number. */
  tests: Record<number, { verdict: Verdict; timeMs: number; memKb: number }>;
  verdict?: Verdict;
  status?: 'done' | 'failed';
  failedTest?: number | null;
  timeMs?: number;
  memKb?: number;
}

export const startSubmission = (
  id: string,
  total: number,
  queue?: { lane?: string; position?: number; etaSeconds?: number },
): LiveSubmission => ({ id, phase: 'queued', total, tests: {}, ...queue });

const PHASE_RANK = { queued: 0, claimed: 1, compiling: 2, running: 3, done: 4 } as const;

/** Applies one event. Events for other submissions, and older phases arriving late, change nothing. */
export function applyEvent(s: LiveSubmission, e: RealtimeEvent): LiveSubmission {
  if (e.topic !== `sub:${s.id}`) return s;
  if (e.type === 'submission.queue') {
    if (s.phase !== 'queued') return s; // a stale position after a judge took the job
    const d = e.data as unknown as SubmissionQueueData;
    return { ...s, lane: d.lane, position: d.position, etaSeconds: d.etaSeconds, capped: d.capped };
  }
  if (e.type === 'submission.progress') {
    const d = e.data as unknown as JudgeProgress;
    if (s.verdict) return s;
    const next = { ...s, workerId: d.workerId };
    const phase = d.phase === 'done' ? s.phase : d.phase;
    if (PHASE_RANK[phase] > PHASE_RANK[s.phase]) next.phase = phase;
    if (d.test) {
      next.tests = {
        ...s.tests,
        [d.test.no]: { verdict: d.test.verdict, timeMs: d.test.timeMs, memKb: d.test.memKb },
      };
      next.phase = 'running';
    }
    return next;
  }
  if (e.type === 'submission.verdict') {
    const d = e.data as unknown as SubmissionVerdictData;
    return {
      ...s,
      phase: 'done',
      verdict: d.verdict,
      status: d.status,
      failedTest: d.failedTest,
      timeMs: d.timeMs,
      memKb: d.memKb,
    };
  }
  return s;
}

/** The squares of the verdict grid: reported tests, the next one running, the rest pending. */
export function gridTests(s: LiveSubmission): GridTest[] {
  const total = Math.max(s.total, ...Object.keys(s.tests).map(Number), 0);
  const reported = Object.keys(s.tests).length;
  return Array.from({ length: total }, (_, i) => {
    const no = i + 1;
    const t = s.tests[no];
    if (t) return { no, state: t.verdict, timeMs: t.timeMs, memKb: t.memKb };
    const running = s.phase === 'running' && !s.verdict && no === reported + 1;
    return { no, state: running ? 'running' : 'pending' };
  });
}

const eta = (sec: number) => (sec >= 90 ? `~${Math.round(sec / 60)} min` : `~${sec} s`);

/** The one line under the grid (UI_UX §7 QueueStatus). Mono, short, always words. */
export function queueLine(s: LiveSubmission): string {
  if (s.phase === 'done') return '';
  if (s.phase === 'queued') {
    if (s.position === undefined) return 'Queued…';
    if (s.position === 0) return 'Waiting for a judge…';
    return `#${s.capped ? '100+' : s.position} in queue · ETA ${eta(s.etaSeconds ?? 0)}`;
  }
  const who = s.workerId ?? 'a judge';
  if (s.phase === 'claimed') return `Judging on ${who}`;
  if (s.phase === 'compiling') return `Judging on ${who} · compiling`;
  return `Judging on ${who} · ${Object.keys(s.tests).length}/${s.total}`;
}
