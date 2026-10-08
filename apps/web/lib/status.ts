'use client';
import type { PlatformStatus } from '@codearena/contracts';
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
