import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { diffText } from './text-diff';

/**
 * CP-08 (FR-PAD-07, FR-PAD-11, FR-PAD-12): the guarantee under everything else in the pad. A handful of replicas (browsers,
 * and one that plays the server with `gc: false`) make random concurrent edits, language changes and version restores, and
 * their updates arrive late, out of order and more than once. Wherever the run stops, once everything has been delivered
 * every replica holds the same document, and it equals replaying all the updates into an empty one (which is what the
 * replay of a room does). No network, no database: it is about the data type, so it runs thousands of schedules quickly.
 */

type Edit =
  | { k: 'insert'; who: number; at: number; text: string }
  | { k: 'delete'; who: number; at: number; len: number }
  | { k: 'language'; who: number; value: string }
  | { k: 'restore'; who: number; target: string }
  | { k: 'deliver'; pick: number; again: boolean };

const WORDS = ['int ', 'for', '(;;)', '\n', '  ', 'é', '日本', '😀', 'x = 1;', '}'];
const word = fc.constantFrom(...WORDS);
const unit = fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true });

const edits = (replicas: number) =>
  fc.array(
    fc.oneof(
      {
        weight: 5,
        arbitrary: fc.record({
          k: fc.constant('insert' as const),
          who: fc.nat(replicas - 1),
          at: unit,
          text: word,
        }),
      },
      {
        weight: 3,
        arbitrary: fc.record({
          k: fc.constant('delete' as const),
          who: fc.nat(replicas - 1),
          at: unit,
          len: fc.integer({ min: 1, max: 6 }),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record({
          k: fc.constant('language' as const),
          who: fc.nat(replicas - 1),
          value: fc.constantFrom('cpp17', 'python3', 'java21'),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record({
          k: fc.constant('restore' as const),
          who: fc.nat(replicas - 1),
          target: fc.array(word, { maxLength: 8 }).map((w) => w.join('')),
        }),
      },
      {
        weight: 6,
        arbitrary: fc.record({
          k: fc.constant('deliver' as const),
          pick: unit,
          again: fc.boolean(),
        }),
      },
    ),
    { minLength: 1, maxLength: 80 },
  );

interface Net {
  docs: Y.Doc[];
  /** Every update ever produced, in production order (what the room's log holds). */
  log: Uint8Array[];
  inflight: { to: number; update: Uint8Array }[];
}

function network(replicas: number): Net {
  const net: Net = { docs: [], log: [], inflight: [] };
  for (let i = 0; i < replicas; i++) {
    // replica 0 plays the server: it keeps history (`gc: false`), the browsers do not
    const doc = new Y.Doc({ gc: i !== 0 });
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return; // only what this replica itself produced is sent on
      net.log.push(update);
      for (let to = 0; to < replicas; to++) if (to !== i) net.inflight.push({ to, update });
    });
    net.docs.push(doc);
  }
  return net;
}

function run(net: Net, ops: Edit[]) {
  for (const op of ops) {
    if (op.k === 'deliver') {
      if (net.inflight.length === 0) continue;
      const i = Math.floor(op.pick * net.inflight.length);
      const msg = op.again ? net.inflight[i]! : net.inflight.splice(i, 1)[0]!; // again: it will arrive a second time
      Y.applyUpdate(net.docs[msg.to]!, msg.update, 'remote');
      continue;
    }
    const doc = net.docs[op.who % net.docs.length]!;
    const text = doc.getText('code');
    doc.transact(() => {
      if (op.k === 'insert') text.insert(Math.floor(op.at * (text.length + 1)), op.text);
      else if (op.k === 'language') doc.getMap('meta').set('language', op.value);
      else if (op.k === 'delete') {
        if (text.length === 0) return;
        const at = Math.floor(op.at * text.length);
        text.delete(at, Math.min(op.len, text.length - at));
      } else {
        // the restore of CP-07: the same edit script the server applies
        const list = diffText(text.toString(), op.target);
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i]!;
          if (e.delete) text.delete(e.index, e.delete);
          if (e.insert) text.insert(e.index, e.insert);
        }
        doc.getMap('meta').set('language', 'restored');
      }
    });
  }
}

/** Delivers everything still in flight, in a shuffled order. */
function settle(net: Net, shuffle: number) {
  const rest = [...net.inflight];
  net.inflight.length = 0;
  rest.sort(
    (a, b) =>
      (((a.update.length * 31 + a.to) * shuffle) % 97) -
      (((b.update.length * 31 + b.to) * shuffle) % 97),
  );
  for (const m of rest) Y.applyUpdate(net.docs[m.to]!, m.update, 'remote');
}

