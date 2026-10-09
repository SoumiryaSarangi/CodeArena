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

describe.skipIf(!ready)('CP-06: the update log (needs Compose Postgres + Redis)', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const updates = async (roomId: string) =>
    (
      await h.sql.query<{ seq: string; ts: Date; user_id: string | null; update: Buffer }>(
        'select seq, ts, user_id, update from room_updates where room_id = $1 order by seq',
        [roomId],
      )
    ).rows;
  const events = async (roomId: string) =>
    (
      await h.sql.query<{
        seq: string;
        kind: string;
        user_id: string | null;
        payload: Record<string, unknown>;
      }>('select seq, kind, user_id, payload from room_events where room_id = $1 order by seq', [
        roomId,
      ])
    ).rows;
  const typeSteps = async (c: { text: Y.Text }, n: number, ch = 'x') => {
    for (let i = 0; i < n; i++) {
      c.text.insert(c.text.length, ch);
      await pause(8);
    }
  };

  it('FR-PAD-06: every update is logged in order with its author, its time and its bytes; the log replays to the document', async () => {
    const roomId = await h.makeRoom();
    const inst = await h.startInstance({ log: { checkpointEvery: 1000 } });
    const sent: Uint8Array[] = [];
    const who = h.identity('interviewer', 'meera');
    const doc = new Y.Doc();
    doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (!(origin && typeof origin === 'object' && 'document' in (origin as object))) sent.push(u);
    });
    const c = await h.join(inst, roomId, who, doc);
    sent.length = 0;
    await typeSteps(c, 12, 'a');
    c.text.delete(0, 3);
    c.meta.set('language', 'python3');
    await pause(150);
    c.leave();
    await until(async () => (await events(roomId)).some((e) => e.kind === 'leave'), 5000);
    const rows = await updates(roomId);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_r, i) => i + 1)); // 1, 2, 3 … with no gap
    expect(rows.every((r) => r.user_id === who.userId)).toBe(true);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.ts.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.ts.getTime());
    // the logged bytes are exactly what the client produced (the first logged ones, in order)
    const first = rows[0]!;
    expect(Buffer.from(sent[0]!).equals(first.update)).toBe(true);
    const replayed = await replayFromEmpty(h.sql, roomId);
    expect(replayed.getText('code').toString()).toBe(c.text.toString());
    expect(replayed.getMap('meta').get('language')).toBe('python3');
    await inst.stop();
  });

  it('FR-PAD-06: opening a room that already has a document logs nothing new', async () => {
    const roomId = await h.makeRoom();
    const inst = await h.startInstance();
    const a = await h.join(inst, roomId);
    await typeSteps(a, 5);
    await pause(150);
    a.leave();
    await until(async () => (await events(roomId)).some((e) => e.kind === 'leave'), 5000);
    const before = (await updates(roomId)).length;
    const b = await h.join(inst, roomId); // loaded from the stored document
    expect(b.text.length).toBe(5);
    await pause(400);
    b.leave();
    await until(
      async () => (await events(roomId)).filter((e) => e.kind === 'leave').length === 2,
      5000,
    );
    expect((await updates(roomId)).length).toBe(before);
    await inst.stop();
  });

  it('FR-PAD-07: with two instances each update is logged once, by the instance whose client made it', async () => {
    const roomId = await h.makeRoom();
    const a = await h.startInstance({ redis: true });
    const b = await h.startInstance({ redis: true });
    const onA = await h.join(a, roomId, h.identity('interviewer', 'meera'));
    const onB = await h.join(b, roomId, h.identity('candidate', 'asha'));
    const before = onA.st.updates + onB.st.updates;
    for (let i = 0; i < 8; i++) {
      (i % 2 ? onA : onB).text.insert(0, String(i));
      await pause(60);
    }
    await until(() => onA.text.toString() === onB.text.toString() && onA.text.length === 8, 5000);
    await pause(400);
    const made = onA.st.updates + onB.st.updates - before;
    const rows = await updates(roomId);
    expect(rows.length).toBe(made); // not doubled by the relay through Redis
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(2);
    expect(sameDoc(await replayFromEmpty(h.sql, roomId), onA.doc)).toBe(true);
    await a.stop();
    await b.stop();
  });

  it('FR-PAD-10: a checkpoint is the document exactly as it was after its update, also with two instances writing alternately', async () => {
    const roomId = await h.makeRoom();
    const a = await h.startInstance({ redis: true, checkpointEvery: 10 });
    const b = await h.startInstance({ redis: true, checkpointEvery: 10 });
    const onA = await h.join(a, roomId, h.identity('interviewer', 'meera'));
    const onB = await h.join(b, roomId, h.identity('candidate', 'asha'));
    for (let i = 0; i < 45; i++) {
      const c = i % 2 ? onA : onB;
      if (i % 7 === 6) c.text.delete(0, 1);
      else c.text.insert(c.text.length, String.fromCharCode(97 + (i % 26)));
      await pause(25);
    }
    await until(() => onA.text.toString() === onB.text.toString(), 5000);
    await pause(500);
    const cks = (
      await h.sql.query<{ seq: string; state: Buffer }>(
        'select seq, state from room_checkpoints where room_id = $1 order by seq',
        [roomId],
      )
    ).rows;
    const total = (await updates(roomId)).length;
    expect(cks.map((c) => Number(c.seq))).toEqual(
      Array.from({ length: Math.floor(total / 10) }, (_x, i) => (i + 1) * 10),
    );
    expect(cks.length).toBeGreaterThanOrEqual(3);
    for (const ck of cks) {
      const fromCheckpoint = new Y.Doc({ gc: false });
      Y.applyUpdate(fromCheckpoint, new Uint8Array(ck.state));
      expect(
        sameDoc(fromCheckpoint, await replayFromEmpty(h.sql, roomId, Number(ck.seq))),
        `checkpoint ${ck.seq}`,
      ).toBe(true);
    }
    // seeking with a checkpoint gives the same as replaying from nothing, for any point
    for (const at of [3, 10, 17, 25, total]) {
      expect(
        sameDoc(
          await replayWithCheckpoint(h.sql, roomId, at),
          await replayFromEmpty(h.sql, roomId, at),
        ),
        `at ${at}`,
      ).toBe(true);
    }
    await a.stop();
    await b.stop();
  }, 30_000);

  it('a log write that fails is retried: nothing is lost and nothing is doubled', async () => {
    const roomId = await h.makeRoom();
    const inst = await h.startInstance({ log: { checkpointEvery: 1000 } });
    const log = inst.log as unknown as { append: (...a: unknown[]) => Promise<void> };
    const real = log.append.bind(inst.log);
    let failures = 0;
    log.append = async (...a: unknown[]) => {
      if (failures < 2) {
        failures++;
        throw new Error('database blip');
      }
      return real(...a);
    };
    const c = await h.join(inst, roomId);
    await typeSteps(c, 6);
    await until(async () => (await updates(roomId)).length >= 6, 8000);
    await pause(300);
    expect(failures).toBe(2);
    expect((await updates(roomId)).length).toBe(c.st.updates);
    expect((await replayFromEmpty(h.sql, roomId)).getText('code').toString()).toBe('xxxxxx');
    await inst.stop();
  }, 20_000);

  it("join, leave and language events are logged with the author, in the same sequence as the API's run events", async () => {
    const roomId = await h.makeRoom();
    const inst = await h.startInstance();
    const who = h.identity('interviewer', 'meera');
    const c = await h.join(inst, roomId, who);
    // the API logs a run the way room-runs.service does: the same lock, the next seq
    const apiRunEvent = async () => {
      const client = await h.sql.connect();
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [roomId]);
      await client.query(
        `insert into room_events (room_id, seq, user_id, kind, payload) values ($1, (select coalesce(max(seq), 0) + 1 from room_events where room_id = $1), $2, 'run', '{}')`,
        [roomId, who.userId],
      );
      await client.query('commit');
      client.release();
    };
    await until(async () => (await events(roomId)).some((e) => e.kind === 'join'), 5000);
    c.meta.set('language', 'python3');
    await apiRunEvent();
    c.meta.set('language', 'java21');
    await apiRunEvent();
    c.leave();
    await until(async () => (await events(roomId)).some((e) => e.kind === 'leave'), 5000);
    const ev = await events(roomId);
    expect(ev.map((e) => Number(e.seq))).toEqual(ev.map((_e, i) => i + 1)); // one sequence, no collision, no gap
    expect(ev.map((e) => e.kind).filter((k) => k !== 'run')).toEqual([
      'join',
      'language',
      'language',
      'leave',
    ]);
    expect(ev.filter((e) => e.kind === 'language').map((e) => e.payload.language)).toEqual([
      'python3',
      'java21',
    ]);
    expect(ev.find((e) => e.kind === 'join')!.user_id).toBe(who.userId);
    expect(ev.find((e) => e.kind === 'language')!.user_id).toBe(who.userId);
    await inst.stop();
  });

  it('FR-PAD-11: if a crash lost the end of the log, opening the room adds one catch-up update and the replay is whole again', async () => {
    const roomId = await h.makeRoom();
    const inst = await h.startInstance({ checkpointEvery: 10 });
    const c = await h.join(inst, roomId);
    await typeSteps(c, 33);
    await pause(300);
    c.leave();
    await until(async () => (await events(roomId)).some((e) => e.kind === 'leave'), 5000);
    await inst.stop();
    const total = (await updates(roomId)).length;
    expect(total).toBeGreaterThanOrEqual(33);
    const finalText = c.text.toString();
    // what a SIGKILL can lose: the last updates and the checkpoints they produced
    await h.sql.query('delete from room_updates where room_id = $1 and seq > $2', [
      roomId,
      total - 9,
    ]);
    await h.sql.query('delete from room_checkpoints where room_id = $1 and seq > $2', [
      roomId,
      total - 9,
    ]);
    expect((await replayFromEmpty(h.sql, roomId)).getText('code').toString()).not.toBe(finalText);

    const again = await h.startInstance({ checkpointEvery: 10 });
    const d = await h.join(again, roomId);
    expect(d.text.toString()).toBe(finalText); // the stored document was whole
    await pause(300);
    const rows = await updates(roomId);
    const synthetic = rows.filter((r) => r.user_id === null);
    expect(synthetic).toHaveLength(1);
    expect(sameDoc(await replayFromEmpty(h.sql, roomId), d.doc)).toBe(true);
    expect(sameDoc(await replayWithCheckpoint(h.sql, roomId), d.doc)).toBe(true);
    d.leave();
    await pause(300);
    expect((await updates(roomId)).filter((r) => r.user_id === null)).toHaveLength(1); // nothing more to heal
    await again.stop();
  }, 30_000);

  it('when the last person leaves, or the server stops, what is queued is written at once, not when a timer fires', async () => {
    const roomId = await h.makeRoom();
    const inst = await h.startInstance({
      log: { flushMs: 60_000, maxBatch: 1000, checkpointEvery: 1000 },
    });
    const c = await h.join(inst, roomId);
    await typeSteps(c, 7);
    await pause(100);
    expect((await updates(roomId)).length).toBe(0); // still queued
    c.leave();
    await until(async () => (await updates(roomId)).length === 7, 5000);
    expect((await replayFromEmpty(h.sql, roomId)).getText('code').toString()).toBe('xxxxxxx');
    // and on shutdown
    const room2 = await h.makeRoom();
    const second = await h.startInstance({
      log: { flushMs: 60_000, maxBatch: 1000, checkpointEvery: 1000 },
    });
    const d = await h.join(second, room2);
    await typeSteps(d, 4);
    await pause(100);
    await second.stop();
    expect((await updates(room2)).length).toBe(4);
    await inst.stop();
  }, 20_000);
});
