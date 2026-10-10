import type { Verdict } from '@codearena/contracts';
import { cn } from '@/lib/cn';
import type { LiveSubmission } from '@/lib/live-submission';
import { VERDICTS } from '@/lib/verdicts';

/** The steps of a judging, in order; the last one is the verdict. */
const STEPS = ['queued', 'claimed', 'compiling', 'running', 'verdict'] as const;
type Step = (typeof STEPS)[number];
const RANK: Record<LiveSubmission['phase'], number> = {
  queued: 0,
  claimed: 1,
  compiling: 2,
  running: 3,
  done: 4,
};

/**
 * "The wire" (round 2, approved by Ayush): a thin line of five segments under a submission that fills as the real
 * events arrive (queued, claimed, compiling, running) and settles into the verdict's colour when the verdict is
 * in. Feedback only: the words that say the same thing are always next to it (the queue line, the verdict
 * badge), so it is hidden from assistive technology. Pass `live` for a submission being followed, or
 * `verdict` for one that is already judged (or `null` for one still being judged).
 */
export function SubmissionWire({
  live,
  verdict,
  submitting = false,
  className,
}: {
  live?: LiveSubmission | null;
  verdict?: Verdict | null;
  /** The submit was sent and nothing has come back yet. */
  submitting?: boolean;
  className?: string;
}) {
  const done: Verdict | undefined = live?.verdict ?? verdict ?? undefined;
  // How many steps are complete, and which one is in progress.
  const reached = done ? STEPS.length : live ? RANK[live.phase] : 0;
  const settled = done ? VERDICTS[done].swatch : null;
  return (
    <div
      aria-hidden
      data-wire={done ?? live?.phase ?? (submitting ? 'submitting' : 'judging')}
      className={cn('flex h-[3px] w-full gap-0.5', className)}
    >
      {STEPS.map((step: Step, i) => (
        <span
          key={step}
          className={cn(
            'h-full flex-1 rounded-full transition-colors duration-[var(--dur-base)]',
            settled
              ? settled
              : i < reached
                ? 'bg-text-2'
                : i === reached
                  ? 'bg-v-pending motion-safe:animate-judging'
                  : 'bg-border-control',
          )}
        />
      ))}
    </div>
  );
}
