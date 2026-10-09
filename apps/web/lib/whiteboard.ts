import { getStroke } from 'perfect-freehand';
import * as Y from 'yjs';

/**
 * CP-10 (FR-PAD-15, US-10.9): the shared whiteboard. Every shape is a `Y.Map` in `Y.Array('strokes')` of the room's document,
 * so it syncs, is stored and logged with the code, and a replay of the room replays the board too. A shape is added whole
 * when it is finished (not point by point: the document keeps its history, and a long stroke updated on every move would
 * fill it), erased by removing it from the array, and moved by changing its coordinates.
 *
 * What other clients wrote is untrusted: `parseShape` accepts only shapes of the known kinds with finite numbers inside
 * the board, bounded sizes and a text that is only ever rendered as text, and skips anything else.
 */
export const BOARD = { w: 1200, h: 800 } as const;
export const LIMITS = { shapes: 400, penNumbers: 4000, text: 200, presence: 8 } as const;

export type Kind = 'pen' | 'rect' | 'arrow' | 'text';

interface Base {
  id: string;
  /** Presence colour index 0..7 (the author's colour in the room, from the same palette as the cursors). */
  c: number;
}
export type Shape =
  | (Base & { k: 'pen'; p: number[] })
  | (Base & { k: 'rect'; x: number; y: number; w: number; h: number })
  | (Base & { k: 'arrow'; x1: number; y1: number; x2: number; y2: number })
  | (Base & { k: 'text'; x: number; y: number; t: string });

/** A shape without the id, as the tools produce it. */
export type NewShape =
  | { k: 'pen'; c: number; p: number[] }
  | { k: 'rect'; c: number; x: number; y: number; w: number; h: number }
  | { k: 'arrow'; c: number; x1: number; y1: number; x2: number; y2: number }
  | { k: 'text'; c: number; x: number; y: number; t: string };

const strokes = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>('strokes');

const inBoard = (n: unknown, max: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= -50 && n <= max + 50;
export const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));
const colour = (c: unknown) =>
  typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < LIMITS.presence ? c : 0;

/** One shape from the document, or null if it is not a well-formed shape. */
export function parseShape(m: unknown): Shape | null {
  if (!(m instanceof Y.Map)) return null;
  const id = m.get('id');
  const k = m.get('k');
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  const base = { id, c: colour(m.get('c')) };
  const num = (key: string, max: number) => {
    const v = m.get(key);
    return inBoard(v, max) ? v : null;
  };
  if (k === 'rect') {
    const x = num('x', BOARD.w);
    const y = num('y', BOARD.h);
    const w = num('w', BOARD.w);
    const h = num('h', BOARD.h);
    return x === null || y === null || w === null || h === null ? null : { ...base, k, x, y, w, h };
  }
  if (k === 'arrow') {
    const x1 = num('x1', BOARD.w);
    const y1 = num('y1', BOARD.h);
    const x2 = num('x2', BOARD.w);
    const y2 = num('y2', BOARD.h);
    return x1 === null || y1 === null || x2 === null || y2 === null
      ? null
      : { ...base, k, x1, y1, x2, y2 };
  }
  if (k === 'text') {
    const x = num('x', BOARD.w);
    const y = num('y', BOARD.h);
    const t = m.get('t');
    if (x === null || y === null || typeof t !== 'string' || t.length === 0) return null;
    return { ...base, k, x, y, t: t.slice(0, LIMITS.text) };
  }
  if (k === 'pen') {
    const p = m.get('p');
    if (!Array.isArray(p) || p.length < 2 || p.length > LIMITS.penNumbers || p.length % 2 !== 0)
      return null;
    for (let i = 0; i < p.length; i++)
      if (!inBoard(p[i], i % 2 === 0 ? BOARD.w : BOARD.h)) return null;
    return { ...base, k, p: p as number[] };
  }
  return null;
}

