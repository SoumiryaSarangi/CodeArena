import type { Verdict } from '@codearena/contracts';
import { cn } from '@/lib/cn';
import { VERDICTS, verdictTitle } from '@/lib/verdicts';

/** Mono label (never colour-only) with a tinted background; `pending` pulses (UI_UX §7). */
export function VerdictBadge({
  verdict,
  test,
  className,
}: {
  verdict: Verdict | 'pending';
  /** Failing test number, shown as "on test N" for per-test verdicts. */
  test?: number;
  className?: string;
}) {
  if (verdict === 'pending') {
    return (
      <span
        title="Judging"
        className={cn(
          'inline-flex items-center rounded-sm bg-v-pending/14 px-1.5 py-0.5 font-mono text-12 font-medium text-v-pending motion-safe:animate-judging',
          className,
        )}
      >
        judging…
      </span>
    );
  }
  const m = VERDICTS[verdict];
  return (
    <span
      title={verdictTitle(verdict, test)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-12 font-medium',
        m.tint,
        m.text,
        className,
      )}
    >
      {m.label}
      {m.perTest && test !== undefined ? (
        <span className="font-normal text-text-2">on test {test}</span>
      ) : null}
    </span>
  );
}
