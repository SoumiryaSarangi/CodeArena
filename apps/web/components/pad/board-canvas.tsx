import { forwardRef, type PointerEventHandler, type ReactNode } from 'react';
import { arrowPath, BOARD, bounds, penPath, TEXT_SIZE, type Shape } from '@/lib/whiteboard';

const colour = (c: number) => `var(--presence-${c})`;

/** One shape. Colours come from the presence tokens (the author's colour in the room); nothing is hard-coded. */
export function ShapeNode({ s }: { s: Shape }) {
  const col = colour(s.c);
  const hit = {
    stroke: 'transparent',
    strokeWidth: 18,
    fill: 'none',
    pointerEvents: 'stroke' as const,
  };
  return (
    <g data-shape-id={s.id} data-kind={s.k}>
      {s.k === 'pen' ? (
        <path
          d={penPath(s.p)}
          fill={col}
          stroke="transparent"
          strokeWidth={10}
          pointerEvents="all"
        />
      ) : s.k === 'rect' ? (
        <>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} fill="none" stroke={col} strokeWidth={3} />
          <rect x={s.x} y={s.y} width={s.w} height={s.h} {...hit} />
        </>
      ) : s.k === 'arrow' ? (
        <>
          <path
            d={arrowPath(s.x1, s.y1, s.x2, s.y2)}
            fill="none"
            stroke={col}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d={arrowPath(s.x1, s.y1, s.x2, s.y2)} {...hit} />
        </>
      ) : (
        <>
          <text
            x={s.x}
            y={s.y}
            fontSize={TEXT_SIZE}
            fill={col}
            style={{ fontFamily: 'var(--font-geist-sans), system-ui, sans-serif' }}
          >
            {s.t}
          </text>
          <rect {...bounds(s)} fill="transparent" pointerEvents="all" />
        </>
      )}
    </g>
  );
}

/** The selection outline: a dashed box in the accent colour around a shape. */
export function Selection({ s }: { s: Shape }) {
  const b = bounds(s);
  return (
    <rect
      x={b.x - 8}
      y={b.y - 8}
      width={b.w + 16}
      height={b.h + 16}
      fill="none"
      stroke="var(--accent)"
      strokeWidth={2}
      strokeDasharray="6 4"
      pointerEvents="none"
      data-selection
    />
  );
}

interface CanvasProps {
  shapes: Shape[];
  selectedId?: string | null;
  /** A shape being dragged along (dx, dy are shown live; it is saved when the drag ends). */
  drag?: { id: string; dx: number; dy: number } | null;
  /** The shape being drawn right now, and the keyboard cursor, drawn over the others. */
  overlay?: ReactNode;
  label: string;
  describedBy?: string;
  interactive?: boolean;
  onPointerDown?: PointerEventHandler<SVGSVGElement>;
  onPointerMove?: PointerEventHandler<SVGSVGElement>;
  onPointerUp?: PointerEventHandler<SVGSVGElement>;
  onKeyDown?: (e: React.KeyboardEvent<SVGSVGElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  cursor?: string;
}

/** The board: an SVG of fixed logical size (1200 × 800) scaled to fit, shared by the live whiteboard and the replay. */
export const BoardCanvas = forwardRef<SVGSVGElement, CanvasProps>(function BoardCanvas(p, ref) {
  const selected = p.selectedId ? p.shapes.find((s) => s.id === p.selectedId) : undefined;
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${BOARD.w} ${BOARD.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={p.label}
      aria-describedby={p.describedBy}
      tabIndex={p.interactive ? 0 : undefined}
      onPointerDown={p.onPointerDown}
      onPointerMove={p.onPointerMove}
      onPointerUp={p.onPointerUp}
      onPointerCancel={p.onPointerUp}
      onKeyDown={p.onKeyDown}
      onFocus={p.onFocus}
      onBlur={p.onBlur}
      className="aspect-[3/2] w-full rounded-md border border-border-strong bg-surface-1 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      style={{ touchAction: p.interactive ? 'none' : undefined, cursor: p.cursor }}
      data-board
    >
      {p.shapes.map((s) =>
        p.drag?.id === s.id ? (
          <g key={s.id} transform={`translate(${p.drag.dx} ${p.drag.dy})`}>
            <ShapeNode s={s} />
          </g>
        ) : (
          <ShapeNode key={s.id} s={s} />
        ),
      )}
      {selected ? (
        p.drag?.id === selected.id ? (
          <g transform={`translate(${p.drag.dx} ${p.drag.dy})`}>
            <Selection s={selected} />
          </g>
        ) : (
          <Selection s={selected} />
        )
      ) : null}
      {p.overlay}
    </svg>
  );
});
