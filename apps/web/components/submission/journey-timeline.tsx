import { Check, Circle, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { JourneyStep } from '@/lib/journey';

/**
 * UI_UX §7 JourneyTimeline: a vertical list; each step has a dot, a label, the time since the
 * submission ("+1.8 s") and the absolute time on hover. State is also in words for screen readers.
 */
export function JourneyTimeline({ steps, note }: { steps: JourneyStep[]; note?: string }) {
  return (
    <section aria-label="Journey">
      <h2 className="mb-2 text-16 font-semibold">Journey</h2>
      <ol className="flex flex-col">
        {steps.map((s, i) => {
          const Icon = s.state === 'done' ? Check : s.state === 'failed' ? X : Circle;
          return (
            <li key={s.key} className="relative flex gap-3 pb-4 last:pb-0">
              {i < steps.length - 1 ? (
                <span
                  aria-hidden
                  className="absolute left-[9px] top-5 h-[calc(100%-1rem)] w-px bg-border-strong"
                />
              ) : null}
              <span
                aria-hidden
                className={cn(
                  'z-10 mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
                  s.state === 'done' && 'border-v-ac text-v-ac',
                  s.state === 'failed' && 'border-v-wa text-v-wa',
                  s.state === 'current' && 'border-accent text-accent motion-safe:animate-judging',
                  s.state === 'pending' && 'border-border-control text-text-3',
                )}
              >
                <Icon className="size-3" />
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="text-14 font-medium">{s.label}</span>
                {s.detail ? <span className="text-13 text-text-2">{s.detail}</span> : null}
                <span className="sr-only">
                  {s.state === 'pending'
                    ? ' (not reached)'
                    : s.state === 'current'
                      ? ' (in progress)'
                      : s.state === 'failed'
                        ? ' (failed)'
                        : ''}
                </span>
                {s.relative ? (
                  <time
                    dateTime={s.at}
                    title={s.at ? new Date(s.at).toLocaleString() : undefined}
                    className="ml-auto font-mono text-12 text-text-3"
                  >
                    {s.relative}
                  </time>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {note ? <p className="mt-3 text-12 text-text-3">{note}</p> : null}
    </section>
  );
}
