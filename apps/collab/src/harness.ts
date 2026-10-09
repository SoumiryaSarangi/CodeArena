import { randomUUID } from 'node:crypto';
import type { CollabIdentity } from '@codearena/contracts';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Redis } from 'ioredis';
import pg from 'pg';
import * as Y from 'yjs';
import { createTestDatabase, postgresReachable } from '../../api/src/test/db';
import { PgDocStore } from './pg-store';
import { createServer } from './server';
import { SERVICE_TOKEN, startApi, until, type Api } from './test-support';
import { PgUpdateLog, type PgLogOptions } from './update-log';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://admin:codearena-dev@localhost:6379';

export const infrastructureUp = async () => {
  const r = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  r.on('error', () => {});
  const redisUp = await r.connect().then(
    () => true,
    () => false,
  );
  r.disconnect();
  return redisUp && (await postgresReachable());
};

/** Replays a room's log from empty (no checkpoints) into a fresh document, optionally up to a sequence number. */
export async function replayFromEmpty(sql: pg.Pool, roomId: string, upTo?: number): Promise<Y.Doc> {
  const rows = await sql.query<{ update: Buffer }>(
    `select update from room_updates where room_id = $1 ${upTo === undefined ? '' : 'and seq <= $2'} order by seq`,
    upTo === undefined ? [roomId] : [roomId, upTo],
  );
  const doc = new Y.Doc({ gc: false });
  for (const r of rows.rows) Y.applyUpdate(doc, new Uint8Array(r.update));
  return doc;
}

/** Replays like the playback does: the last checkpoint at or before `upTo`, then the updates after it. */
export async function replayWithCheckpoint(
  sql: pg.Pool,
  roomId: string,
  upTo?: number,
): Promise<Y.Doc> {
  const ck = (
    await sql.query<{ seq: string; state: Buffer }>(
      `select seq, state from room_checkpoints where room_id = $1 ${upTo === undefined ? '' : 'and seq <= $2'} order by seq desc limit 1`,
      upTo === undefined ? [roomId] : [roomId, upTo],
    )
  ).rows[0];
  const doc = new Y.Doc({ gc: false });
  if (ck) Y.applyUpdate(doc, new Uint8Array(ck.state));
  const rows = await sql.query<{ update: Buffer }>(
    `select update from room_updates where room_id = $1 and seq > $2 ${upTo === undefined ? '' : 'and seq <= $3'} order by seq`,
    upTo === undefined ? [roomId, ck ? ck.seq : 0] : [roomId, ck ? ck.seq : 0, upTo],
  );
  for (const r of rows.rows) Y.applyUpdate(doc, new Uint8Array(r.update));
  return doc;
}

export const sameDoc = (a: Y.Doc, b: Y.Doc) => Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b));

/** A database, Redis, a stand-in API and collab instances, for tests that need the whole path. */
export async function createHarness() {
  const t = await createTestDatabase();
  const sql = new pg.Pool({ connectionString: t.url, max: 4 });
  const api: Api = await startApi();
  const closers: (() => Promise<void> | void)[] = [];
  let seq = 0;

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

  const startInstance = async (
    opts: {
      checkpointEvery?: number;
      log?: Partial<PgLogOptions>;
      redis?: boolean;
      debounce?: number;
    } = {},
  ) => {
    const store = PgDocStore.connect(t.url);
    const log = PgUpdateLog.connect(t.url, {
      flushMs: 50,
      checkpointEvery: 10,
      ...opts.log,
      ...(opts.checkpointEvery ? { checkpointEvery: opts.checkpointEvery } : {}),
    });
    const client = opts.redis ? new Redis(REDIS_URL, { maxRetriesPerRequest: null }) : undefined;
    client?.on('error', () => {});
    const collab = createServer({
      port: 0,
      api: { url: api.url, token: SERVICE_TOKEN, timeoutMs: 1000 },
      token: SERVICE_TOKEN,
      store,
      log,
      ...(client ? { redis: { client, instance: `h${seq++}` } } : {}),
      debounce: opts.debounce ?? 100,
      maxDebounce: 500,
      sweepMs: 60_000,
    });
    await collab.listen();
    let down = false;
    const stop = async () => {
      if (down) return;
      down = true;
      await collab.destroy();
      await log.flush();
      await store.close();
      await log.close();
      client?.disconnect();
    };
    closers.push(stop);
    return { collab, log, store, stop };
  };

  /** A person with a verified identity in a room (the stand-in API recognises the ticket once). */
  const identity = (role: CollabIdentity['role'] = 'candidate', name = 'asha'): CollabIdentity => ({
    userId: randomUUID(),
    name,
    role,
    readOnly: role === 'observer',
    expiresAt: Date.now() + 3_600_000,
    colorIndex: seq++ % 8,
  });
  const userRow = async (who: CollabIdentity) => {
    await sql.query(
      'insert into users (id, email, handle) values ($1, $2, $3) on conflict do nothing',
      [who.userId, `${who.userId}@example.test`, `p${who.userId.slice(0, 8)}`],
    );
    return who;
  };

  const join = async (
    inst: { collab: { webSocketURL: string } },
    roomId: string,
    who?: CollabIdentity,
    doc = new Y.Doc(),
  ) => {
    const me = await userRow(who ?? identity());
    const st = { synced: false, updates: 0 };
    doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin !== provider) st.updates++; // what this client itself produced
    });
    const provider = new HocuspocusProvider({
      url: inst.collab.webSocketURL,
      name: `room:${roomId}`,
      document: doc,
      token: async () => {
        const ticket = `t-${randomUUID()}`;
        api.tickets.set(ticket, me);
        return ticket;
      },
      onSynced: () => (st.synced = true),
    });
    closers.push(() => provider.destroy());
    await until(() => st.synced, 10_000);
    return {
      provider,
      doc,
      text: doc.getText('code'),
      meta: doc.getMap<string>('meta'),
      st,
      who: me,
      leave: () => provider.destroy(),
    };
  };

  return {
    url: t.url,
    sql,
    api,
    makeRoom,
    startInstance,
    identity,
    join,
    async close() {
      for (const c of closers.splice(0).reverse()) await c();
      await api.close().catch(() => undefined);
      await sql.end();
      await t.drop();
    },
  };
}