const same = (a: Y.Doc, b: Y.Doc) => Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b));
const view = (d: Y.Doc) => ({
  text: d.getText('code').toString(),
  meta: d.getMap('meta').toJSON(),
});

describe('FR-PAD-07/11/12: concurrent edits converge, whatever the delivery order', () => {
  for (const replicas of [3, 4, 5]) {
    it(`FR-PAD-07: ${replicas} replicas with random concurrent edits, restores and late, repeated, reordered delivery end identical`, () => {
      fc.assert(
        fc.property(edits(replicas), fc.integer({ min: 1, max: 1000 }), (ops, shuffle) => {
          const net = network(replicas);
          run(net, ops);
          settle(net, shuffle);
          for (const d of net.docs.slice(1)) {
            expect(view(d)).toEqual(view(net.docs[0]!));
            expect(same(d, net.docs[0]!)).toBe(true);
          }
        }),
        { numRuns: 300 },
      );
    });
  }

  it('FR-PAD-11: replaying every update into an empty document gives the converged document (what the room replay does)', () => {
    fc.assert(
      fc.property(
        edits(4),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (ops, shuffle, seed) => {
          const net = network(4);
          run(net, ops);
          settle(net, shuffle);
          const log = [...net.log];
          // the log is kept in the order updates were made, but replaying in any order must give the same document
          const replayed = new Y.Doc({ gc: false });
          for (const u of log) Y.applyUpdate(replayed, u);
          const shuffled = new Y.Doc({ gc: false });
          for (const u of [...log].sort(
            (a, b) => ((a.length * 7 + seed) % 13) - ((b.length * 7 + seed) % 13),
          ))
            Y.applyUpdate(shuffled, u);
          expect(view(replayed)).toEqual(view(net.docs[0]!));
          expect(same(replayed, shuffled)).toBe(true);
          // applying the whole log a second time changes nothing
          for (const u of log) Y.applyUpdate(replayed, u);
          expect(view(replayed)).toEqual(view(net.docs[0]!));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('FR-PAD-12: a restore keeps what someone else typed that it had not seen, and everyone still converges', () => {
    // Unique private-use characters mark each insert. One replica restores to an unrelated text at a random moment.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            who: fc.nat(2),
            at: unit,
            deliver: fc.array(fc.tuple(unit, fc.boolean()), { maxLength: 3 }),
          }),
          { minLength: 3, maxLength: 30 },
        ),
        fc.nat(29),
        fc.integer({ min: 1, max: 1000 }),
        (inserts, restoreAfter, shuffle) => {
          const net = network(3);
          const marker = (n: number) => String.fromCodePoint(0xe000 + n);
          const unseen = new Set<string>();
          let seenByRestorer = new Set<string>();
          let restored = false;
          inserts.forEach((ins, n) => {
            if (n === restoreAfter % inserts.length && !restored) {
              restored = true;
              const text = net.docs[0]!.getText('code');
              seenByRestorer = new Set([...text.toString()].filter((c) => c >= '' && c < ''));
              run(net, [{ k: 'restore', who: 0, target: 'int main() {}' }]);
            }
            run(net, [{ k: 'insert', who: ins.who, at: ins.at, text: marker(n) }]);
            if (ins.who === 0) seenByRestorer.add(marker(n)); // replica 0's own typing is "seen"
            for (const [pick, again] of ins.deliver) run(net, [{ k: 'deliver', pick, again }]);
          });
          settle(net, shuffle);
          // everything typed by the others, not yet delivered to replica 0 when it restored, must survive
          for (let n = 0; n < inserts.length; n++) unseen.add(marker(n));
          const final = net.docs[0]!.getText('code').toString();
          for (const d of net.docs) expect(d.getText('code').toString()).toBe(final);
          if (restored)
            for (const m of unseen)
              if (
                !seenByRestorer.has(m) &&
                insertedAfterRestore(inserts, m, restoreAfter % inserts.length, marker)
              )
                expect(
                  final.includes(m),
                  `the unseen ${m.codePointAt(0)!.toString(16)} was lost`,
                ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** True for markers typed at or after the restore step by someone other than the restoring replica. */
function insertedAfterRestore(
  inserts: { who: number }[],
  m: string,
  restoreStep: number,
  marker: (n: number) => string,
): boolean {
  const n = inserts.findIndex((_, i) => marker(i) === m);
  return n >= restoreStep && inserts[n]!.who !== 0;
}
