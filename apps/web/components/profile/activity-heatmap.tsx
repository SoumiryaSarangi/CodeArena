import type { ProfileSummary } from '@codearena/contracts';
import { buildHeatmap } from '@/lib/profile';

const LEVEL = [
  'fill-surface-3',
  'fill-accent/30',
  'fill-accent/55',
  'fill-accent/80',
  'fill-accent',
] as const;
const CELL = 11;
const GAP = 2;
const STEP = CELL + GAP;

const nice = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * Submissions per day over the last year (S12, S03). A plain SVG: each day is a square whose
 * fill is a quarter of the busiest day, and has its own `<title>`. The count and the busiest day
 * are also written out, because shades alone say nothing to a screen reader.
 */
export function ActivityHeatmap({
  activity,
  compact = false,
}: {
  activity: ProfileSummary['activity'];
  compact?: boolean;
}) {
  const { weeks, busiest } = buildHeatmap(activity.days, activity.from, activity.to);
  const width = weeks.length * STEP;
  const height = 7 * STEP;
  const summary =
    activity.total === 0
      ? 'No submissions in the last year'
      : `${activity.total.toLocaleString()} submission${activity.total === 1 ? '' : 's'} in the last year` +
        (busiest ? `, the most on ${nice(busiest.date)} (${busiest.count})` : '');
  return (
    <figure className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Activity: ${summary}`}
        className={compact ? 'h-auto w-full max-w-xl' : 'h-auto w-full'}
      >
        {weeks.map((w, x) =>
          w.map((c, y) =>
            c ? (
              <rect
                key={c.date}
                x={x * STEP}
                y={y * STEP}
                width={CELL}
                height={CELL}
                rx={2}
                className={LEVEL[c.level]}
              >
                <title>{`${c.count} submission${c.count === 1 ? '' : 's'} on ${nice(c.date)}`}</title>
              </rect>
            ) : null,
          ),
        )}
      </svg>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-12 text-text-2">
        <span>{summary}</span>
        <span className="ml-auto inline-flex items-center gap-1" aria-hidden>
          Less
          {LEVEL.map((l) => (
            <svg key={l} width={CELL} height={CELL} className="shrink-0">
              <rect width={CELL} height={CELL} rx={2} className={l} />
            </svg>
          ))}
          More
        </span>
      </figcaption>
    </figure>
  );
}
