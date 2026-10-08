'use client';
import { EXAM_MAX_STRIKES, type ContestExamState, type LeaveResult } from '@codearena/contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { finishExam, reportLeave } from './contests';

/**
 * Exam mode (C-10) in the browser. The server counts and decides; this file only watches the
 * window and shows what the server said. Phases: `gate` (before "Start the test", also after a
 * reload) → `armed` (the test is running and leaving the window counts) → `warning` (a leave was
 * counted; nothing counts until the contestant continues) → back to `armed`, or `finished`.
 */
export type ExamPhase = 'gate' | 'armed' | 'warning' | 'finished';
export type ExamReason = 'self' | 'left-window';

export interface ExamState {
  phase: ExamPhase;
  strikes: number;
  reason: ExamReason | null;
}

export type ExamAction =
  | { type: 'sync'; exam: ContestExamState | null }
  | { type: 'start' }
  | { type: 'left' }
  | { type: 'counted'; result: LeaveResult }
  | { type: 'continue' }
  | { type: 'finished'; reason: ExamReason };

export const initialExam: ExamState = { phase: 'gate', strikes: 0, reason: null };

export function examReducer(s: ExamState, a: ExamAction): ExamState {
  switch (a.type) {
    case 'sync': {
      if (!a.exam) return s;
      if (a.exam.finishedAt)
        return { phase: 'finished', strikes: a.exam.strikes, reason: a.exam.finishReason };
      // The server is the source of truth for strikes; the phase only moves on for a finish.
      return { ...s, strikes: Math.max(s.strikes, a.exam.strikes) };
    }
    case 'start':
      return s.phase === 'gate' ? { ...s, phase: 'armed' } : s;
    case 'left':
      // Only an armed test notices a leave; a warning that is already open swallows the rest.
      return s.phase === 'armed' ? { ...s, phase: 'warning' } : s;
    case 'counted': {
      if (a.result.finished)
        return { phase: 'finished', strikes: a.result.strikes, reason: 'left-window' };
      return { ...s, strikes: a.result.strikes };
    }
    case 'continue':
      return s.phase === 'warning' ? { ...s, phase: 'armed' } : s;
    case 'finished':
      return { ...s, phase: 'finished', reason: a.reason };
  }
}

/** The warning text for a counted leave: the 3rd is not a warning but the end. */
export function warningLine(strikes: number): { title: string; body: string } {
  const warnings = EXAM_MAX_STRIKES - 1;
  const n = Math.min(Math.max(strikes, 1), warnings);
  return {
    title: `Warning ${n} of ${warnings}`,
    body:
      n < warnings
        ? 'You left the test window. Stay in this window until you finish.'
        : 'You left the test window again. The next time, your test is submitted and you cannot come back.',
  };
}

/** Leaves closer together than this are one leave (Alt-Tab fires blur and visibilitychange). */
export const COALESCE_MS = 2000;

/** True when a leave at `now` should be reported (not within the coalescing window of the last). */
export const shouldReport = (now: number, last: number | null) =>
  last === null || now - last >= COALESCE_MS;

const fullscreenSupported = () =>
  typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;

/**
 * Watches the window while the test is armed. `enabled` is false for staff, for contests without
 * exam mode and once the contest is over.
 */
export function useExam(slug: string, exam: ContestExamState | null | undefined, enabled: boolean) {
  const [state, dispatch] = useReducer(examReducer, initialExam);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef<number | null>(null);
  const useFullscreen = useRef(true);

  useEffect(() => {
    dispatch({ type: 'sync', exam: exam ?? null });
  }, [exam]);

  const enter = useCallback(async () => {
    if (!fullscreenSupported() || !useFullscreen.current) return;
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      useFullscreen.current = false; // refused: the test still runs, on visibility and focus alone
    }
  }, []);
  const leaveFullscreen = useCallback(() => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  const report = useCallback(async () => {
    const now = Date.now();
    if (!shouldReport(now, last.current)) return;
    last.current = now;
    dispatch({ type: 'left' });
    try {
      dispatch({ type: 'counted', result: await reportLeave(slug) });
    } catch {
      /* the warning is already shown; the server missed this one, which is the safe direction */
    }
  }, [slug]);

  useEffect(() => {
    if (!enabled || state.phase !== 'armed') return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void report();
    };
    const onBlur = () => void report();
    const onFullscreen = () => {
      if (useFullscreen.current && fullscreenSupported() && !document.fullscreenElement) {
        void report();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [enabled, state.phase, report]);

  // The test ended elsewhere (another tab, or the third strike): leave full screen.
  useEffect(() => {
    if (state.phase === 'finished') leaveFullscreen();
  }, [state.phase, leaveFullscreen]);

  const start = useCallback(async () => {
    await enter(); // entering full screen is not a leave: that event has a fullscreenElement
    dispatch({ type: 'start' });
  }, [enter]);
  const resume = useCallback(async () => {
    await enter();
    dispatch({ type: 'continue' });
  }, [enter]);
  const finish = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await finishExam(slug);
      dispatch({ type: 'finished', reason: 'self' });
      return true;
    } catch {
      setError('Could not submit the test. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [slug]);
  const markFinished = useCallback(
    () => dispatch({ type: 'finished', reason: state.reason ?? 'self' }),
    [state.reason],
  );

  return { state, busy, error, start, resume, finish, markFinished };
}
