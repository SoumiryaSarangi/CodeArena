import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { CollabIdentity } from '@codearena/contracts';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestDatabase, postgresReachable } from '../../api/src/test/db';
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
const portOpen = (port: number) =>
  new Promise<boolean>((r) => {
    const s = createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      r(true);
    });
    s.on('error', () => r(false));
  });

/**
 * A stand-in for Caddy's failover: every new connection goes to the first instance that accepts it. When an instance
 * dies, its connections are reset and the clients' next attempt lands on the survivor.
 */
function failoverProxy(
  targets: number[],
): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    client.pause();
    const attempt = (i: number) => {
      if (i >= targets.length) return client.destroy();
      const up = createConnection({ port: targets[i]!, host: '127.0.0.1' });
      up.once('connect', () => {
        sockets.add(up);
        up.on('close', () => {
          sockets.delete(up);
          client.destroy();
        });
        client.on('close', () => up.destroy());
        up.on('error', () => up.destroy());
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
      up.once('error', () => attempt(i + 1));
    };
    attempt(0);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as { port: number }).port, sockets }),
    ),
  );
}

describe.skipIf(!ready)(
  'CP-03: an instance dies mid-edit (two real processes, Postgres and Redis)',
  () => {
    let dbUrl: string;
    let drop: () => Promise<void>;
    let sql: pg.Pool;
    let api: Api;
    const children: ChildProcess[] = [];
    const cleanup: (() => void | Promise<void>)[] = [];

    beforeAll(async () => {
      const t = await createTestDatabase();
      dbUrl = t.url;
      drop = t.drop;
      sql = new pg.Pool({ connectionString: t.url, max: 2 });
      api = await startApi();
    });
    afterAll(async () => {
      for (const c of cleanup.splice(0).reverse()) await c();
      for (const c of children) c.kill('SIGKILL');
      await api?.close().catch(() => undefined);
      await sql?.end();
      await drop?.();
    });

    const startInstance = async (name: string) => {
      const port = await freePort();
      const child = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          ...process.env,
          PORT: String(port),
          API_URL: api.url,
          COLLAB_SERVICE_TOKEN: SERVICE_TOKEN,
          DATABASE_URL: dbUrl,
          REDIS_URL,
          COLLAB_INSTANCE: name,
        },
        stdio: 'ignore',
      });
      children.push(child);
      for (let i = 0; i < 150 && !(await portOpen(port)); i++) await pause(100);
      expect(await portOpen(port), `${name} did not start`).toBe(true);
      return { port, child };
    };

    it('FR-PAD-07: kill one instance with edits in flight; both clients reconnect to the other, nothing is lost, nothing doubled, and Postgres ends with the same text', async () => {
      const roomId = randomUUID();
      const owner = randomUUID();
      await sql.query('insert into users (id, email, handle) values ($1, $2, $3)', [
        owner,
        `${owner}@example.test`,
        'chaos',
      ]);
      await sql.query(
        `insert into rooms (id, owner_id, language, duration_min) values ($1, $2, 'cpp17', 45)`,
        [roomId, owner],
      );

      const a = await startInstance('A');
      const b = await startInstance('B');
      const proxy = await failoverProxy([a.port, b.port]); // everyone starts on A
      cleanup.push(() => {
        for (const s of proxy.sockets) s.destroy();
        proxy.server.close();
      });

      const client = (name: string, role: CollabIdentity['role']) => {
        const doc = new Y.Doc();
        const identity: CollabIdentity = {
          userId: randomUUID(),
          name,
          role,
          readOnly: false,
          expiresAt: Date.now() + 3_600_000,
          colorIndex: 0,
        };
        const st = { synced: 0, closes: 0 };
        const provider = new HocuspocusProvider({
          url: `ws://127.0.0.1:${proxy.port}/${roomId}`,
          name: `room:${roomId}`,
          document: doc,
          // a fresh single-use ticket for every (re)connect, as the real client does
          token: async () => {
            const t = `t-${randomUUID()}`;
            api.tickets.set(t, identity);
            return t;
          },
          onSynced: () => st.synced++,
          onClose: () => st.closes++,
        });
        cleanup.push(() => provider.destroy());
        return { doc, text: doc.getText('code'), provider, st };
      };
      const one = client('meera', 'interviewer');
      const two = client('asha', 'candidate');
      await until(() => one.st.synced > 0 && two.st.synced > 0, 20_000);
      await until(() => one.provider.isSynced && two.provider.isSynced, 20_000);

      // Everyone types a numbered marker every 40 ms; instance A is killed halfway through, with no goodbye.
      const markers: string[] = [];
      const type = async (c: typeof one, tag: string, i: number) => {
        const m = `[${tag}${i}]`;
        markers.push(m);
        c.text.insert(c.text.length, m);
      };
      for (let i = 0; i < 6; i++) {
        await type(one, 'a', i);
        await type(two, 'b', i);
        await pause(40);
      }
      a.child.kill('SIGKILL');
      for (let i = 6; i < 14; i++) {
        await type(one, 'a', i);
        await type(two, 'b', i);
        await pause(40);
      }

      // Both reconnect (to B, the only one left), exchange what each wrote meanwhile, and agree.
      await until(
        () =>
          one.text.toString() === two.text.toString() &&
          markers.every((m) => one.text.toString().includes(m)),
        40_000,
      );
      const final = one.text.toString();
      expect(a.child.killed || a.child.exitCode !== null || a.child.signalCode !== null).toBe(true);
      expect(one.st.closes).toBeGreaterThan(0); // the connection really broke
      for (const m of markers) expect(final.split(m).length - 1, `${m} appears once`).toBe(1);
      expect(final.length).toBe(markers.join('').length); // nothing else, nothing doubled

      // B stores what it has when the last person leaves; Postgres then holds exactly that text.
      one.provider.destroy();
      two.provider.destroy();
      await until(async () => {
        const r = await sql.query<{ state: Buffer }>(
          'select state from room_docs where room_id = $1',
          [roomId],
        );
        if (!r.rows[0]) return false;
        const d = new Y.Doc();
        Y.applyUpdate(d, new Uint8Array(r.rows[0].state));
        return d.getText('code').toString() === final;
      }, 15_000);
    }, 120_000);
  },
);
