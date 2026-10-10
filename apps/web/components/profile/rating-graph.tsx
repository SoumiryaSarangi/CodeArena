'use client';
import type { RatingHistory } from '@codearena/contracts';
import { useEffect, useRef, useState } from 'react';

const H = 240;
const PAD = { l: 44, r: 16, t: 16, b: 28 };

/**
 * The rating over time (S12). A plain SVG line with a dot per contest; the numbers are also in the
 * contest history table under it, which is the accessible version of the same data.
 */
export function RatingGraph({ history }: { history: RatingHistory['history'] }) {
  // The drawing is as wide as its box, so labels keep their size on a phone instead of shrinking with it.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setW(Math.max(280, Math.round(el.clientWidth)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (history.length === 0) return null;
  const points = [history[0]!.oldRating, ...history.map((h) => h.newRating)];
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = Math.max(hi - lo, 100);
  const min = lo - span * 0.1;
  const max = hi + span * 0.1;
  const x = (i: number) => PAD.l + (i / Math.max(points.length - 1, 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const line = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  const ticks = [Math.round(min), Math.round((min + max) / 2), Math.round(max)];
  return (
    <div ref={box} className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Rating over ${history.length} contest${history.length === 1 ? '' : 's'}, from ${points[0]} to ${points.at(-1)}`}
        width={W}
        height={H}
        className="block text-text"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border-strong"
              strokeWidth={1}
            />
            <text
              x={PAD.l - 6}
              y={y(t) + 4}
              textAnchor="end"
              className="fill-text-2 font-mono text-12"
            >
              {t}
            </text>
          </g>
        ))}
        <path d={line} fill="none" className="stroke-accent" strokeWidth={2} />
        {history.map((h, i) => (
          <circle
            key={h.contestSlug}
            cx={x(i + 1)}
            cy={y(h.newRating)}
            r={3.5}
            className="fill-accent"
          >
            <title>{`${h.contestTitle}: ${h.newRating} (${h.delta >= 0 ? '+' : '−'}${Math.abs(h.delta)})`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
