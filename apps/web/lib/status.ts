'use client';
import type { PlatformStatus, PublicVerdicts } from '@codearena/contracts';
import { useEffect, useState } from 'react';
import { apiFetch } from './api';

export const platformStatus = (signal?: AbortSignal) =>
  apiFetch<PlatformStatus>('GET', '/status', undefined, { signal });

/** The platform status, re-read every `everyMs`; `null` until the first answer, `'error'` when it cannot be read. */
export function usePlatformStatus(everyMs: number): PlatformStatus | 'error' | null {
  const [state, setState] = useState<PlatformStatus | 'error' | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const load = () =>
      platformStatus(ctl.signal)
        .then(setState)
        .catch((e: unknown) => {
          if ((e as Error).name !== 'AbortError') setState('error');
        });
    void load();
    const t = setInterval(load, everyMs);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [everyMs]);
  return state;
}

export const publicVerdicts = (signal?: AbortSignal) =>
  apiFetch<PublicVerdicts>('GET', '/status/verdicts', undefined, { signal });

/**
 * The landing page's live strip (UI-16): the last public practice verdicts, re-read every `everyMs`
 * until `paused`. `null` until the first answer and after a failure, so the strip can simply hide.
 */
export function usePublicVerdicts(everyMs: number, paused: boolean): PublicVerdicts | null {
  const [state, setState] = useState<PublicVerdicts | null>(null);
  useEffect(() => {
    if (paused) return;
    const ctl = new AbortController();
    const load = () =>
      publicVerdicts(ctl.signal)
        .then(setState)
        .catch((e: unknown) => {
          if ((e as Error).name !== 'AbortError') setState(null);
        });
    void load();
    const t = setInterval(load, everyMs);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [everyMs, paused]);
  return state;
}
