import { Check } from 'lucide-react';
import { VerdictBadge } from '@/components/verdict-badge';

/** The six steps the submission page shows, in its own words. */
const STEPS = [
  'Submitted',
  'Queued',
  'Claimed by a judge',
  'Compiled',
  'Run test by test',
  'Verdict',
] as const;

/**
 * The hero object (UI-16): one submission's path, lit step by step once, then at rest. The steps are in the
 * end state without any script (the animation only dims them until their turn), and under reduced motion they
 * are simply all lit. The numbers under it are measured aggregates from `docs/METRICS.md` (the run of
 * 8 October 2026, two judge machines), said to be that, not this submission's.
 */
export function JudgeWindow() {
  return (
    <figure
      aria-labelledby="judge-window-caption"
      className="overflow-hidden rounded-lg border border-border-strong bg-surface-1"
    >
      <div className="glass flex items-center justify-between border-b border-border px-4 py-2 text-12 text-text-2">
        <span className="font-mono">one submission</span>
        <span>the path it takes</span>
      </div>
      <ol className="flex flex-col divide-y divide-border">
        {STEPS.map((step, i) => (
          <li
            key={step}
            style={{ animationDelay: `${i * 280}ms` }}
            className="step-on flex items-center gap-3 px-4 py-3"
          >
            <span
              aria-hidden
              className="grid size-5 shrink-0 place-items-center rounded-full border border-v-ac text-v-ac"
            >
              <Check className="size-3" />
            </span>
            <span className="text-14 font-medium">{step}</span>
            {i === STEPS.length - 1 ? <VerdictBadge verdict="AC" className="ml-auto" /> : null}
          </li>
        ))}
      </ol>
      <figcaption
        id="judge-window-caption"
        className="border-t border-border px-4 py-3 text-13 text-text-2"
      >
        Measured on production, 8 October 2026 (two judge machines): queue wait{' '}
        <span className="font-mono text-text">0.0 s</span> median,{' '}
        <span className="font-mono text-text">0.5 s</span> at the 95th percentile; submission to
        verdict <span className="font-mono text-text">0.4 s</span> median,{' '}
        <span className="font-mono text-text">2.1 s</span> at the 95th.
      </figcaption>
    </figure>
  );
}
