import type { BoardCell } from '@codearena/contracts';
import { ScoreCell } from '@/components/contests/score-cell';

const cell = (over: Partial<BoardCell>): BoardCell => ({
  attempts: 0,
  acMinute: null,
  pending: 0,
  first: false,
  ...over,
});

/** Made-up rows for the picture; the page says so. Built with the real ScoreCell, so it matches S10. */
const ROWS = [
  {
    rank: 1,
    handle: 'amy',
    solved: 2,
    penalty: 92,
    A: cell({ acMinute: 12, first: true }),
    B: cell({ acMinute: 40, attempts: 2 }),
  },
  {
    rank: 2,
    handle: 'riya_k',
    solved: 1,
    penalty: 50,
    A: cell({ acMinute: 30, attempts: 1 }),
    B: cell({ pending: 1 }),
  },
  { rank: 3, handle: 'zed', solved: 0, penalty: 0, A: cell({ attempts: 3 }), B: cell({}) },
] as const;

export function SampleBoard() {
  return (
    <section aria-labelledby="board-heading" className="flex flex-col gap-4">
      <h2 id="board-heading" className="max-w-[36rem] text-22 font-semibold">
        A contest scoreboard, as it looks
      </h2>
      <figure className="flex flex-col gap-2">
        <div
          role="region"
          tabIndex={0}
          aria-label="Sample scoreboard, scrolls sideways on a narrow screen"
          className="relative overflow-x-auto rounded-lg border border-border-strong bg-surface-1"
        >
          <table className="w-full min-w-[30rem] border-collapse text-14">
            <caption className="sr-only">Sample scoreboard with made-up handles</caption>
            <thead className="text-13 text-text-2">
              <tr className="border-b border-border-strong">
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Rank
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  Handle
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Solved
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Penalty
                </th>
                <th scope="col" className="px-4 py-2 text-center font-mono font-medium">
                  A
                </th>
                <th scope="col" className="px-4 py-2 text-center font-mono font-medium">
                  B
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.handle} className="h-11 border-b border-border last:border-0">
                  <td className="px-4 text-right font-mono tabular-nums">{r.rank}</td>
                  <th scope="row" className="px-4 text-left font-mono font-medium">
                    {r.handle}
                  </th>
                  <td className="px-4 text-right font-mono tabular-nums">{r.solved}</td>
                  <td className="px-4 text-right font-mono tabular-nums">{r.penalty}</td>
                  <td className="px-4 text-center">
                    <ScoreCell cell={r.A} />
                  </td>
                  <td className="px-4 text-center">
                    <ScoreCell cell={r.B} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <figcaption className="text-13 text-text-3">
          Sample data: made-up handles, to show the layout. ✓ is the minute a problem was solved, ★
          the first solve, +n rejected attempts, ?n attempts still being judged.
        </figcaption>
      </figure>
    </section>
  );
}
