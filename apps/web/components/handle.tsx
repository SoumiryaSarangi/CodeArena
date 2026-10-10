import { tierWord } from '@/lib/profile';
import { cn } from '@/lib/cn';

/** The tier colour classes by tier word (tokens in tokens.css). */
const TIER: Record<string, string> = {
  Newcomer: 'text-tier-newcomer',
  Pupil: 'text-tier-pupil',
  Specialist: 'text-tier-specialist',
  Expert: 'text-tier-expert',
  Master: 'text-tier-master',
};

/** A new account starts at 1400 before it has taken part in anything: that is not a tier, so it stays neutral. */
export const UNRATED = 1400;

/** The handle with a soft break allowed after `_` and `.`, so a long one wraps at a sensible place on a phone. */
function breakable(handle: string) {
  return handle
    .split(/(?<=[_.])/)
    .flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]));
}

/**
 * A handle in its rating tier's colour (the Codeforces idiom), round 2. The colour is never alone: the tier word
 * is in the tooltip and read out by screen readers. Without a rating (or at the starting 1400) it stays neutral.
 */
export function Handle({
  handle,
  rating,
  className,
  announce = true,
}: {
  handle: string;
  rating?: number | null;
  className?: string;
  /** Say the tier word to screen readers. Off where the page already prints it (the profile header). */
  announce?: boolean;
}) {
  if (rating === undefined || rating === null || rating === UNRATED) {
    return (
      <bdi>
        <span className={className}>{breakable(handle)}</span>
      </bdi>
    );
  }
  const tier = tierWord(rating);
  return (
    <span className={cn(TIER[tier], className)} title={`${tier} (${rating})`}>
      <bdi>{breakable(handle)}</bdi>
      {announce ? <span className="sr-only">, {tier}</span> : null}
    </span>
  );
}
