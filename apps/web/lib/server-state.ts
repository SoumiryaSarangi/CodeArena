'use client';
import { useEffect, useState } from 'react';

/**
 * Is the API answering? The site on Vercel stays up when the servers are off (UI-23), so every page can
 * tell visitors why sign-in, problems and contests do not work instead of showing bare errors.
 *
 *  - NEXT_PUBLIC_DEMO_PAUSED=true (set on Vercel while the Azure servers are deleted or off) says so
 *    without asking: the notice uses the "paused" wording and nothing is probed.
 *  - Otherwise `/api/health/live` is asked once per page load. Two failures 3 s apart (a refused connection,
 *    a timeout after 6 s, or a 5xx) make the state `down`; then it is asked every 15 s until it answers.
 */
export type ServerState = 'checking' | 'up' | 'down';

export const RETRY_MS = 3_000;
export const RECHECK_MS = 15_000;
export const PROBE_TIMEOUT_MS = 6_000;
/** A tab that comes back to the foreground asks again only if the last answer is older than this. */
export const STALE_MS = 60_000;

export const demoPaused = () => process.env.NEXT_PUBLIC_DEMO_PAUSED === 'true';

/** True when the API answered with anything but a server error. */
export async function probeOnce(
  fetcher: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher('/api/health/live', { cache: 'no-store', signal: ctl.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function useServerState(): ServerState {
  const [state, setState] = useState<ServerState>(() => (demoPaused() ? 'down' : 'checking'));

  useEffect(() => {
    if (demoPaused()) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = Date.now();

    const check = async (second = false) => {
      const ok = await probeOnce();
      if (!alive) return;
      last = Date.now();
      if (ok) return setState('up');
      if (!second) {
        timer = setTimeout(() => void check(true), RETRY_MS);
        return;
      }
      setState('down');
      timer = setTimeout(() => void check(true), RECHECK_MS);
    };
    void check();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > STALE_MS) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return state;
}
