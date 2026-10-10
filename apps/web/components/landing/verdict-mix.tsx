/**
 * What the load test's 500 submissions came back as, and how long one judge versus two took to drain the
 * burst. Every number is from `docs/METRICS.md` (the load test of 8 October 2026). Flat bars, a text
 * legend: the verdict is never told by colour alone.
 */
const MIX = [
  { code: 'AC', name: 'Accepted', n: 337, bar: 'bg-v-ac' },
  { code: 'WA', name: 'Wrong answer', n: 108, bar: 'bg-v-wa' },
  { code: 'TLE', name: 'Time limit', n: 44, bar: 'bg-v-tle' },
  { code: 'RE', name: 'Runtime error', n: 11, bar: 'bg-v-re' },
] as const;
const TOTAL = MIX.reduce((n, m) => n + m.n, 0); // 500

export function VerdictMix() {
  return (
    <section aria-labelledby="mix-heading" className="flex flex-col gap-6">
      <h2 id="mix-heading" className="max-w-[36rem] text-22 font-semibold">
        What 500 submissions looked like
      </h2>
      <div className="flex flex-col gap-3">
        <div
          role="img"
          aria-label={`Verdicts of ${TOTAL} submissions: ${MIX.map((m) => `${m.name} ${m.n}`).join(', ')}`}
          className="flex h-4 w-full gap-0.5 overflow-hidden rounded-sm"
        >
          {MIX.map((m) => (
            <span key={m.code} className={m.bar} style={{ width: `${(m.n / TOTAL) * 100}%` }} />
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-14">
          {MIX.map((m) => (
            <li key={m.code} className="flex items-center gap-2">
              <span aria-hidden className={`size-2.5 rounded-[2px] ${m.bar}`} />
              <span className="font-mono">{m.code}</span>
              <span className="font-mono tabular-nums">{m.n}</span>
              <span className="text-text-2">{m.name}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex max-w-[36rem] flex-col gap-3">
        <h3 className="text-16 font-semibold">One judge machine against two</h3>
        <p className="text-14 text-text-2">
          Time for the queue to drain after the last of the 500 submissions arrived:
        </p>
        {[
          { label: 'One judge', value: '58 s', share: 100 },
          { label: 'Two judges', value: '2 s', share: (2 / 58) * 100 },
        ].map((b) => (
          <div key={b.label} className="flex items-center gap-3 text-14">
            <span className="w-24 shrink-0 text-text-2">{b.label}</span>
            <span className="h-2.5 flex-1 rounded-sm bg-surface-3" aria-hidden>
              <span
                className="block h-2.5 rounded-sm bg-primary"
                style={{ width: `${b.share}%` }}
              />
            </span>
            <span className="w-12 text-right font-mono tabular-nums">{b.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
