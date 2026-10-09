import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createHarness,
  infrastructureUp,
  replayFromEmpty,
  replayWithCheckpoint,
  sameDoc,
} from './harness';
import { pause, until } from './test-support';

const ready = await infrastructureUp();

/** A small seeded generator, so a failing session can be run again with the same seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = [
  'int ',
  'main',
  '(){',
  '}\n',
  'for ',
  'while ',
  'x = ',
  'return ',
  '0;',
  'print(',
  ')',
  ' // ',
  'é',
  '日本',
  '\n    ',
];
const LANGS = ['cpp17', 'python3', 'java21', 'node', 'c'];

describe.skipIf(!ready)(
  'FR-PAD-11: replaying the whole log gives exactly the stored document (needs Compose Postgres + Redis)',
  () => {
    let h: Awaited<ReturnType<typeof createHarness>>;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h?.close();
    });

    it.each(Array.from({ length: 20 }, (_x, i) => i + 1))(
      'random session %i: edits, deletes, language changes, a second instance, people dropping out and coming back',
      async (n) => {
        const rand = rng(n * 7919);
        const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
        const roomId = await h.makeRoom();
        const twoInstances = n % 2 === 0;
        const instances = [await h.startInstance({ redis: twoInstances, checkpointEvery: 10 })];
        if (twoInstances)
          instances.push(await h.startInstance({ redis: true, checkpointEvery: 10 }));

        const people = Array.from({ length: 2 + Math.floor(rand() * 2) }, (_p, i) => ({
          who: h.identity(i === 0 ? 'interviewer' : 'candidate', `p${i}`),
          doc: new Y.Doc(),
          inst: instances[i % instances.length]!,
          conn: null as null | Awaited<ReturnType<typeof h.join>>,
        }));
        for (const p of people) p.conn = await h.join(p.inst, roomId, p.who, p.doc);

        const ops = 40 + Math.floor(rand() * 30);
        for (let i = 0; i < ops; i++) {
          const p = pick(people);
          if (!p.conn) {
            if (rand() < 0.5)
              p.conn = await h.join(p.inst, roomId, p.who, p.doc); // comes back with what it wrote meanwhile
            else p.doc.getText('code').insert(0, 'offline '); // keeps typing while away
            continue;
          }
          const text = p.doc.getText('code');
          const r = rand();
          if (r < 0.55) text.insert(Math.floor(rand() * (text.length + 1)), pick(WORDS));
          else if (r < 0.8 && text.length > 0) {
            const at = Math.floor(rand() * text.length);
            text.delete(at, Math.min(text.length - at, 1 + Math.floor(rand() * 5)));
          } else if (r < 0.9) p.doc.getMap<string>('meta').set('language', pick(LANGS));
          else if (r < 0.95 && people.filter((q) => q.conn).length > 1) {
            p.conn.leave();
            p.conn = null;
          } else if (text.length > 3) {
            // a "move": cut a piece and put it elsewhere
            const at = Math.floor(rand() * (text.length - 2));
            const piece = text.toString().slice(at, at + 2);
            text.delete(at, 2);
            text.insert(Math.floor(rand() * (text.length + 1)), piece);
          }
          await pause(3 + Math.floor(rand() * 25));
        }
        for (const p of people) if (!p.conn) p.conn = await h.join(p.inst, roomId, p.who, p.doc);

        // everyone converges, then everyone leaves
        const sameText = () =>
          people.every(
            (p) => p.doc.getText('code').toString() === people[0]!.doc.getText('code').toString(),
          );
        await until(sameText, 15_000);
        await pause(400);
        const expected = people[0]!.doc;
        for (const p of people) p.conn!.leave();
        await until(async () => {
          const r = await h.sql.query('select 1 from room_docs where room_id = $1', [roomId]);
          const open = await h.sql.query(
            `select (select count(*) from room_events where room_id = $1 and kind = 'join') - (select count(*) from room_events where room_id = $1 and kind = 'leave') as n`,
            [roomId],
          );
          return r.rowCount === 1 && Number(open.rows[0].n) === 0;
        }, 15_000);
        await pause(600); // the last unload reconciles the log

        const stored = new Y.Doc({ gc: false });
        Y.applyUpdate(
          stored,
          new Uint8Array(
            (
              await h.sql.query<{ state: Buffer }>(
                'select state from room_docs where room_id = $1',
                [roomId],
              )
            ).rows[0]!.state,
          ),
        );
        expect(
          stored.getText('code').toString(),
          'the stored document is what the people ended with',
        ).toBe(expected.getText('code').toString());

        const fromEmpty = await replayFromEmpty(h.sql, roomId);
        const viaCheckpoint = await replayWithCheckpoint(h.sql, roomId);
        for (const [name, doc] of [
          ['whole log from empty', fromEmpty],
          ['last checkpoint + tail', viaCheckpoint],
        ] as const) {
          expect(doc.getText('code').toString(), `${name}: text`).toBe(
            stored.getText('code').toString(),
          );
          expect(doc.getMap('meta').toJSON(), `${name}: meta`).toEqual(
            stored.getMap('meta').toJSON(),
          );
          expect(sameDoc(doc, stored), `${name}: state and deletions`).toBe(true);
        }
        for (const i of instances) await i.stop();
      },
      90_000,
    );
  },
);
