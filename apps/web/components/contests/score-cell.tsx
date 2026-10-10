import type { BoardCell } from '@codearena/contracts';
import { cn } from '@/lib/cn';
import { describeCell } from '@/lib/board';

/**
 * One scoreboard cell (UI_UX §7): `✓ mm` (solved), `✓ mm ★` (first solve), `+n` (rejected
 * attempts, danger text), `?n` (pending, accent outline). Text and glyph always, never colour alone;
 * the words for screen readers are in `describeCell`.
 */
export function ScoreCell({ cell, flash }: { cell?: BoardCell; flash?: boolean }) {
  if (!cell || (cell.acMinute === null && cell.attempts === 0 && cell.pending === 0)) {
    return (
      <span className="text-text-3">
        <span aria-hidden>·</span>
        <span className="sr-only">Not attempted</span>
      </span>
    );
  }
  const solved = cell.acMinute !== null;
  return (
    <span
      className={cn(
        'inline-flex min-w-14 items-center justify-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-13 tabular-nums',
        solved &&
          'bg-v-ac/14 text-v-ac light:bg-transparent light:ring-1 light:ring-inset light:ring-v-ac/40',
        !solved && cell.pending > 0 && 'ring-1 ring-inset ring-accent text-text',
        !solved && cell.pending === 0 && 'text-danger',
        // the flash is movement; with reduced motion the changed cell is marked by a ring for the same moment instead
        flash &&
          'motion-safe:animate-flash motion-reduce:ring-1 motion-reduce:ring-inset motion-reduce:ring-accent',
      )}
    >
      <span aria-hidden className="inline-flex items-center gap-1">
        {solved ? (
          <>
            <span>✓ {cell.acMinute}</span>
            {cell.first ? <span>★</span> : null}
            {cell.attempts > 0 ? <span>+{cell.attempts}</span> : null}
          </>
        ) : (
          <>
            {cell.attempts > 0 ? <span className="text-danger">+{cell.attempts}</span> : null}
            {cell.pending > 0 ? <span>?{cell.pending}</span> : null}
          </>
        )}
      </span>
      <span className="sr-only">{describeCell(cell)}</span>
    </span>
  );
}
