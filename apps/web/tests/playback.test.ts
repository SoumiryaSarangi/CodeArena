import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { addShape, clearBoard, deleteShape, moveShape } from '@/lib/whiteboard';
import {
  CHUNK,
  IDLE_SKIP_MS,
  KIND_CHECKPOINT,
  KIND_UPDATE,
  Player,
  parseFrame,
  type Frame,
  type Rec,
  type Slice,
  type SliceSource,
} from '@/lib/playback';

const START = Date.UTC(2026, 9, 10, 14, 0, 0);
const EVERY = 50; // checkpoint interval of this fake log

/** A recorded session: real Yjs updates with times, as the collab server would have logged them. */
function session() {
  const src = new Y.Doc({ gc: false });
  const log: Rec[] = [];
  let now = START;
  src.on('update', (u: Uint8Array) =>
    log.push({ kind: KIND_UPDATE, seq: log.length + 1, ts: now, bytes: u }),
  );
  const text = src.getText('code');
  // 40 s of steady typing (a character every 200 ms), a 3-minute silence, then 20 s of typing again, then a language change
  for (let i = 0; i < 200; i++) {
    now += 200;
    text.insert(text.length, String.fromCharCode(97 + (i % 26)));
  }
  now += 180_000;
  for (let i = 0; i < 100; i++) {
    now += 200;
    text.insert(0, 'Z');
  }
  now += 1000;
  src.getMap('meta').set('language', 'python3');
  const end = now + 2000;
  // checkpoints exactly at EVERY, 2·EVERY, …
  const cks = new Map<number, Uint8Array>();
  const doc = new Y.Doc({ gc: false });
  for (const r of log) {
    Y.applyUpdate(doc, r.bytes);
    if (r.seq % EVERY === 0) cks.set(r.seq, Y.encodeStateAsUpdate(doc));
  }
  return { log, cks, end, text: () => text.toString() };
}

/** The server's logic on in-memory arrays, counting what it sends. */
function fakeSource(s: ReturnType<typeof session>) {
  const stats = { seeks: 0, chunks: 0, maxRecords: 0, maxChunk: 0 };
  const source: SliceSource = {
    async seek(toTs): Promise<Slice> {
      stats.seeks++;
      const upTo = s.log.filter((r) => r.ts <= toTs).at(-1)?.seq ?? 0;
      const ck = [...s.cks.keys()].filter((k) => k <= upTo).at(-1);
      const records: Rec[] = [];
      if (ck)
        records.push({
          kind: KIND_CHECKPOINT,
          seq: ck,
          ts: s.log[ck - 1]!.ts,
          bytes: s.cks.get(ck)!,
        });
      records.push(...s.log.filter((r) => r.seq > (ck ?? 0) && r.seq <= upTo));
      stats.maxRecords = Math.max(stats.maxRecords, records.length);
      return { records, fromSeq: ck ?? 0, toSeq: upTo };
    },
    async chunk(fromSeq, limit): Promise<Slice> {
      stats.chunks++;
      const records = s.log.filter((r) => r.seq > fromSeq).slice(0, limit);
      stats.maxChunk = Math.max(stats.maxChunk, records.length);
      return { records, fromSeq, toSeq: records.at(-1)?.seq ?? fromSeq };
    },
  };
  return { source, stats };
}

const textAt = (s: ReturnType<typeof session>, t: number) => {
  const d = new Y.Doc({ gc: false });
  for (const r of s.log) if (r.ts <= t) Y.applyUpdate(d, r.bytes);
  return d.getText('code').toString();
};

function make() {
  const s = session();
  const { source, stats } = fakeSource(s);
  const frames: Frame[] = [];
  const player = new Player({
    source,
    startMs: START,
    endMs: s.end,
    lastSeq: s.log.length,
    onFrame: (f) => frames.push(f),
  });
  return { s, stats, frames, player, last: () => frames.at(-1)! };
}