/** Every well-formed shape, in drawing order (the later one is on top). */
export function readShapes(doc: Y.Doc): Shape[] {
  const out: Shape[] = [];
  const seen = new Set<string>();
  for (const m of strokes(doc).toArray()) {
    const s = parseShape(m);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/** Adds a finished shape. Returns its id, or null when the board is full or the shape is empty or malformed. */
export function addShape(doc: Y.Doc, shape: NewShape): string | null {
  if (strokes(doc).length >= LIMITS.shapes) return null;
  const m = new Y.Map<unknown>();
  const id = newId();
  m.set('id', id);
  m.set('k', shape.k);
  m.set('c', colour(shape.c));
  if (shape.k === 'pen') {
    const p = shape.p
      .slice(0, LIMITS.penNumbers - (LIMITS.penNumbers % 2))
      .map((n, i) => clamp(n, i % 2 === 0 ? BOARD.w : BOARD.h));
    if (p.length < 2) return null;
    m.set('p', p);
  } else if (shape.k === 'rect') {
    m.set('x', clamp(shape.x, BOARD.w));
    m.set('y', clamp(shape.y, BOARD.h));
    m.set('w', clamp(shape.w, BOARD.w));
    m.set('h', clamp(shape.h, BOARD.h));
  } else if (shape.k === 'arrow') {
    m.set('x1', clamp(shape.x1, BOARD.w));
    m.set('y1', clamp(shape.y1, BOARD.h));
    m.set('x2', clamp(shape.x2, BOARD.w));
    m.set('y2', clamp(shape.y2, BOARD.h));
  } else {
    const t = shape.t.trim().slice(0, LIMITS.text);
    if (t.length === 0) return null;
    m.set('x', clamp(shape.x, BOARD.w));
    m.set('y', clamp(shape.y, BOARD.h));
    m.set('t', t);
  }
  doc.transact(() => strokes(doc).push([m]));
  return id;
}

const find = (doc: Y.Doc, id: string) => {
  const arr = strokes(doc);
  for (let i = 0; i < arr.length; i++) if (arr.get(i).get('id') === id) return { i, m: arr.get(i) };
  return null;
};

/** Removes a shape. False if it was already gone (someone else erased it). */
export function deleteShape(doc: Y.Doc, id: string): boolean {
  const hit = find(doc, id);
  if (!hit) return false;
  doc.transact(() => strokes(doc).delete(hit.i, 1));
  return true;
}

/** Removes every shape. */
export function clearBoard(doc: Y.Doc): void {
  const arr = strokes(doc);
  if (arr.length > 0) doc.transact(() => arr.delete(0, arr.length));
}

/** Moves a shape by (dx, dy), keeping it on the board. */
export function moveShape(doc: Y.Doc, id: string, dx: number, dy: number): boolean {
  const hit = find(doc, id);
  const s = hit && parseShape(hit.m);
  if (!hit || !s) return false;
  const b = bounds(s);
  // the whole shape stays inside the board: limit the move by how far each edge may go
  const mx = Math.min(Math.max(dx, -b.x), BOARD.w - (b.x + b.w));
  const my = Math.min(Math.max(dy, -b.y), BOARD.h - (b.y + b.h));
  doc.transact(() => {
    const m = hit.m;
    if (s.k === 'pen')
      m.set(
        'p',
        s.p.map((n, i) => n + (i % 2 === 0 ? mx : my)),
      );
    else if (s.k === 'arrow') {
      m.set('x1', s.x1 + mx);
      m.set('y1', s.y1 + my);
      m.set('x2', s.x2 + mx);
      m.set('y2', s.y2 + my);
    } else {
      m.set('x', s.x + mx);
      m.set('y', s.y + my);
    }
  });
  return true;
}

/** The box a shape occupies (for the selection outline and for keeping a move on the board). */
export function bounds(s: Shape): { x: number; y: number; w: number; h: number } {
  if (s.k === 'pen') {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < s.p.length; i += 2) {
      x0 = Math.min(x0, s.p[i]!);
      x1 = Math.max(x1, s.p[i]!);
      y0 = Math.min(y0, s.p[i + 1]!);
      y1 = Math.max(y1, s.p[i + 1]!);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (s.k === 'rect') return { x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.k === 'arrow')
    return {
      x: Math.min(s.x1, s.x2),
      y: Math.min(s.y1, s.y2),
      w: Math.abs(s.x2 - s.x1),
      h: Math.abs(s.y2 - s.y1),
    };
  // text: about 11 board units per character at the size it is drawn, one line high
  return {
    x: s.x,
    y: s.y - TEXT_SIZE,
    w: Math.min(BOARD.w - s.x, s.t.length * TEXT_SIZE * 0.6),
    h: TEXT_SIZE * 1.3,
  };
}

export const TEXT_SIZE = 22;

/** A readable name for a shape, for the list of shapes and for screen readers. */
export function describe(s: Shape, n: number): string {
  const what = { pen: 'Pen stroke', rect: 'Rectangle', arrow: 'Arrow', text: 'Text' }[s.k];
  return s.k === 'text' ? `${what} ${n}: ${s.t.slice(0, 30)}` : `${what} ${n}`;
}

/** Points closer than this to the last one are dropped while drawing: smooth enough, and a stroke stays small. */
export const MIN_POINT_GAP = 2.5;

/** Adds a point to a stroke being drawn unless it is too close to the last one or the stroke is at its limit. */
export function extendStroke(points: number[], x: number, y: number): number[] {
  if (points.length >= LIMITS.penNumbers) return points;
  const n = points.length;
  if (n >= 2 && Math.hypot(x - points[n - 2]!, y - points[n - 1]!) < MIN_POINT_GAP) return points;
  return [...points, x, y];
}

/** The SVG path of a pen stroke: an outline from perfect-freehand, filled (so it has pressure-like width). */
export function penPath(p: number[], size = 5): string {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < p.length; i += 2) pts.push([p[i]!, p[i + 1]!]);
  if (pts.length === 1) pts.push([pts[0]![0] + 0.1, pts[0]![1]]);
  const outline = getStroke(pts, { size, thinning: 0.4, smoothing: 0.6, streamline: 0.4 });
  if (outline.length === 0) return '';
  const d = outline.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x!.toFixed(1)},${y!.toFixed(1)}`);
  return `${d.join(' ')} Z`;
}

/** An arrow: the shaft and a head of two short strokes at the end. */
export function arrowPath(x1: number, y1: number, x2: number, y2: number): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 16;
  const a = (da: number): [number, number] => [
    x2 - head * Math.cos(angle + da),
    y2 - head * Math.sin(angle + da),
  ];
  const [lx, ly] = a(Math.PI / 7);
  const [rx, ry] = a(-Math.PI / 7);
  return `M${x1},${y1} L${x2},${y2} M${lx.toFixed(1)},${ly.toFixed(1)} L${x2},${y2} L${rx.toFixed(1)},${ry.toFixed(1)}`;
}

/** Client coordinates to board coordinates, clamped to the board. */
export function toBoard(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  // the board is drawn "meet": letterboxed inside the element, so remove the margin first
  const scale = Math.min(rect.width / BOARD.w, rect.height / BOARD.h) || 1;
  const offX = (rect.width - BOARD.w * scale) / 2;
  const offY = (rect.height - BOARD.h * scale) / 2;
  return {
    x: clamp((clientX - rect.left - offX) / scale, BOARD.w),
    y: clamp((clientY - rect.top - offY) / scale, BOARD.h),
  };
}

/** The topmost shape whose box (a little enlarged) contains the point; used by the eraser's keyboard alternative. */
export function shapeAt(shapes: Shape[], x: number, y: number, pad = 10): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const b = bounds(shapes[i]!);
    if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad)
      return shapes[i]!;
  }
  return null;
}
