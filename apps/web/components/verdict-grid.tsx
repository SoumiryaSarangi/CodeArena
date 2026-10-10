'use client';
import { useEffect, useRef } from 'react';
import type { Verdict } from '@codearena/contracts';
import { cn } from '@/lib/cn';
import { formatMemKb } from '@/lib/format';
import { VERDICTS } from '@/lib/verdicts';

export interface GridTest {
  no: number;
  state: 'pending' | 'running' | Verdict;
  timeMs?: number;
  memKb?: number;
}

const describe = (t: GridTest) => {
  const base = `Test ${t.no}`;
  if (t.state === 'pending') return `${base} · pending`;
  if (t.state === 'running') return `${base} · running`;
  const parts = [base, `${t.state} (${VERDICTS[t.state].name})`];
  if (t.timeMs !== undefined) parts.push(`${t.timeMs} ms`);
  if (t.memKb !== undefined) parts.push(formatMemKb(t.memKb));
  return parts.join(' · ');
};

/**
 * One 12 px square per test. Only the final verdict is announced (a visually hidden polite live
 * region), so screen readers are not flooded per test (UI_UX §7).
 */
export function VerdictGrid({
  tests,
  finalAnnouncement,
}: {
  tests: GridTest[];
  finalAnnouncement?: string;
}) {
  // A swatch pops in only when its state changes while the page is open, never for the whole grid on load.
  const before = useRef<Map<number, GridTest['state']> | null>(null);
  const seen = before.current;
  useEffect(() => {
    before.current = new Map(tests.map((t) => [t.no, t.state]));
  });
  return (
    <div>
      <ul role="list" aria-label="Test results" className="flex flex-wrap gap-[3px]">
        {tests.map((t) => (
          <li
            key={t.no}
            role="listitem"
            tabIndex={0}
            aria-label={describe(t)}
            title={describe(t)}
            className={cn(
              'size-3 rounded-[2px]',
              t.state === 'pending' && 'border border-border-control',
              t.state === 'running' && 'bg-v-pending motion-safe:animate-judging',
              t.state !== 'pending' &&
                t.state !== 'running' &&
                cn(
                  VERDICTS[t.state].swatch,
                  seen && seen.get(t.no) !== t.state && 'motion-safe:animate-fill',
                ),
            )}
          />
        ))}
      </ul>
      <p role="status" aria-live="polite" className="sr-only">
        {finalAnnouncement}
      </p>
    </div>
  );
}