describe('FR-PAD-10: the binary answer', () => {
  it('parses records the way the server writes them', () => {
    const rec = (kind: number, seq: number, ts: number, bytes: number[]) => {
      const b = new Uint8Array(17 + bytes.length);
      const v = new DataView(b.buffer);
      v.setUint8(0, kind);
      v.setUint32(1, seq);
      v.setFloat64(5, ts);
      v.setUint32(13, bytes.length);
      b.set(bytes, 17);
      return b;
    };
    const buf = new Uint8Array([
      ...rec(0, 200, 1.5e12, [1, 2, 3]),
      ...rec(1, 201, 1.5e12 + 9, []),
      ...rec(1, 202, 1.5e12 + 10, [9]),
    ]);
    const out = parseFrame(buf.buffer);
    expect(out.map((r) => [r.kind, r.seq, r.ts, [...r.bytes]])).toEqual([
      [0, 200, 1.5e12, [1, 2, 3]],
      [1, 201, 1.5e12 + 9, []],
      [1, 202, 1.5e12 + 10, [9]],
    ]);
    expect(parseFrame(new ArrayBuffer(0))).toEqual([]);
  });
});

describe('FR-PAD-10: seeking', () => {
  it('shows the document exactly as it was at any moment, from a checkpoint and a short tail', async () => {
    const { s, stats, player, last } = make();
    for (const t of [
      START,
      START + 1000,
      START + 7300,
      START + 39_999,
      START + 40_200,
      START + 100_000,
      s.end - 1500,
      s.end,
    ]) {
      await player.seek(t);
      expect(last().text, `at +${t - START} ms`).toBe(textAt(s, t));
    }
    expect(stats.maxRecords).toBeLessThanOrEqual(1 + EVERY); // never more than a checkpoint and one interval
  });

  it('clamps to the session, and reads the language from the replayed document', async () => {
    const { s, player, last } = make();
    await player.seek(START - 99_999);
    expect(last()).toMatchObject({ at: START, text: '', language: null });
    await player.seek(s.end + 99_999);
    expect(last().at).toBe(s.end);
    expect(last().text).toBe(s.text());
    expect(last().language).toBe('python3');
  });

  it('a seek that is overtaken by a later one does not show', async () => {
    const s = session();
    const base = fakeSource(s).source;
    let release: () => void = () => undefined;
    const slow: SliceSource = {
      ...base,
      seek: async (t) =>
        t < START + 5000 ? new Promise((r) => (release = () => r(base.seek(t)))) : base.seek(t),
    };
    const frames: Frame[] = [];
    const player = new Player({
      source: slow,
      startMs: START,
      endMs: s.end,
      lastSeq: s.log.length,
      onFrame: (f) => frames.push(f),
    });
    const first = player.seek(START + 1000); // slow
    await player.seek(START + 30_000);
    release();
    await first;
    expect(frames.at(-1)!.at).toBe(START + 30_000);
    expect(frames.at(-1)!.text).toBe(textAt(s, START + 30_000));
  });
});

