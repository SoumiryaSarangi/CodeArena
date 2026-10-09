import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addShape,
  arrowPath,
  BOARD,
  bounds,
  clearBoard,
  deleteShape,
  describe as describeShape,
  extendStroke,
  LIMITS,
  moveShape,
  parseShape,
  penPath,
  readShapes,
  toBoard,
  type Shape,
} from '@/lib/whiteboard';

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};
const raw = (doc: Y.Doc, fields: Record<string, unknown>) => {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  doc.getArray<Y.Map<unknown>>('strokes').push([m]);
};

describe('FR-PAD-15: the shared whiteboard model', () => {
  it('FR-PAD-15: every kind of shape is added, read back in order and has its own id', () => {
    const doc = new Y.Doc();
    const ids = [
      addShape(doc, { k: 'pen', c: 1, p: [10, 10, 20, 20, 30, 15] }),
      addShape(doc, { k: 'rect', c: 2, x: 100, y: 100, w: 200, h: 80 }),
      addShape(doc, { k: 'arrow', c: 3, x1: 5, y1: 5, x2: 500, y2: 300 }),
      addShape(doc, { k: 'text', c: 4, x: 50, y: 400, t: 'O(n log n)' }),
    ];
    expect(ids.every((i) => typeof i === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(4);
    const shapes = readShapes(doc);
    expect(shapes.map((s) => s.k)).toEqual(['pen', 'rect', 'arrow', 'text']);
    expect(shapes.map((s) => s.c)).toEqual([1, 2, 3, 4]);
    expect(shapes[3]).toMatchObject({ t: 'O(n log n)', x: 50, y: 400 });
  });

  it('FR-PAD-15: the board holds at most 400 shapes, a stroke at most 4,000 numbers, a text 200 characters', () => {
    const doc = new Y.Doc();
    for (let i = 0; i < LIMITS.shapes; i++)
      expect(addShape(doc, { k: 'rect', c: 0, x: 1, y: 1, w: 5, h: 5 })).not.toBeNull();
    expect(addShape(doc, { k: 'rect', c: 0, x: 1, y: 1, w: 5, h: 5 })).toBeNull();
    expect(readShapes(doc)).toHaveLength(LIMITS.shapes);
    const d2 = new Y.Doc();
    addShape(d2, { k: 'pen', c: 0, p: Array.from({ length: 9000 }, (_, i) => i % 1000) });
    expect((readShapes(d2)[0] as Extract<Shape, { k: 'pen' }>).p.length).toBeLessThanOrEqual(
      LIMITS.penNumbers,
    );
    addShape(d2, { k: 'text', c: 0, x: 0, y: 30, t: 'x'.repeat(900) });
    expect((readShapes(d2)[1] as Extract<Shape, { k: 'text' }>).t).toHaveLength(LIMITS.text);
  });

  it('FR-PAD-15: empty, blank and one-number shapes are not added; coordinates are kept on the board', () => {
    const doc = new Y.Doc();
    expect(addShape(doc, { k: 'text', c: 0, x: 1, y: 1, t: '   ' })).toBeNull();
    expect(addShape(doc, { k: 'pen', c: 0, p: [5] })).toBeNull();
    addShape(doc, { k: 'rect', c: 99, x: -40, y: 5000, w: 99999, h: 10 });
    expect(readShapes(doc)[0]).toMatchObject({ c: 0, x: 0, y: BOARD.h, w: BOARD.w, h: 10 });
  });

  it('FR-PAD-15: what other clients wrote is checked: malformed, out-of-board, oversized and unknown shapes are skipped', () => {
    const doc = new Y.Doc();
    raw(doc, { id: 'a', k: 'rect', c: 1, x: 10, y: 10, w: 20, h: 20 }); // fine
    raw(doc, { id: 'b', k: 'rect', c: 1, x: Number.NaN, y: 10, w: 20, h: 20 });
    raw(doc, { id: 'c', k: 'rect', c: 1, x: 1e9, y: 10, w: 20, h: 20 });
    raw(doc, { id: 'd', k: 'rect', c: 1, x: Infinity, y: 10, w: 20, h: 20 });
    raw(doc, { id: 'e', k: 'rect', c: 1, x: '10', y: 10, w: 20, h: 20 });
    raw(doc, { id: 'f', k: 'script', c: 1 });
    raw(doc, { k: 'rect', c: 1, x: 1, y: 1, w: 1, h: 1 }); // no id
    raw(doc, { id: 'x'.repeat(200), k: 'rect', c: 1, x: 1, y: 1, w: 1, h: 1 });
    raw(doc, { id: 'g', k: 'pen', c: 1, p: [1, 2, 3] }); // odd length
    raw(doc, { id: 'h', k: 'pen', c: 1, p: new Array(LIMITS.penNumbers + 2).fill(5) });
    raw(doc, { id: 'i', k: 'pen', c: 1, p: 'not an array' });
    raw(doc, { id: 'j', k: 'text', c: 1, x: 1, y: 30, t: '' });
    raw(doc, { id: 'k', k: 'text', c: 1, x: 1, y: 30, t: 99 });
    raw(doc, { id: 'a', k: 'rect', c: 1, x: 99, y: 99, w: 1, h: 1 }); // a second shape with the id of the first
    doc.getArray('strokes').push(['not a map', 42, null] as never);
    const ids = readShapes(doc).map((s) => s.id);
    expect(ids).toEqual(['a']);
    expect(parseShape('x')).toBeNull();
    expect(parseShape(null)).toBeNull();
  });

  it('FR-PAD-15: the colour index is clamped to the palette and text is data, never markup', () => {
    const doc = new Y.Doc();
    raw(doc, { id: 'a', k: 'rect', c: 77, x: 1, y: 1, w: 5, h: 5 });
    raw(doc, { id: 'b', k: 'rect', c: 1.5, x: 1, y: 1, w: 5, h: 5 });
    raw(doc, { id: 'c', k: 'text', c: 2, x: 1, y: 40, t: '<img src=x onerror=alert(1)>' });
    const [a, b, c] = readShapes(doc);
    expect(a!.c).toBe(0);
    expect(b!.c).toBe(0);
    expect(c).toMatchObject({ k: 'text', t: '<img src=x onerror=alert(1)>' }); // rendered by React as text
    raw(doc, { id: 'd', k: 'text', c: 2, x: 1, y: 40, t: 'y'.repeat(5000) });
    expect((readShapes(doc)[3] as Extract<Shape, { k: 'text' }>).t).toHaveLength(LIMITS.text);
  });

  it('FR-PAD-15: erasing removes a shape once; erasing it again says it was already gone', () => {
    const doc = new Y.Doc();
    const a = addShape(doc, { k: 'rect', c: 0, x: 1, y: 1, w: 5, h: 5 })!;
    const b = addShape(doc, { k: 'rect', c: 0, x: 9, y: 9, w: 5, h: 5 })!;
    expect(deleteShape(doc, a)).toBe(true);
    expect(deleteShape(doc, a)).toBe(false);
    expect(readShapes(doc).map((s) => s.id)).toEqual([b]);
    clearBoard(doc);
    expect(readShapes(doc)).toEqual([]);
    clearBoard(doc); // empty: nothing to do
  });

  it('FR-PAD-15: moving shifts every kind of shape and never takes one off the board', () => {
    const doc = new Y.Doc();
    const r = addShape(doc, { k: 'rect', c: 0, x: 100, y: 100, w: 50, h: 40 })!;
    const p = addShape(doc, { k: 'pen', c: 0, p: [10, 10, 30, 40] })!;
    const a = addShape(doc, { k: 'arrow', c: 0, x1: 0, y1: 0, x2: 100, y2: 50 })!;
    const t = addShape(doc, { k: 'text', c: 0, x: 200, y: 300, t: 'hi' })!;
    for (const id of [r, p, a, t]) expect(moveShape(doc, id, 8, 16)).toBe(true);
    const [rs, ps, as, ts] = readShapes(doc);
    expect(rs).toMatchObject({ x: 108, y: 116 });
    expect((ps as Extract<Shape, { k: 'pen' }>).p).toEqual([18, 26, 38, 56]);
    expect(as).toMatchObject({ x1: 8, y1: 16, x2: 108, y2: 66 });
    expect(ts).toMatchObject({ x: 208, y: 316 });
    // far past the edges: the shape stops at the edge instead of leaving
    moveShape(doc, r, -5000, -5000);
    expect(readShapes(doc)[0]).toMatchObject({ x: 0, y: 0 });
    moveShape(doc, r, 99999, 99999);
    const after = readShapes(doc)[0] as Extract<Shape, { k: 'rect' }>;
    expect(after.x + after.w).toBe(BOARD.w);
    expect(after.y + after.h).toBe(BOARD.h);
    expect(moveShape(doc, 'no-such-id', 1, 1)).toBe(false);
  });

  it('FR-PAD-15: two clients drawing, erasing and moving at the same time end with the same board', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const shared = addShape(a, { k: 'rect', c: 0, x: 100, y: 100, w: 50, h: 50 })!;
    const other = addShape(a, { k: 'text', c: 0, x: 10, y: 50, t: 'shared' })!;
    sync(a, b);
    // at the same time: a erases the rectangle, b moves it; a adds a stroke, b adds an arrow; b erases the text, a moves it
    deleteShape(a, shared);
    moveShape(b, shared, 30, 30);
    addShape(a, { k: 'pen', c: 1, p: [1, 1, 9, 9] });
    addShape(b, { k: 'arrow', c: 2, x1: 0, y1: 0, x2: 50, y2: 50 });
    deleteShape(b, other);
    moveShape(a, other, 5, 5);
    sync(a, b);
    const A = readShapes(a);
    const B = readShapes(b);
    expect(A).toEqual(B);
    expect(A.map((s) => s.k).sort()).toEqual(['arrow', 'pen']); // both erasures win, both additions stay
    expect(A.find((s) => s.id === shared)).toBeUndefined();
  });

  it('FR-PAD-15: a stroke only gains points that are far enough from the last one, and stops at its limit', () => {
    let p: number[] = [];
    p = extendStroke(p, 10, 10);
    p = extendStroke(p, 10.5, 10.5);
    expect(p).toEqual([10, 10]);
    p = extendStroke(p, 20, 10);
    expect(p).toEqual([10, 10, 20, 10]);
    let big: number[] = [];
    for (let i = 0; i < 5000; i++) big = extendStroke(big, i % 1100, (i * 7) % 700);
    expect(big.length).toBeLessThanOrEqual(LIMITS.penNumbers);
  });

  it('FR-PAD-15: paths: a pen stroke is a closed outline (a single tap too), an arrow has a shaft and a head at its end', () => {
    const d = penPath([10, 10, 40, 30, 80, 20]);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(penPath([50, 50]).startsWith('M')).toBe(true); // a dot
    expect(penPath([])).toBe('');
    const arrow = arrowPath(0, 0, 100, 0);
    expect(arrow.match(/M/g)).toHaveLength(2);
    expect(arrow).toContain('L100,0');
    expect(arrow.startsWith('M0,0 L100,0')).toBe(true);
  });

  it('FR-PAD-15: pointer positions are turned into board positions through the letterbox, and clamped', () => {
    // a wide element: the board is centred, with margins left and right
    const rect = { left: 0, top: 0, width: 2400, height: 800 };
    expect(toBoard(rect, 1200, 400)).toEqual({ x: 600, y: 400 });
    expect(toBoard(rect, 600, 0)).toEqual({ x: 0, y: 0 }); // the left edge of the board
    expect(toBoard(rect, 0, 0)).toEqual({ x: 0, y: 0 }); // in the margin: clamped
    expect(toBoard(rect, 99999, 99999)).toEqual({ x: BOARD.w, y: BOARD.h });
    const tall = { left: 10, top: 20, width: 600, height: 1000 };
    const mid = toBoard(tall, 10 + 300, 20 + 500);
    expect(mid.x).toBeCloseTo(600, 5);
    expect(mid.y).toBeCloseTo(400, 5);
  });

  it('FR-PAD-15: shapes have boxes and readable names', () => {
    const doc = new Y.Doc();
    addShape(doc, { k: 'arrow', c: 0, x1: 300, y1: 200, x2: 100, y2: 50 });
    addShape(doc, { k: 'text', c: 0, x: 40, y: 300, t: 'Binary search' });
    const [arrow, text] = readShapes(doc);
    expect(bounds(arrow!)).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(bounds(text!).x).toBe(40);
    expect(describeShape(arrow!, 1)).toBe('Arrow 1');
    expect(describeShape(text!, 2)).toBe('Text 2: Binary search');
  });
});
