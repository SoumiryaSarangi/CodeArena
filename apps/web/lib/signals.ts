'use client';
import { PASTE_MIN_CHARS, SIGNAL_BATCH_MAX, type SignalBatch } from '@codearena/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { apiFetch } from './api';

type Event = SignalBatch['events'][number];

/** Two losses of focus this close together are one (Alt-Tab fires `blur` and `visibilitychange` together). */
export const LOSS_DEBOUNCE_MS = 2000;
export const FLUSH_EVERY_MS = 10_000;

/**
 * IN-01 (FR-SIG-01): in a contest problem, reports to the server (a) that the problem was opened, (b) a paste of more
 * than 50 characters (its size, never its content), (c) the window losing and regaining focus. Advisory signals for the
 * plagiarism review; the privacy page says so. Batched, best effort: a failed batch is dropped, never retried, never
 * shown to the contestant. Returns the callback for the editor's paste.
 */
export function useSignals(contest: { slug: string; label: string } | undefined, enabled: boolean) {
  const queue = useRef<Event[]>([]);
  const target = useRef(contest);
  target.current = contest;

  const flush = useCallback(() => {
    const t = target.current;
    if (!t || queue.current.length === 0) return;
    const events = queue.current.splice(0, SIGNAL_BATCH_MAX);
    void apiFetch(
      'POST',
      '/signals',
      { contest: t.slug, problem: t.label, events },
      { auth: 'required' },
    ).catch(() => undefined);
    if (queue.current.length > 0) flush();
  }, []);
  const push = useCallback((e: Omit<Event, 'at'>) => {
    queue.current.push({ ...e, at: new Date().toISOString() });
  }, []);

  const key = contest ? `${contest.slug}/${contest.label}` : '';
  useEffect(() => {
    if (!enabled || !key) return;
    push({ kind: 'problem_open' });
    let lastLoss = 0;
    const lost = (kind: 'blur' | 'tab_hidden') => {
      const now = Date.now();
      if (now - lastLoss < LOSS_DEBOUNCE_MS) return;
      lastLoss = now;
      push({ kind });
      flush();
    };
    const onBlur = () => lost('blur');
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') lost('tab_hidden');
    };
    const onFocus = () => push({ kind: 'focus' });
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    const timer = setInterval(flush, FLUSH_EVERY_MS);
    flush();
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      clearInterval(timer);
      flush();
    };
  }, [enabled, key, push, flush]);

  return useCallback(
    (chars: number) => {
      if (enabled && chars > PASTE_MIN_CHARS) push({ kind: 'paste', size: chars });
    },
    [enabled, push],
  );
}