describe('FR-PAD-10: playing at 1×, 2× and 4×', () => {
  const run = async (speed: number, realMs: number) => {
    const m = make();
    await m.player.seek(START);
    m.player.play(speed);
    for (let spent = 0; spent < realMs; spent += 50) await m.player.advance(50);
    return m;
  };

  it('moves through the session at the chosen speed: twice and four times as far in the same time', async () => {
    const a = await run(1, 4000);
    const b = await run(2, 4000);
    const c = await run(4, 4000);
    expect(a.player.position - START).toBe(4000);
    expect(b.player.position - START).toBe(8000);
    expect(c.player.position - START).toBe(16000);
    for (const m of [a, b, c]) expect(m.last().text).toBe(textAt(m.s, m.player.position));
    expect(a.last().text.length).toBeLessThan(b.last().text.length);
    expect(b.last().text.length).toBeLessThan(c.last().text.length);
  });

  it('does not move while paused, and carries on from where it stopped', async () => {
    const m = make();
    await m.player.seek(START);
    m.player.play(1);
    for (let i = 0; i < 20; i++) await m.player.advance(50);
    m.player.pause();
    const at = m.player.position;
    for (let i = 0; i < 40; i++) await m.player.advance(50);
    expect(m.player.position).toBe(at);
    m.player.play(1);
    for (let i = 0; i < 20; i++) await m.player.advance(50);
    expect(m.player.position - at).toBe(1000);
  });

  it('skips a long silence instead of waiting through it, and still shows everything after it', async () => {
    const m = make();
    await m.player.seek(START + 39_000); // just before the 3-minute pause
    m.player.play(1);
    let spent = 0;
    while (!m.last().ended && spent < 60_000) {
      await m.player.advance(50);
      spent += 50;
    }
    expect(m.last().ended).toBe(true);
    expect(spent).toBeLessThan(60_000); // 3 minutes of silence did not take 3 minutes
    expect(spent).toBeGreaterThan(IDLE_SKIP_MS / 2);
    expect(m.last().text).toBe(m.s.text());
    expect(m.last().language).toBe('python3');
  });

  it('stops at the end, ends once, and cannot be started again from the end', async () => {
    const m = make();
    await m.player.seek(m.s.end - 600);
    m.player.play(4);
    for (let i = 0; i < 30; i++) await m.player.advance(50);
    expect(m.last()).toMatchObject({ ended: true, playing: false, at: m.s.end });
    m.player.play(1);
    expect(m.player.playing).toBe(false);
  });

  it('fetches ahead in small pieces, never the whole log at once, and a seek during playing discards what was on its way', async () => {
    const m = make();
    await m.player.seek(START);
    m.player.play(4);
    for (let i = 0; i < 200; i++) await m.player.advance(50);
    expect(m.stats.chunks).toBeGreaterThan(0);
    expect(m.stats.maxChunk).toBeLessThanOrEqual(CHUNK);
    const before = m.player.position;
    await m.player.seek(START + 100_000);
    expect(m.last().text).toBe(textAt(m.s, START + 100_000));
    await m.player.advance(50);
    expect(m.last().text).toBe(textAt(m.s, m.player.position));
    expect(m.player.position).toBeGreaterThan(before);
  });
});

describe('FR-PAD-10: a slice that arrives after the viewer jumped elsewhere', () => {
  it('is thrown away: it belongs to a moment that is no longer shown', async () => {
    const s = session();
    const base = fakeSource(s).source;
    let release: () => void = () => undefined;
    let held = false;
    const source: SliceSource = {
      ...base,
      chunk: (from, limit) => {
        if (from === 200 && !held) {
          held = true;
          return new Promise((r) => (release = () => r(base.chunk(from, limit)))); // the chunk after update 200 is slow
        }
        return base.chunk(from, limit);
      },
    };
    const frames: Frame[] = [];
    const player = new Player({
      source,
      startMs: START,
      endMs: s.end,
      lastSeq: s.log.length,
      onFrame: (f) => frames.push(f),
    });
    await player.seek(START + 60_000); // in the silence: updates 1…200 are in
    player.play(4);
    void player.advance(50); // asks for what follows update 200: held
    await player.seek(START); // the viewer jumps back to the beginning
    release(); // the old answer (updates after 200) arrives now
    await new Promise((r) => setTimeout(r, 10));
    player.play(4);
    let spent = 0;
    while (!frames.at(-1)!.ended && spent < 120_000) {
      await player.advance(50);
      spent += 50;
    }
    expect(frames.at(-1)!.ended).toBe(true);
    expect(frames.at(-1)!.text).toBe(s.text()); // the whole session, including the first 200 characters
  });
});

