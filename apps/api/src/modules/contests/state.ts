import type { ContestState } from '@codearena/contracts';

export interface ContestTimes {
  status: 'draft' | 'scheduled' | 'running' | 'ended' | 'finalized';
  startsAt: Date;
  endsAt: Date;
}

/**
 * FR-CONT-03: the state comes from the server's clock, never from the stored `status` (only
 * `draft` and `finalized` are stored decisions). Extending a contest just moves `endsAt`.
 */
export function contestState(c: ContestTimes, now: Date): ContestState {
  if (c.status === 'draft' || c.status === 'finalized') return c.status;
  if (now < c.startsAt) return 'scheduled';
  return now < c.endsAt ? 'running' : 'ended';
}

/** PRD §9.1: whole minutes since the official start, floored. */
export const contestMinute = (startsAt: Date, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - startsAt.getTime()) / 60_000));
