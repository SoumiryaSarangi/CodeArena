'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  addShape,
  BOARD,
  clearBoard,
  clamp,
  deleteShape,
  describe,
  extendStroke,
  LIMITS,
  moveShape,
  penPath,
  readShapes,
  shapeAt,
  toBoard,
  type NewShape,
  type Shape,
} from '@/lib/whiteboard';
import { BoardCanvas } from './board-canvas';

type Tool = 'select' | 'pen' | 'rect' | 'arrow' | 'text' | 'eraser';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  {
    id: 'select',
    label: 'Select',
    hint: 'Click a shape or choose it in the list. Move it by dragging, with the arrow keys (Shift for bigger steps) or the move buttons. Delete removes it.',
  },
  {
    id: 'pen',
    label: 'Pen',
    hint: 'Drag to draw. Without a mouse: focus the board, press Space to put the pen down, move with the arrow keys (Shift for bigger steps), press Space again to lift it.',
  },
  {
    id: 'rect',
    label: 'Rectangle',
    hint: 'Drag from one corner to the opposite one. Without a mouse: press Space at one corner, move with the arrow keys, press Space again, or use Add rectangle.',
  },
  {
    id: 'arrow',
    label: 'Arrow',
    hint: 'Drag from the tail to the head. Without a mouse: press Space at the tail, move with the arrow keys, press Space again, or use Add arrow.',
  },
  {
    id: 'text',
    label: 'Text',
    hint: 'Type the text in the box, then click where it should go, or press Enter on the board (cursor placed with the arrow keys) or use Add text for the middle.',
  },
  {
    id: 'eraser',
    label: 'Eraser',
    hint: 'Click or drag over shapes to erase them. Without a mouse: choose a shape in the list and use Delete selected, or move the cursor over it with the arrow keys and press Space.',
  },
];

const STEP = 8;
const BIG = 40;

/** The shapes of the board, kept up to date as people draw (and as the replay moves). */
function useShapes(doc: Y.Doc): Shape[] {
  const [shapes, setShapes] = useState<Shape[]>(() => readShapes(doc));
  useEffect(() => {
    const arr = doc.getArray('strokes');
    const update = () => setShapes(readShapes(doc));
    update();
    arr.observeDeep(update);
    return () => arr.unobserveDeep(update);
  }, [doc]);
  return shapes;
}

interface Draft {
  tool: 'pen' | 'rect' | 'arrow';
  from: { x: number; y: number };
  to: { x: number; y: number };
  points: number[];
}

/**
 * S13 whiteboard tab (CP-10, FR-PAD-15): pen, rectangle, arrow, text and eraser on one board shared by the room. Everything
 * that can be dragged has a way to do it without dragging: buttons that add a shape in the middle, a keyboard cursor for
 * every tool, arrow keys and buttons to move the selected shape, and a list to choose shapes from (NFR-A11Y-04).
 */
