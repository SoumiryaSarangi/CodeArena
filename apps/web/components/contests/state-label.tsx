import type { ContestState } from '@codearena/contracts';
import { cn } from '@/lib/cn';

const LABEL: Record<ContestState, { text: string; cls: string }> = {
  draft: { text: 'Draft', cls: 'text-text-3' },
  scheduled: { text: 'Upcoming', cls: 'text-text-2' },
  running: { text: 'Running', cls: 'text-v-ac' },
  ended: { text: 'Ended', cls: 'text-text-3' },
  finalized: { text: 'Final results', cls: 'text-text-3' },
};

/** The contest's state as text, never colour alone. */
export function StateLabel({ state, className }: { state: ContestState; className?: string }) {
  const l = LABEL[state];
  return <span className={cn('text-13 font-medium', l.cls, className)}>{l.text}</span>;
}
