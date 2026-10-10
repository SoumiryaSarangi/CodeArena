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

/**
 * A handle in its rating tier's colour (the Codeforces idiom), round 2. The colour is never alone: the tier word
 * is in the tooltip and read out by screen readers. Without a rating (or at the starting 1400) it stays neutral.
 */
export function Handle({
  handle,
  rating,
  className,
}: {
  handle: string;
  rating?: number | null;
  className?: string;
}) {
  if (rating === undefined || rating === null || rating === UNRATED) {
    return <span className={className}>{handle}</span>;
  }
  const tier = tierWord(rating);
  return (
    <span className={cn(TIER[tier], className)} title={`${tier} (${rating})`}>
      {handle}
      <span className="sr-only">, {tier}</span>
    </span>
  );
}
