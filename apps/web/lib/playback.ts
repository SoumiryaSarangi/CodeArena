import * as Y from 'yjs';
import { readShapes, type Shape } from './whiteboard';

/** CP-06 (FR-PAD-10): replaying a room's document from its update log, in the browser. No DOM, no network of its own. */

export const KIND_CHECKPOINT = 0;
export const KIND_UPDATE = 1;
/** A silence longer than this is skipped while playing: nobody watches five seconds of nothing. */
export const IDLE_SKIP_MS = 5000;
/** How many updates are fetched at a time while playing, and when the next batch is asked for. */
export const CHUNK = 500;
export const PREFETCH_BELOW = 150;

export interface Rec {
  kind: number;
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  bytes: Uint8Array;
}

/** The server's binary answer: `[u8 kind][u32 seq][f64 ts][u32 length][bytes]`, big-endian, repeated. */
export function parseFrame(buf: ArrayBuffer): Rec[] {
  const view = new DataView(buf);
  const out: Rec[] = [];
  let at = 0;
  while (at + 17 <= buf.byteLength) {
    const len = view.getUint32(at + 13);
    out.push({
      kind: view.getUint8(at),
      seq: view.getUint32(at + 1),
      ts: view.getFloat64(at + 5),
      bytes: new Uint8Array(buf.slice(at + 17, at + 17 + len)),
    });
    at += 17 + len;
  }
  return out;
}

export interface Slice {
  records: Rec[];
  fromSeq: number;
  toSeq: number;
}

/** Where slices come from: the API, or a fake in tests. */
export interface SliceSource {
  /** The document at a moment: the last checkpoint at or before it, and the updates after it up to it. */
  seek(toTs: number): Promise<Slice>;
  /** The updates after `fromSeq` (at most `limit`). */
  chunk(fromSeq: number, limit: number): Promise<Slice>;
}

export interface Frame {
  text: string;
  /** The whiteboard at that moment (CP-10); the same array while it has not changed. */
  shapes: Shape[];
  language: string | null;
  /** The moment shown, epoch ms. */
  at: number;
  playing: boolean;
  ended: boolean;
}

export interface PlayerOptions {
  source: SliceSource;
  startMs: number;
  endMs: number;
  lastSeq: number;
  onFrame: (f: Frame) => void;
}

/**
 * Shows the document as it was at any moment of a session. `seek` builds a fresh document from a checkpoint and the
 * updates after it; `advance(ms)` (called by a timer in the page, by hand in tests) moves the moment forward by `ms` of
 * real time times the speed, applying each update when its time comes, and skips long silences.
 */
export class Player {
  private doc = new Y.Doc({ gc: false });
  private shapes: Shape[] = [];
  private shapesDirty = true;
  private at: number;
  private seq = 0; // the last update applied
  private fetched = 0; // the last update fetched
  private pending: Rec[] = [];
  private loading: Promise<void> | null = null;
  private generation = 0; // a seek makes any fetch still in flight stale
  speed = 1;
  playing = false;
  ended = false;

  constructor(private readonly o: PlayerOptions) {
    this.at = o.startMs;
    this.watchBoard(this.doc);
  }

  /** The board is read again only when it changed, not on every keystroke of the code. */
  private watchBoard(doc: Y.Doc) {
    this.shapesDirty = true;
    doc.getArray('strokes').observeDeep(() => {
      this.shapesDirty = true;
    });
  }

  get position() {
    return this.at;
  }

  private emit() {
    if (this.shapesDirty) {
      this.shapes = readShapes(this.doc);
      this.shapesDirty = false;
    }
    this.o.onFrame({
      text: this.doc.getText('code').toString(),
      shapes: this.shapes,
      language: (this.doc.getMap('meta').get('language') as string | undefined) ?? null,
      at: this.at,
      playing: this.playing,
      ended: this.ended,
    });
  }

  /** Moves to a moment (clamped to the session) and shows the document as it was then. */
  async seek(t: number): Promise<void> {
    const at = Math.min(this.o.endMs, Math.max(this.o.startMs, t));
    const generation = ++this.generation;
    const slice = await this.o.source.seek(at);
    if (generation !== this.generation) return; // a later seek won
    const doc = new Y.Doc({ gc: false });
    for (const r of slice.records) Y.applyUpdate(doc, r.bytes);
    this.doc.destroy();
    this.doc = doc;
    this.watchBoard(doc);
    this.at = at;
    this.seq = slice.toSeq;
    this.fetched = slice.toSeq;
    this.pending = [];
    this.ended = at >= this.o.endMs && this.fetched >= this.o.lastSeq;
    this.emit();
  }

  play(speed = this.speed) {
    this.speed = speed;
    if (this.ended) return;
    this.playing = true;
    this.emit();
  }

  pause() {
    this.playing = false;
    this.emit();
  }

  setSpeed(speed: number) {
    this.speed = speed;
  }

  private async more(): Promise<void> {
    if (this.loading || this.fetched >= this.o.lastSeq) return this.loading ?? undefined;
    const generation = this.generation;
    this.loading = (async () => {
      const slice = await this.o.source.chunk(this.fetched, CHUNK);
      if (generation !== this.generation) return; // the viewer moved on while this was on its way
      this.pending.push(
        ...slice.records.filter((r) => r.kind === KIND_UPDATE && r.seq > this.fetched),
      );
      this.fetched = Math.max(this.fetched, slice.toSeq);
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Real time passed: move the moment on and apply what is due. Does nothing while paused. */
  async advance(realMs: number): Promise<void> {
    if (!this.playing) return;
    if (this.pending.length < PREFETCH_BELOW) void this.more();
    if (this.pending.length === 0 && this.fetched < this.o.lastSeq) await this.more();

    let target = this.at + realMs * this.speed;
    const next = this.pending[0];
    // a long silence before the next update (or the end) is skipped, leaving a second of it
    const upcoming = next ? next.ts : this.o.endMs;
    if (upcoming - target > IDLE_SKIP_MS) target = upcoming - 1000;

    let changed = false;
    while (this.pending.length > 0 && this.pending[0]!.ts <= target) {
      Y.applyUpdate(this.doc, this.pending.shift()!.bytes);
      this.seq++;
      changed = true;
    }
    this.at = Math.min(target, this.o.endMs);
    if (this.at >= this.o.endMs && this.pending.length === 0 && this.fetched >= this.o.lastSeq) {
      this.ended = true;
      this.playing = false;
      changed = true;
    }
    if (changed || this.playing) this.emit();
  }

  destroy() {
    this.playing = false;
    this.doc.destroy();
  }
}
