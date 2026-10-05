'use client';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';

const ANNOUNCE_AT = [900, 300, 60]; // 15, 5, 1 minute (UI_UX §7)

export function timerTone(secondsLeft: number): 'normal' | 'warning' | 'danger' {
  if (secondsLeft <= 60) return 'danger';
  if (secondsLeft <= 300) return 'warning';
  return 'normal';
}

/** Counts down to `endsAt` (epoch ms). Visual `aria-live=off`; milestones go to a polite region. */
export function Timer({ endsAt, className }: { endsAt: number; className?: string }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setLeft(s);
      if (ANNOUNCE_AT.includes(s))
        setAnnouncement(`${s / 60} minute${s === 60 ? '' : 's'} remaining`);
      if (s === 0) setAnnouncement('Time is up');
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  const tone = timerTone(left);
  return (
    <>
      <span
        aria-live="off"
        className={cn(
          'font-mono tabular-nums',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
          className,
        )}
      >
        {formatDuration(left)}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
