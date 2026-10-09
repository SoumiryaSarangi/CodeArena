import { randomUUID } from 'node:crypto';
import type { CollabIdentity } from '@codearena/contracts';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestDatabase, postgresReachable } from '../../api/src/test/db';
import pg from 'pg';
import { PgDocStore } from './pg-store';
import { createServer } from './server';
import { pause, SERVICE_TOKEN, startApi, until, type Api } from './test-support';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://admin:codearena-dev@localhost:6379';
const redisUp = await (async () => {
  const r = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  r.on('error', () => {});
  const ok = await r.connect().then(
    () => true,
    () => false,
  );
  r.disconnect();
  return ok;
})();
const ready = redisUp && (await postgresReachable());

const state = (text: string) => {
  const d = new Y.Doc();
  d.getText('code').insert(0, text);
  return Y.encodeStateAsUpdate(d);
};
const textOf = (bytes: Uint8Array | null) => {
  const d = new Y.Doc();
  if (bytes) Y.applyUpdate(d, bytes);
  return d.getText('code').toString();
};

describe.skipIf(!ready)(
  'CP-03: documents are stored and shared between instances (needs Compose Postgres + Redis)',
  () => {
    let sql: pg.Pool;
    let dbUrl: string;
    let drop: () => Promise<void>;
    let api: Api;
    let seq = 0;
    const closers: (() => Promise<void> | void)[] = [];

    beforeAll(async () => {
      const t = await createTestDatabase();
      dbUrl = t.url;
      sql = new pg.Pool({ connectionString: t.url, max: 2 });
      drop = t.drop;
    });
    afterAll(async () => {
      await sql?.end();
      await drop?.();
    });
    afterEach(async () => {
      for (const c of closers.splice(0).reverse()) await c();
      await api?.close().catch(() => undefined);
    });

    const makeRoom = async () => {
      const id = randomUUID();
      const owner = randomUUID();
      await sql.query('insert into users (id, email, handle) values ($1, $2, $3)', [
        owner,
        `${owner}@example.test`,
        `o${owner.slice(0, 8)}`,
      ]);
      await sql.query(
        `insert into rooms (id, owner_id, language, duration_min) values ($1, $2, 'cpp17', 45)`,
        [id, owner],
      );
      return id;
    };
    const stored = async (roomId: string) => {
      const r = await sql.query<{ state: Buffer }>(
        'select state from room_docs where room_id = $1',
        [roomId],
      );
      return r.rows[0] ? new Uint8Array(r.rows[0].state) : null;
    };

    const startInstance = async (
      opts: { debounce?: number; maxDebounce?: number; redis?: boolean; name?: string } = {},
    ) => {
      const store = PgDocStore.connect(dbUrl);
      const client =
        opts.redis === false ? undefined : new Redis(REDIS_URL, { maxRetriesPerRequest: null });
      client?.on('error', () => {});
      const collab = createServer({
        port: 0,
        api: { url: api.url, token: SERVICE_TOKEN, timeoutMs: 1000 },
        token: SERVICE_TOKEN,
        store,
        ...(client ? { redis: { client, instance: opts.name ?? `t${seq++}` } } : {}),
        debounce: opts.debounce ?? 150,
        maxDebounce: opts.maxDebounce ?? 1000,
        sweepMs: 60_000,
      });
      await collab.listen();
      let down = false;
      const stop = async () => {
        if (down) return;
        down = true;
        await collab.destroy();
        await store.close();
        client?.disconnect();
      };
      closers.push(stop);
      return { collab, store, stop };
    };

    const identity = (
      role: CollabIdentity['role'] = 'candidate',
      name = 'asha',
    ): CollabIdentity => ({
      userId: randomUUID(),
      name,
      role,
      readOnly: role === 'observer',
      expiresAt: Date.now() + 3_600_000,
      colorIndex: seq++ % 8,
    });
    const join = (
      inst: { collab: { webSocketURL: string } },
      roomId: string,
      who = identity(),
      doc = new Y.Doc(),
    ) => {
      const ticket = `t-${randomUUID()}`;
      api.tickets.set(ticket, who);
      const st = { synced: false };
      const provider = new HocuspocusProvider({
        url: inst.collab.webSocketURL,
        name: `room:${roomId}`,
        document: doc,
        token: ticket,
        onSynced: () => (st.synced = true),
      });
      closers.push(() => provider.destroy());
      return { provider, doc, text: doc.getText('code'), st, awareness: provider.awareness! };
    };

    // ---- the store ---------------------------------------------------------------------------------------------

    it('FR-PAD-06: the Postgres store round-trips a state, replaces it, tracks its size, and ignores a room that is gone', async () => {
      const s = PgDocStore.connect(dbUrl);
      closers.push(() => s.close());
      const roomId = await makeRoom();
      expect(await s.fetch(roomId)).toBeNull();
      const a = state('first');
      await s.store(roomId, a);
      expect(textOf(await s.fetch(roomId))).toBe('first');
      const b = state('second, longer');
      await s.store(roomId, b);
      expect(textOf(await s.fetch(roomId))).toBe('second, longer');
      const row = (
        await sql.query<{ n: number }>('select doc_bytes as n from rooms where id = $1', [roomId])
      ).rows[0];
      expect(row!.n).toBe(b.byteLength);
      await expect(s.store(randomUUID(), a)).resolves.toBeUndefined(); // a room that no longer exists is not an error
    });

    // ---- one instance ------------------------------------------------------------------------------------------

    it('FR-PAD-06: an edit reaches Postgres after the debounce, not before', async () => {
      api = await startApi();
      const roomId = await makeRoom();
      const inst = await startInstance({ debounce: 400, maxDebounce: 5000 });
      const c = join(inst, roomId);
      await until(() => c.st.synced);
      c.text.insert(0, 'debounced');
      await pause(100);
      expect(await stored(roomId)).toBeNull();
      await until(async () => textOf(await stored(roomId)) === 'debounced', 4000);
    });

    it('FR-PAD-06: when the last person leaves the document is stored at once, and a later visitor finds it', async () => {
      api = await startApi();
      const roomId = await makeRoom();
      const inst = await startInstance({ debounce: 60_000, maxDebounce: 120_000 }); // far longer than the test
      const c = join(inst, roomId);
      await until(() => c.st.synced);
      c.text.insert(0, 'left behind');
      await pause(200);
      expect(await stored(roomId)).toBeNull();
      c.provider.destroy();
      await until(async () => textOf(await stored(roomId)) === 'left behind', 3000);
      const later = join(inst, roomId);
      await until(() => later.st.synced);
      expect(later.text.toString()).toBe('left behind');
    });

    it('FR-PAD-06: shutting the server down stores what is pending, and a new server restores it', async () => {
      api = await startApi();
      const roomId = await makeRoom();
      const first = await startInstance({ debounce: 60_000, maxDebounce: 120_000 });
      const c = join(first, roomId);
      await until(() => c.st.synced);
      c.text.insert(0, 'survives a restart');
      await pause(200);
      expect(await stored(roomId)).toBeNull();
      await first.stop(); // what SIGTERM does
      expect(textOf(await stored(roomId))).toBe('survives a restart');
      const second = await startInstance();
      const d = join(second, roomId);
      await until(() => d.st.synced);
      expect(d.text.toString()).toBe('survives a restart');
    });

    // ---- two instances -----------------------------------------------------------------------------------------

    it("FR-PAD-07: people on two instances see each other's edits and cursors, with the verified names", async () => {
      api = await startApi();
      const roomId = await makeRoom();
      const a = await startInstance();
      const b = await startInstance();
      const onA = join(a, roomId, identity('interviewer', 'meera'));
      const onB = join(b, roomId, identity('candidate', 'asha'));
      await until(() => onA.st.synced && onB.st.synced);
      onA.text.insert(0, 'from A');
      await until(() => onB.text.toString() === 'from A');
      onB.text.insert(6, ' and B');
      await until(() => onA.text.toString() === 'from A and B');
      onB.awareness.setLocalState({ user: { name: 'Admin' }, cursor: { anchor: 2, head: 2 } });
      await until(() => !!onA.awareness.getStates().get(onB.doc.clientID)?.cursor);
      expect(onA.awareness.getStates().get(onB.doc.clientID)!.user).toMatchObject({
        name: 'asha',
        role: 'candidate',
      });
    });

    it('FR-PAD-04: a client on another instance cannot take over an awareness id; once its owner has left the id is free', async () => {
      api = await startApi();
      const roomId = await makeRoom();
      const a = await startInstance();
      const b = await startInstance();
      const victim = join(a, roomId, identity('interviewer', 'meera'));
      const watcher = join(a, roomId, identity('observer', 'ravi'));
      await until(() => victim.st.synced && watcher.st.synced);
      victim.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
      await until(() => !!watcher.awareness.getStates().get(victim.doc.clientID)?.cursor);

      const doc = new Y.Doc();
      doc.clientID = victim.doc.clientID; // the attacker, on the other instance, writes the victim's id
      const attacker = join(b, roomId, identity('candidate', 'mallory'), doc);
      await until(() => attacker.st.synced);
      attacker.awareness.setLocalState({ cursor: { anchor: 99, head: 99 } });
      await pause(500);
      expect(watcher.awareness.getStates().get(victim.doc.clientID)).toMatchObject({
        user: { name: 'meera' },
        cursor: { anchor: 1, head: 1 },
      });

      victim.provider.destroy(); // the owner leaves: the claim is released
      await pause(600);
      attacker.awareness.setLocalState({ cursor: { anchor: 5, head: 5 } });
      await until(
        () => watcher.awareness.getStates().get(victim.doc.clientID)?.user?.name === 'mallory',
        4000,
      );
    });

    it('FR-PAD-03: an observer on the other instance cannot edit either', async () => {
      api = await startApi();
      const roomId = await makeRoom();
      const a = await startInstance();
      const b = await startInstance();
      const iv = join(a, roomId, identity('interviewer', 'meera'));
      const ob = join(b, roomId, identity('observer', 'ravi'));
      await until(() => iv.st.synced && ob.st.synced);
      iv.text.insert(0, 'hello');
      await until(() => ob.text.toString() === 'hello');
      ob.text.insert(5, ' EVIL');
      await pause(500);
      expect(iv.text.toString()).toBe('hello');
    });

    it('FR-PAD-07: with two instances holding the same room, two stores never run at the same time, and the stored text is complete', async () => {
      api = await startApi();
      const roomId = await makeRoom();
      let active = 0;
      let overlap = 0;
      const wrap = (s: PgDocStore) => {
        const original = s.store.bind(s);
        s.store = async (id, st) => {
          active++;
          overlap = Math.max(overlap, active);
          await new Promise((r) => setTimeout(r, 60)); // make a clash visible if there were one
          try {
            await original(id, st);
          } finally {
            active--;
          }
        };
      };
      const a = await startInstance({ debounce: 100, maxDebounce: 400 });
      const b = await startInstance({ debounce: 100, maxDebounce: 400 });
      wrap(a.store);
      wrap(b.store);
      const onA = join(a, roomId);
      const onB = join(b, roomId);
      await until(() => onA.st.synced && onB.st.synced);
      for (let i = 0; i < 6; i++) {
        (i % 2 ? onA : onB).text.insert(0, String(i));
        await pause(70);
      }
      await until(async () => textOf(await stored(roomId)).length === 6, 5000);
      await pause(500);
      expect(overlap).toBe(1);
      expect([...textOf(await stored(roomId))].sort().join('')).toBe('012345');
    });
  },
);
