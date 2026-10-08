'use client';
import type {
  CreateRun,
  CreateSubmission,
  RunCreated,
  RunResult,
  SubmissionCreated,
  SubmissionDetail,
  SubmissionList,
  SubmissionVerdictData,
} from '@codearena/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api';
import { applyEvent, startSubmission, type LiveSubmission } from '@/lib/live-submission';
import { subscribe, type ConnectionState, type RealtimeEvent } from '@/lib/realtime';

export interface RunView {
  id: string;
  /** "Sample 2" or "Custom input". */
  label: string;
  status: 'queued' | 'done' | 'failed';
  result?: RunResult;
}

export type JudgingError =
  { kind: 'signin' } | { kind: 'handle' } | { kind: 'message'; text: string };

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Math.random());

/**
 * Everything the workspace does with the judge (S05): submit, run, and follow the result over SSE.
 * Submit shows a "Submitting…" row at once (optimistic), then the queue line and the verdict grid
 * fill from `sub:{id}` events; when the verdict arrives the per-test detail is read from the API.
 */
export function useJudging(opts: {
  slug: string;
  /** A contest problem: submissions and runs go to `contestSlug` + `label` (FR-SUB-03). */
  contest?: { slug: string; label: string };
  /** Called when a submission's verdict is in (the arena refreshes its problem states). */
  onVerdict?: () => void;
  testsCount: number;
  samples: { in: string; out: string }[];
  signedIn: boolean;
  hasHandle: boolean;
}) {
  const { slug, testsCount, signedIn, hasHandle, contest } = opts;
  const contestSlug = contest?.slug;
  const contestLabel = contest?.label;
  const onVerdictRef = useRef(opts.onVerdict);
  onVerdictRef.current = opts.onVerdict;
  /** The problem part of a submit or run body. */
  const target = useCallback(
    () =>
      contestSlug && contestLabel ? { contestSlug, label: contestLabel } : { problemSlug: slug },
    [contestSlug, contestLabel, slug],
  );
  const [live, setLive] = useState<LiveSubmission | null>(null);
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<JudgingError | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>('connected');
  const [history, setHistory] = useState<SubmissionList['items'] | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const unsubs = useRef<(() => void)[]>([]);
  const subSubscription = useRef<(() => void) | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const subs = unsubs.current;
    return () => {
      alive.current = false;
      subs.forEach((u) => u());
      subSubscription.current?.();
    };
  }, []);

  // 429 countdown on the Submit button.
  useEffect(() => {
    if (retryIn <= 0) return;
    const t = setTimeout(() => setRetryIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [retryIn]);

  // My submissions on this problem.
  useEffect(() => {
    if (!signedIn) return setHistory(null);
    const c = new AbortController();
    apiFetch<SubmissionList>(
      'GET',
      `/submissions?problem=${encodeURIComponent(slug)}&limit=20`,
      undefined,
      {
        signal: c.signal,
      },
    )
      .then((r) => setHistory(r.items))
      .catch(() => {});
    return () => c.abort();
  }, [slug, signedIn, historyKey]);

  const guard = useCallback((): boolean => {
    if (!signedIn) return (setError({ kind: 'signin' }), false);
    if (!hasHandle) return (setError({ kind: 'handle' }), false);
    setError(null);
    return true;
  }, [signedIn, hasHandle]);

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 429) {
      setRetryIn(err.retryAfter ?? 5);
      return;
    }
    if (err instanceof ApiError && err.code === 'forbidden') return setError({ kind: 'handle' });
    if (err instanceof ApiError && err.status === 401) return setError({ kind: 'signin' });
    setError({
      kind: 'message',
      text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.',
    });
  }, []);

  const finishSubmission = useCallback(async (id: string) => {
    subSubscription.current?.();
    subSubscription.current = null;
    try {
      const d = await apiFetch<SubmissionDetail>('GET', `/submissions/${id}`);
      if (alive.current) setDetail(d);
    } catch {
      // the verdict itself is already on screen; the detail is a bonus
    }
    if (alive.current) setHistoryKey((k) => k + 1);
    onVerdictRef.current?.();
  }, []);

  const submit = useCallback(
    async (language: string, source: string) => {
      if (submitting || retryIn > 0 || !guard()) return;
      setSubmitting(true);
      setDetail(null);
      setLive(startSubmission('pending', testsCount));
      subSubscription.current?.();
      try {
        const body: CreateSubmission = { ...target(), language, source };
        const created = await apiFetch<SubmissionCreated>('POST', '/submissions', body, {
          auth: 'required',
          idempotencyKey: newKey(),
        });
        if (!alive.current) return;
        const start = startSubmission(created.id, testsCount, created);
        setLive(start);
        // Reduce events one at a time against the latest state.
        subSubscription.current = subscribe(
          [`sub:${created.id}`],
          (e: RealtimeEvent) => {
            setLive((s) => (s ? applyEvent(s, e) : s));
            if (e.type === 'submission.verdict') void finishSubmission(created.id);
          },
          setConnection,
        );
      } catch (err) {
        setLive(null);
        fail(err);
      } finally {
        if (alive.current) setSubmitting(false);
      }
    },
    [submitting, retryIn, guard, testsCount, target, finishSubmission, fail],
  );

  const run = useCallback(
    async (language: string, source: string, what: { input: string } | { sampleIds: number[] }) => {
      if (running || !guard()) return;
      setRunning(true);
      try {
        const body: CreateRun = { ...target(), language, source, ...what };
        const created = await apiFetch<RunCreated>('POST', '/runs', body, {
          auth: 'required',
          idempotencyKey: newKey(),
        });
        if (!alive.current) return;
        const labels =
          'sampleIds' in what
            ? [...new Set(what.sampleIds)].map((n) => `Sample ${n}`)
            : ['Custom input'];
        const views: RunView[] = created.runIds.map((id, i) => ({
          id,
          label: labels[i] ?? 'Run',
          status: 'queued',
        }));
        setRuns(views);
        const left = new Set(created.runIds);
        const stop = subscribe(
          created.runIds.map((id) => `sub:${id}`),
          (e) => {
            if (e.type !== 'submission.verdict') return;
            const id = (e.data as unknown as SubmissionVerdictData).submissionId;
            if (!left.delete(id)) return;
            void apiFetch<RunResult>('GET', `/runs/${id}`)
              .then((result) => {
                if (alive.current)
                  setRuns((rs) =>
                    rs.map((r) => (r.id === id ? { ...r, status: 'done', result } : r)),
                  );
              })
              .catch(() => {
                if (alive.current)
                  setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, status: 'failed' } : r)));
              })
              .finally(() => {
                if (left.size === 0) {
                  stop();
                  if (alive.current) setRunning(false);
                }
              });
          },
          setConnection,
        );
        unsubs.current.push(stop);
      } catch (err) {
        setRunning(false);
        fail(err);
      }
    },
    [running, guard, target, fail],
  );

  return {
    live,
    detail,
    submitting,
    runs,
    running,
    error,
    retryIn,
    connection,
    history,
    submit,
    run,
    clearError: () => setError(null),
  };
}
