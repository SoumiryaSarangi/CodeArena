import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocSizeGuard, syncUpdateOf } from './doc-size';
import { createHarness, infrastructureUp } from './harness';
import { pause, until } from './test-support';

const varUint = (n: number) => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const frame = (name: string, type: number, sub: number, update: Uint8Array) =>
  Uint8Array.from([
    ...varUint(name.length),
    ...Buffer.from(name),
    ...varUint(type),
    ...varUint(sub),
    ...varUint(update.length),
    ...update,
  ]);
const insertUpdate = (doc: Y.Doc, at: number, s: string) => {
  let u: Uint8Array = new Uint8Array();
  doc.once('update', (x: Uint8Array) => (u = x));
  doc.getText('code').insert(at, s);
  return u;
};

describe('FR-PAD-13: the size cap, without a server', () => {
  it('FR-PAD-13: finds the update inside a sync message and ignores everything else', () => {
    const u = Uint8Array.from([1, 2, 3, 4, 5]);
    expect(syncUpdateOf(frame('room:x', 0, 2, u))).toEqual(u);
    expect(syncUpdateOf(frame('room:x', 0, 1, u))).toEqual(u);
    expect(syncUpdateOf(frame('room:x', 0, 0, u))).toBeNull(); // sync step 1
    expect(syncUpdateOf(frame('room:x', 1, 2, u))).toBeNull(); // awareness
    expect(syncUpdateOf(Uint8Array.from([5, 1]))).toBeNull(); // truncated
  });

  it('FR-PAD-13: refuses a change that would pass the cap and lets one that shrinks the document through', () => {
    const doc = new Y.Doc({ gc: false });
    const guard = new DocSizeGuard(300);
    const client = new Y.Doc({ gc: false });
    const small = insertUpdate(client, 0, 'a'.repeat(100));
    Y.applyUpdate(doc, small);
    expect(guard.allows(doc, frame('r', 0, 2, small))).toBe(true);
    const huge = insertUpdate(client, 100, 'b'.repeat(500));
    expect(guard.allows(doc, frame('r', 0, 2, huge))).toBe(false);
    // refused means not applied: the document is still the small one, and a modest change still fits
    const more = insertUpdate(new Y.Doc({ gc: false }), 0, 'c'.repeat(50));
    expect(guard.allows(doc, frame('r', 0, 2, more))).toBe(true);
    // fill it up, then a delete is allowed although the document is at the limit
    const filler = new Y.Doc({ gc: false });
    Y.applyUpdate(filler, Y.encodeStateAsUpdate(doc));
    const fill = insertUpdate(filler, 0, 'd'.repeat(120));
    Y.applyUpdate(doc, fill);
    const before = Y.encodeStateAsUpdate(doc).length;
    expect(before).toBeGreaterThan(250);
    let del: Uint8Array = new Uint8Array();
    filler.once('update', (x: Uint8Array) => (del = x));
    filler.getText('code').delete(0, 100);
    expect(guard.allows(doc, frame('r', 0, 2, del))).toBe(true);
  });
});

const ready = await infrastructureUp();

describe.skipIf(!ready)(
  'FR-PAD-13: the 2 MB cap on a room document (needs Compose Postgres + Redis)',
  () => {
    let h: Awaited<ReturnType<typeof createHarness>>;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h.close();
    });

    it('FR-PAD-13: a change past the cap is dropped, that connection is closed with the reason, the others are untouched', async () => {
      const inst = await h.startInstance({ maxDocBytes: 4000 });
      const room = await h.makeRoom();
      const a = await h.join(inst, room);
      const b = await h.join(inst, room);
      a.text.insert(0, 'fits '.repeat(100));
      await until(() => b.text.length === 500);

      let reason = '';
      a.provider.on('close', ({ event }: { event: { reason?: string } }) => {
        if (event.reason) reason = event.reason;
      });
      a.text.insert(500, 'x'.repeat(6000));
      await until(() => reason === 'document-too-large', 10_000);
      a.leave(); // like the pad: stop retrying a change the server will not take

      await pause(300);
      expect(b.text.length).toBe(500);
      expect(b.text.toString()).toBe('fits '.repeat(100));
      // the other client keeps editing, within the cap
      b.text.insert(500, ' more');
      await pause(300);
      const c = await h.join(inst, room);
      await until(() => c.text.toString() === 'fits '.repeat(100) + ' more');
      await inst.stop();
    }, 30_000);

    it('FR-PAD-13: edits and deletes well inside the cap keep being accepted, deleting included', async () => {
      const inst = await h.startInstance({ maxDocBytes: 3000 });
      const room = await h.makeRoom();
      const a = await h.join(inst, room);
      const b = await h.join(inst, room);
      for (let i = 0; i < 10; i++) {
        a.text.insert(a.text.length, 'y'.repeat(150));
        await pause(20);
      }
      await until(() => b.text.length === 1500);
      b.text.delete(0, 1400);
      await until(() => a.text.length === 100);
      a.text.insert(100, 'z'.repeat(1000));
      await until(() => b.text.length === 1100);
      await inst.stop();
    }, 30_000);

    it('FR-PAD-13: a document already over the cap still loads and can be read', async () => {
      const room = await h.makeRoom();
      const big = await h.startInstance({ maxDocBytes: 100_000 });
      const a = await h.join(big, room);
      a.text.insert(0, 'w'.repeat(5000));
      await pause(500);
      a.leave();
      await pause(500);
      await big.stop();
      const small = await h.startInstance({ maxDocBytes: 1000 });
      const b = await h.join(small, room);
      await until(() => b.text.length === 5000);
      await small.stop();
    }, 30_000);
  },
);
