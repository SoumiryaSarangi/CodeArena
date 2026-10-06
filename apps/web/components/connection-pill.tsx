'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { ConnectionState } from '@/lib/realtime';

/**
 * UI_UX §7: hidden while connected for 2 s or more; "Reconnecting…" (warning), "Offline" (danger),
 * and "Reconnected" (success) for 2 s after a recovery. Always words, never just a colour.
 */
export function ConnectionPill({ state }: { state: ConnectionState }) {
  const [recovered, setRecovered] = useState(false);
  // A ref, not state: changing it must not re-run the effect, or its own cleanup would cancel the
  // timer that hides "Reconnected".
  const wasDown = useRef(false);

  useEffect(() => {
    if (state === 'reconnecting' || state === 'offline') {
      wasDown.current = true;
      setRecovered(false);
      return;
    }
    if (state === 'connected' && wasDown.current) {
      wasDown.current = false;
      setRecovered(true);
      const t = setTimeout(() => setRecovered(false), 2000);
      return () => clearTimeout(t);
    }
  }, [state]);

  const text =
    state === 'offline'
      ? 'Offline'
      : state === 'reconnecting'
        ? 'Reconnecting…'
        : recovered
          ? 'Reconnected'
          : null;
  return (
    <span role="status" aria-live="polite" className="contents">
      {text ? (
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-12',
            state === 'offline'
              ? 'border-danger text-danger'
              : state === 'reconnecting'
                ? 'border-warning text-warning'
                : 'border-success text-success',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'size-1.5 rounded-full',
              state === 'offline'
                ? 'bg-danger'
                : state === 'reconnecting'
                  ? 'bg-warning'
                  : 'bg-success',
            )}
          />
          {text}
        </span>
      ) : null}
    </span>
  );
}