describe('FR-PAD-15: the whiteboard is part of the replay', () => {
  /** Code typing and board work interleaved, one update each, a second apart. */
  function boardSession() {
    const src = new Y.Doc({ gc: false });
    const log: Rec[] = [];
    let now = START;
    src.on('update', (u: Uint8Array) =>
      log.push({ kind: KIND_UPDATE, seq: log.length + 1, ts: now, bytes: u }),
    );
    const at: Record<string, number> = {};
    const step = (name: string, fn: () => void) => {
      now += 1000;
      at[name] = now;
      fn();
    };
    let rect = '';
    step('type', () => src.getText('code').insert(0, 'int main() {}'));
    step('rect', () => {
      rect = addShape(src, { k: 'rect', c: 1, x: 100, y: 100, w: 200, h: 100 })!;
    });
    step('pen', () => void addShape(src, { k: 'pen', c: 2, p: [10, 10, 60, 40, 90, 20] }));
    step('move', () => void moveShape(src, rect, 50, 0));
    step('type2', () => src.getText('code').insert(0, '// '));
    step('erase', () => void deleteShape(src, rect));
    step('arrow', () => void addShape(src, { k: 'arrow', c: 3, x1: 0, y1: 0, x2: 80, y2: 80 }));
    step('clear', () => clearBoard(src));
    const end = now + 1000;
    return { log, cks: new Map<number, Uint8Array>(), end, at };
  }

  const play = async (s: ReturnType<typeof boardSession>, t: number) => {
    const { source } = fakeSource(s as never);
    const frames: Frame[] = [];
    const player = new Player({
      source,
      startMs: START,
      endMs: s.end,
      lastSeq: s.log.length,
      onFrame: (f) => frames.push(f),
    });
    await player.seek(t);
    return { frames, player, last: () => frames.at(-1)! };
  };

  it('FR-PAD-15: a seek shows the board exactly as it was at that moment', async () => {
    const s = boardSession();
    const kinds = async (t: number) => (await play(s, t)).last().shapes.map((x) => x.k);
    expect(await kinds(START)).toEqual([]);
    expect(await kinds(s.at.type!)).toEqual([]);
    expect(await kinds(s.at.rect!)).toEqual(['rect']);
    expect(await kinds(s.at.pen!)).toEqual(['rect', 'pen']);
    expect(await kinds(s.at.erase!)).toEqual(['pen']); // the rectangle was erased
    expect(await kinds(s.at.arrow!)).toEqual(['pen', 'arrow']);
    expect(await kinds(s.at.clear!)).toEqual([]);
    expect(await kinds(s.end)).toEqual([]);
  });

  it('FR-PAD-15: a move is seen where it happened: the rectangle is at its old place before the move, the new one after', async () => {
    const s = boardSession();
    const x = async (t: number) => {
      const r = (await play(s, t)).last().shapes.find((q) => q.k === 'rect');
      return r?.k === 'rect' ? r.x : null;
    };
    expect(await x(s.at.pen!)).toBe(100);
    expect(await x(s.at.move!)).toBe(150);
  });

  it('FR-PAD-15: playing forward adds shapes when their time comes, and typing code alone does not rebuild the board', async () => {
    const s = boardSession();
    const { source } = fakeSource(s as never);
    const frames: Frame[] = [];
    const player = new Player({
      source,
      startMs: START,
      endMs: s.end,
      lastSeq: s.log.length,
      onFrame: (f) => frames.push(f),
    });
    await player.seek(START);
    player.play(1);
    for (let i = 0; i < 12; i++) await player.advance(1000);
    expect(frames.at(-1)!.shapes).toEqual([]); // cleared at the end
    const counts = frames.map((f) => f.shapes.length);
    expect(Math.max(...counts)).toBe(2); // rectangle and pen, later pen and arrow
    // while only the code changed (type2), the frame carries the very same array of shapes
    const around = frames.filter((f) => f.text.startsWith('// ') && f.shapes.length === 2);
    expect(around.length).toBeGreaterThan(0);
    const same = frames.filter(
      (f, i) => i > 0 && f.shapes.length > 0 && f.shapes === frames[i - 1]!.shapes,
    );
    expect(same.length).toBeGreaterThan(0);
  });
});
