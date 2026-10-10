'use client';
import { useState } from 'react';
import { VerdictBadge } from '@/components/verdict-badge';
import { Button } from '@/components/ui/button';
import { languageInfo } from '@/lib/languages';
import { usePublicVerdicts } from '@/lib/status';

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90
    ? `${s} s ago`
    : s < 5400
      ? `${Math.round(s / 60)} min ago`
      : `${Math.round(s / 3600)} h ago`;
};

/**
 * The live strip (UI-16, UI_UX S01): the last few finished practice verdicts on public problems, no names.
 * Re-read every 10 s; Pause stops it. It shows nothing at all (not zeros) while there is nothing to show or
 * the API cannot be reached. A list that is replaced in place, not a scrolling marquee, and not announced.
 */
export function VerdictTicker() {
  const [paused, setPaused] = useState(false);
  const data = usePublicVerdicts(10_000, paused);
  if (!data || data.items.length === 0) return null;
  const now = Date.now();
  return (
    <section
      aria-labelledby="live-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="live-heading" className="flex items-center gap-2 text-14 font-medium">
          <span aria-hidden className="size-2 rounded-full bg-success" />
          Live from practice
          <span className="font-normal text-text-2 max-sm:hidden">
            the last {Math.min(6, data.items.length)} verdicts
          </span>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>
      <ul aria-live="off" className="flex flex-col gap-1.5">
        {data.items.slice(0, 6).map((v) => (
          <li
            key={`${v.at}-${v.problemTitle}-${v.language}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-13"
          >
            <span className="w-16 shrink-0 text-text-2">{languageInfo(v.language).label}</span>
            <span
              className="min-w-0 basis-full truncate font-sans text-14 max-sm:order-first sm:flex-1 sm:basis-auto"
              title={v.problemTitle}
            >
              {v.problemTitle}
            </span>
            <VerdictBadge verdict={v.verdict} />
            <span className="w-16 text-right tabular-nums text-text-2">
              {v.timeMs === null ? '' : `${v.timeMs} ms`}
            </span>
            <span className="w-20 text-right text-text-3">{ago(v.at, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