export function Whiteboard({
  doc,
  readOnly,
  colorIndex,
}: {
  doc: Y.Doc;
  readOnly: boolean;
  /** The person's presence colour, used for what they draw. */
  colorIndex: number;
}) {
  const shapes = useShapes(doc);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const hintId = useId();
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    from: { x: number; y: number };
    dx: number;
    dy: number;
  } | null>(null);
  const [erasing, setErasing] = useState(false);
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  // the keyboard cursor: where Space and Enter act, and whether the pen is down (or a rectangle or arrow has been started)
  const [kb, setKb] = useState<{
    x: number;
    y: number;
    focused: boolean;
    anchor: { x: number; y: number } | null;
    points: number[];
  }>({
    x: BOARD.w / 2,
    y: BOARD.h / 2,
    focused: false,
    anchor: null,
    points: [],
  });

  const selected = useMemo(
    () => shapes.find((s) => s.id === selectedId) ?? null,
    [shapes, selectedId],
  );
  useEffect(() => {
    if (selectedId && !shapes.some((s) => s.id === selectedId)) setSelectedId(null); // erased by someone else
  }, [shapes, selectedId]);

  const say = (m: string) => setMessage(m);
  const add = useCallback(
    (shape: NewShape): string | null => {
      const id = addShape(doc, shape);
      if (id === null)
        say(
          shapes.length >= LIMITS.shapes
            ? `The board is full (${LIMITS.shapes} shapes). Erase something first.`
            : 'Nothing was added.',
        );
      return id;
    },
    [doc, shapes.length],
  );

  const point = (e: { clientX: number; clientY: number }) =>
    toBoard(svgRef.current!.getBoundingClientRect(), e.clientX, e.clientY);

  const eraseAt = (e: { clientX: number; clientY: number }) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-shape-id]');
    const id = el?.getAttribute('data-shape-id');
    if (id && deleteShape(doc, id)) say('Erased.');
  };

  const finishDraft = (d: Draft) => {
    if (d.tool === 'pen') {
      const p = d.points.length >= 2 ? d.points : [d.from.x, d.from.y];
      if (add({ k: 'pen', c: colorIndex, p })) say('Pen stroke added.');
    } else if (d.tool === 'rect') {
      const w = Math.abs(d.to.x - d.from.x);
      const h = Math.abs(d.to.y - d.from.y);
      if (
        w >= 4 &&
        h >= 4 &&
        add({
          k: 'rect',
          c: colorIndex,
          x: Math.min(d.from.x, d.to.x),
          y: Math.min(d.from.y, d.to.y),
          w,
          h,
        })
      )
        say('Rectangle added.');
    } else if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) >= 8) {
      if (add({ k: 'arrow', c: colorIndex, x1: d.from.x, y1: d.from.y, x2: d.to.x, y2: d.to.y }))
        say('Arrow added.');
    }
  };

  const placeText = (x: number, y: number) => {
    const t = text.trim();
    if (t === '') return say('Type the text in the box first.');
    const id = add({ k: 'text', c: colorIndex, x, y, t });
    if (id) {
      setText('');
      setSelectedId(id);
      say('Text added.');
    }
  };

  // ---- pointer
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (readOnly || e.button > 0) return;
    const p = point(e);
    svgRef.current?.setPointerCapture(e.pointerId);
    if (tool === 'pen') setDraft({ tool, from: p, to: p, points: [p.x, p.y] });
    else if (tool === 'rect' || tool === 'arrow') setDraft({ tool, from: p, to: p, points: [] });
    else if (tool === 'text') placeText(p.x, p.y);
    else if (tool === 'eraser') {
      setErasing(true);
      eraseAt(e);
    } else {
      const id =
        (e.target as Element).closest('[data-shape-id]')?.getAttribute('data-shape-id') ?? null;
      setSelectedId(id);
      if (id) setDrag({ id, from: p, dx: 0, dy: 0 });
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (readOnly) return;
    const p = point(e);
    if (draft) {
      setDraft(
        draft.tool === 'pen'
          ? { ...draft, to: p, points: extendStroke(draft.points, p.x, p.y) }
          : { ...draft, to: p },
      );
    } else if (drag) setDrag({ ...drag, dx: p.x - drag.from.x, dy: p.y - drag.from.y });
    else if (erasing) eraseAt(e);
  };
  const onPointerUp = () => {
    if (draft) finishDraft(draft);
    if (drag && (Math.abs(drag.dx) >= 1 || Math.abs(drag.dy) >= 1))
      moveShape(doc, drag.id, Math.round(drag.dx), Math.round(drag.dy));
    setDraft(null);
    setDrag(null);
    setErasing(false);
  };

  // ---- keyboard
  const move = (dx: number, dy: number) => {
    if (selected && moveShape(doc, selected.id, dx, dy))
      say(`${describe(selected, shapes.indexOf(selected) + 1)} moved.`);
  };
  const removeSelected = () => {
    if (selected && deleteShape(doc, selected.id)) {
      say('Erased.');
      setSelectedId(null);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (readOnly) return;
    const step = e.shiftKey ? BIG : STEP;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const a = arrows[e.key];
    if (tool === 'select') {
      if (a) {
        e.preventDefault();
        move(a[0], a[1]);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeSelected();
      } else if (e.key === 'Escape') setSelectedId(null);
      return;
    }
    if (a) {
      e.preventDefault();
      setKb((k) => {
        const x = clamp(k.x + a[0], BOARD.w);
        const y = clamp(k.y + a[1], BOARD.h);
        return {
          ...k,
          x,
          y,
          points: k.anchor && tool === 'pen' ? extendStroke(k.points, x, y) : k.points,
        };
      });
      return;
    }
    if (e.key === 'Escape') return setKb((k) => ({ ...k, anchor: null, points: [] }));
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (tool === 'text') return placeText(kb.x, kb.y);
    if (tool === 'eraser') {
      const hit = shapeAt(shapes, kb.x, kb.y);
      if (hit && deleteShape(doc, hit.id)) say('Erased.');
      else say('Nothing under the cursor.');
      return;
    }
    if (!kb.anchor) {
      say(
        tool === 'pen'
          ? 'Pen down.'
          : tool === 'rect'
            ? 'Corner set. Move to the opposite corner and press Space.'
            : 'Tail set. Move to the head and press Space.',
      );
      return setKb((k) => ({ ...k, anchor: { x: k.x, y: k.y }, points: [k.x, k.y] }));
    }
    finishDraft({
      tool: tool as 'pen' | 'rect' | 'arrow',
      from: kb.anchor,
      to: { x: kb.x, y: kb.y },
      points: kb.points,
    });
    setKb((k) => ({ ...k, anchor: null, points: [] }));
  };

  // ---- buttons that need no dragging
  const addRect = () => {
    const id = add({
      k: 'rect',
      c: colorIndex,
      x: BOARD.w / 2 - 120,
      y: BOARD.h / 2 - 70,
      w: 240,
      h: 140,
    });
    if (id) {
      setTool('select');
      setSelectedId(id);
      say('Rectangle added in the middle. Move it with the arrow keys or the move buttons.');
    }
  };
  const addArrow = () => {
    const id = add({
      k: 'arrow',
      c: colorIndex,
      x1: BOARD.w / 2 - 120,
      y1: BOARD.h / 2,
      x2: BOARD.w / 2 + 120,
      y2: BOARD.h / 2,
    });
    if (id) {
      setTool('select');
      setSelectedId(id);
      say('Arrow added in the middle. Move it with the arrow keys or the move buttons.');
    }
  };
  const addText = () => placeText(BOARD.w / 2 - Math.min(300, text.length * 6), BOARD.h / 2);

  const tl = TOOLS.find((t) => t.id === tool)!;
  const overlay = (
    <>
      {draft?.tool === 'pen' ? (
        <path
          d={penPath(draft.points)}
          fill={`var(--presence-${colorIndex})`}
          pointerEvents="none"
        />
      ) : null}
      {draft?.tool === 'rect' ? (
        <rect
          x={Math.min(draft.from.x, draft.to.x)}
          y={Math.min(draft.from.y, draft.to.y)}
          width={Math.abs(draft.to.x - draft.from.x)}
          height={Math.abs(draft.to.y - draft.from.y)}
          fill="none"
          stroke={`var(--presence-${colorIndex})`}
          strokeWidth={3}
          strokeDasharray="8 6"
          pointerEvents="none"
        />
      ) : null}
      {draft?.tool === 'arrow' ? (
        <line
          x1={draft.from.x}
          y1={draft.from.y}
          x2={draft.to.x}
          y2={draft.to.y}
          stroke={`var(--presence-${colorIndex})`}
          strokeWidth={3}
          strokeDasharray="8 6"
          pointerEvents="none"
        />
      ) : null}
      {kb.anchor && tool === 'pen' && kb.points.length >= 2 ? (
        <path d={penPath(kb.points)} fill={`var(--presence-${colorIndex})`} pointerEvents="none" />
      ) : null}
      {kb.anchor && tool === 'rect' ? (
        <rect
          x={Math.min(kb.anchor.x, kb.x)}
          y={Math.min(kb.anchor.y, kb.y)}
          width={Math.abs(kb.x - kb.anchor.x)}
          height={Math.abs(kb.y - kb.anchor.y)}
          fill="none"
          stroke={`var(--presence-${colorIndex})`}
          strokeWidth={3}
          strokeDasharray="8 6"
          pointerEvents="none"
        />
      ) : null}
      {kb.anchor && tool === 'arrow' ? (
        <line
          x1={kb.anchor.x}
          y1={kb.anchor.y}
          x2={kb.x}
          y2={kb.y}
          stroke={`var(--presence-${colorIndex})`}
          strokeWidth={3}
          strokeDasharray="8 6"
          pointerEvents="none"
        />
      ) : null}
      {kb.focused && tool !== 'select' && !readOnly ? (
        <g pointerEvents="none" data-kb-cursor>
          <circle cx={kb.x} cy={kb.y} r={9} fill="none" stroke="var(--accent)" strokeWidth={2} />
          <path
            d={`M${kb.x - 14},${kb.y} H${kb.x + 14} M${kb.x},${kb.y - 14} V${kb.y + 14}`}
            stroke="var(--accent)"
            strokeWidth={2}
          />
        </g>
      ) : null}
    </>
  );

  return (
    <section aria-label="Whiteboard" className="flex flex-col gap-3">
      {!readOnly ? (
        <div
          role="toolbar"
          aria-label="Whiteboard tools"
          className="flex flex-wrap items-center gap-2"
        >
          {TOOLS.map((t) => (
            <Button
              key={t.id}
              size="sm"
              aria-pressed={tool === t.id}
              variant={tool === t.id ? 'primary' : 'secondary'}
              onClick={() => setTool(t.id)}
            >
              {t.label}
            </Button>
          ))}
          <span aria-hidden className="mx-1 h-5 w-px bg-border-strong" />
          <Button size="sm" onClick={addRect}>
            Add rectangle
          </Button>
          <Button size="sm" onClick={addArrow}>
            Add arrow
          </Button>
          <input
            aria-label="Text to place"
            value={text}
            maxLength={LIMITS.text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addText();
              }
            }}
            placeholder="Text for the board"
            className="h-8 w-44 rounded-md border border-border-control bg-surface-1 px-2 text-13 text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <Button size="sm" onClick={addText}>
            Add text
          </Button>
          <span aria-hidden className="mx-1 h-5 w-px bg-border-strong" />
          <div role="group" aria-label="Move the selected shape" className="flex gap-1">
            <Button
              size="sm"
              disabled={!selected}
              aria-label="Move left"
              onClick={() => move(-BIG, 0)}
            >
              ←
            </Button>
            <Button
              size="sm"
              disabled={!selected}
              aria-label="Move up"
              onClick={() => move(0, -BIG)}
            >
              ↑
            </Button>
            <Button
              size="sm"
              disabled={!selected}
              aria-label="Move down"
              onClick={() => move(0, BIG)}
            >
              ↓
            </Button>
            <Button
              size="sm"
              disabled={!selected}
              aria-label="Move right"
              onClick={() => move(BIG, 0)}
            >
              →
            </Button>
          </div>
          <Button size="sm" disabled={!selected} onClick={removeSelected}>
            Delete selected
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={shapes.length === 0}
            onClick={() => setConfirmClear(true)}
          >
            Clear board
          </Button>
        </div>
      ) : (
        <p
          role="status"
          className="rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-14"
        >
          Read-only board: you can see what is drawn but not draw on it.
        </p>
      )}
      {!readOnly ? (
        <p id={hintId} className="text-13 text-text-2">
          {tl.hint}
        </p>
      ) : null}

      <BoardCanvas
        ref={svgRef}
        shapes={shapes}
        selectedId={selectedId}
        drag={drag}
        overlay={overlay}
        label="Whiteboard canvas"
        describedBy={readOnly ? undefined : hintId}
        interactive={!readOnly}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        onFocus={() => setKb((k) => ({ ...k, focused: true }))}
        onBlur={() => setKb((k) => ({ ...k, focused: false }))}
        cursor={
          readOnly
            ? undefined
            : tool === 'select'
              ? 'default'
              : tool === 'eraser'
                ? 'cell'
                : 'crosshair'
        }
      />
      <p role="status" aria-live="polite" className="min-h-5 text-13 text-text-2">
        {message}
      </p>

      <section aria-label="Shapes on the board" className="flex flex-col gap-1">
        <h2 className="text-18 font-semibold">Shapes</h2>
        {shapes.length === 0 ? (
          <p className="text-13 text-text-3">Nothing has been drawn yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {shapes.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-pressed={s.id === selectedId}
                  disabled={readOnly}
                  onClick={() => {
                    setTool('select');
                    setSelectedId(s.id);
                  }}
                  className="rounded-md border border-border-strong px-2 py-1 text-13 aria-pressed:border-accent aria-pressed:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-100"
                >
                  <span
                    aria-hidden
                    className="mr-1 inline-block size-2 rounded-full"
                    style={{ background: `var(--presence-${s.c})` }}
                  />
                  {describe(s, i + 1)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent
          title="Clear the whole board?"
          description="Everyone in the room will see it empty. What was drawn stays in the replay."
        >
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                clearBoard(doc);
                setSelectedId(null);
                setConfirmClear(false);
                say('Board cleared.');
              }}
            >
              Clear board
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
