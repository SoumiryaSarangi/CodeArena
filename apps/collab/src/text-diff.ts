/**
 * CP-07 (FR-PAD-12): the smallest list of edits that turns one text into another, for restoring a snapshot as an
 * "anti-operation" on the live `Y.Text` instead of replacing it: what survives keeps its place (and everyone's cursor),
 * what others typed meanwhile is kept.
 *
 * It compares code points, never UTF-16 halves, so an edit can never split a surrogate pair (a lone half would not
 * survive the trip over the wire). Indices are UTF-16 offsets into the *original* text, as `Y.Text` wants them.
 */
export interface TextEdit {
  /** UTF-16 offset in the original text. */
  index: number;
  /** UTF-16 units to delete there. */
  delete: number;
  /** Text to insert there after the deletion. */
  insert: string;
}

/** Past this many differences the middle is replaced whole (Myers costs O(D²) memory). */
export const MAX_EDIT_DISTANCE = 1500;

/** Edits in ascending order of `index`. Apply them from the last to the first so earlier indices stay valid. */
export function diffText(from: string, to: string, maxDistance = MAX_EDIT_DISTANCE): TextEdit[] {
  if (from === to) return [];
  const a = Array.from(from, (c) => c.codePointAt(0)!);
  const b = Array.from(to, (c) => c.codePointAt(0)!);
  // unit offset of each code point boundary in `from`
  const unitAt = new Int32Array(a.length + 1);
  for (let i = 0; i < a.length; i++) unitAt[i + 1] = unitAt[i]! + (a[i]! > 0xffff ? 2 : 1);

  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const am = a.slice(lo, ea);
  const bm = b.slice(lo, eb);
  const str = (cps: number[], s: number, e: number) => String.fromCodePoint(...cps.slice(s, e));

  const whole = (): TextEdit[] => [
    { index: unitAt[lo]!, delete: unitAt[ea]! - unitAt[lo]!, insert: str(b, lo, eb) },
  ];
  if (am.length === 0 || bm.length === 0) return whole();

  const ops = myers(am, bm, maxDistance);
  if (!ops) return whole();

  // merge consecutive per-character operations into ranges
  const edits: TextEdit[] = [];
  let cur: { at: number; del: number; ins: number[] } | null = null;
  const flush = () => {
    if (!cur) return;
    edits.push({
      index: unitAt[lo + cur.at]!,
      delete: unitAt[lo + cur.at + cur.del]! - unitAt[lo + cur.at]!,
      insert: cur.ins.length ? String.fromCodePoint(...cur.ins) : '',
    });
    cur = null;
  };
  for (const op of ops) {
    if (cur && op.x === cur.at + cur.del) {
      if (op.ch === undefined) cur.del++;
      else cur.ins.push(op.ch);
    } else {
      flush();
      cur = { at: op.x, del: op.ch === undefined ? 1 : 0, ins: op.ch === undefined ? [] : [op.ch] };
    }
  }
  flush();
  return edits;
}

interface Op {
  /** Position in the original (middle) sequence. */
  x: number;
  /** Present for an insertion; absent for a deletion of the element at `x`. */
  ch?: number;
}

/** Myers' O(ND) shortest edit script. Returns the operations in ascending order, or null past `max` differences. */
function myers(a: number[], b: number[], max: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(max, n + m);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vv[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX)
      ops.push({ x, ch: b[prevY]! }); // insertion of b[prevY] before a[x]
    else ops.push({ x: prevX }); // deletion of a[prevX]
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Applies edits to a plain string (the reference the tests compare against). */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!;
    out = out.slice(0, e.index) + e.insert + out.slice(e.index + e.delete);
  }
  return out;
}
