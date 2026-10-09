import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { roomEvents, roomMembers, roomSnapshots, rooms, users } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { RoomsRetention } from './rooms-retention.service';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const probe = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
probe.on('error', () => {});
const redisUp = await probe.connect().then(
  () => true,
  () => false,
);
probe.disconnect();
const ready = redisUp && (await postgresReachable());
const csrf = randomBytes(32).toString('base64url');
const prefix = `t${randomBytes(4).toString('hex')}:`;
const TOKEN = 'k'.repeat(40);

interface Seen {
  path: string;
  token: string | undefined;
  body: unknown;
}
/** A stand-in collab server: records what it is asked and answers as told. */
async function collabDouble() {
  const d = { seen: [] as Seen[], status: 200, server: undefined as unknown as Server, url: '' };
  d.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      d.seen.push({
        path: req.url ?? '',
        token: req.headers['x-service-token'] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(req.url?.endsWith('/restore') ? d.status : 204).end('{"edits":1}');
    });
  });
  await new Promise<void>((r) => d.server.listen(0, '127.0.0.1', r));
  d.url = `http://127.0.0.1:${(d.server.address() as { port: number }).port}`;
  return d;
}

describe.skipIf(!ready)(
  'FR-PAD-12: snapshots at each run and restore (needs Compose Postgres + Redis)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;
    let redis: Redis;
    let one: Awaited<ReturnType<typeof collabDouble>>;
    let two: Awaited<ReturnType<typeof collabDouble>>;

    const makeUser = async () => {
      const id = randomUUID();
      const handle = `u${id.slice(0, 8)}`;
      await db.insert(users).values({ id, email: `${id}@example.test`, role: 'user', handle });
      const { token } = await tokens.sign({ sub: id, role: 'user', sid: randomUUID() });
      return { id, token, handle };
    };
    const call = (
      method: 'get' | 'post',
      path: string,
      who?: { token: string },
      body?: unknown,
    ) => {
      const agent = request(app.getHttpServer());
      const r = agent[method](`/api${path}`).set('Cookie', `ca_csrf=${csrf}`);
      if (who) r.set('Authorization', `Bearer ${who.token}`).set('X-CSRF-Token', csrf);
      return body === undefined ? r : r.send(body as object);
    };
    const makeRoom = async () => {
      const [iv, cand, obs] = [await makeUser(), await makeUser(), await makeUser()];
      const created = await call('post', '/rooms', iv, { language: 'python3', durationMin: 45 });
      expect(created.status).toBe(201);
      const roomId = created.body.id as string;
      await db.insert(roomMembers).values([
        { roomId, userId: cand.id, role: 'candidate' },
        { roomId, userId: obs.id, role: 'observer' },
      ]);
      return { roomId, iv, cand, obs };
    };
    const free = (roomId: string) =>
      redis.del(`${prefix}room-run:${roomId}`, `${prefix}room-restore:${roomId}`);
    const run = async (
      r: { roomId: string; iv: { token: string } },
      source: string,
      language = 'python3',
    ) => {
      await free(r.roomId);
      const runId = randomUUID();
      const res = await call('post', `/rooms/${r.roomId}/runs`, r.iv, {
        runId,
        mode: 'run',
        language,
        source,
        input: '',
      });
      expect(res.status).toBe(202);
      return runId;
    };
    const restoreCalls = (d: typeof one) => d.seen.filter((s) => s.path.endsWith('/restore'));

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      one = await collabDouble();
      two = await collabDouble();
      app = await createApp(
        loadConfig({
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          RATE_LIMIT_DEFAULT_PER_MIN: '100000',
          RATE_LIMIT_ANON_PER_MIN: '100000',
          QUEUE_KEY_PREFIX: prefix,
          DATABASE_URL: t.url,
          COLLAB_SERVICE_TOKEN: TOKEN,
          COLLAB_URL: `${one.url},${two.url}`,
        }),
      );
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
      redis = app.get<Redis>(REDIS);
    });
    afterAll(async () => {
      await app?.close();
      await Promise.all([one, two].map((d) => new Promise((r) => d.server.close(r))));
      await drop?.();
    });
    beforeEach(() => {
      one.seen.length = 0;
      two.seen.length = 0;
      one.status = 200;
      two.status = 200;
    });

    it('FR-PAD-12: every run saves a snapshot of the code that ran, tied to the log position and to the run', async () => {
      const r = await makeRoom();
      await db.execute(sql`insert into room_updates (room_id, seq, ts, update) values
        (${r.roomId}, 1, now(), '\\x00'), (${r.roomId}, 2, now(), '\\x00'), (${r.roomId}, 3, now(), '\\x00')`);
      const source = 'print("héllo 日本")\n';
      const runId = await run(r, source, 'python3');
      const [row] = await db.select().from(roomSnapshots).where(eq(roomSnapshots.id, runId));
      expect(row?.roomId).toBe(r.roomId);
      expect(Number(row?.seq)).toBe(3);
      expect(row?.label).toBe(`Run by @${r.iv.handle}`);
      expect(JSON.parse(Buffer.from(row!.snapshot).toString('utf8'))).toEqual({
        text: source,
        language: 'python3',
      });
      // a retry of the same run adds no second snapshot
      await free(r.roomId);
      await call('post', `/rooms/${r.roomId}/runs`, r.iv, {
        runId,
        mode: 'run',
        language: 'python3',
        source,
        input: '',
      });
      expect(
        await db.select().from(roomSnapshots).where(eq(roomSnapshots.roomId, r.roomId)),
      ).toHaveLength(1);
    });

    it('FR-PAD-12: the interviewer restores a run: one collab server is asked, with the saved text, the language and who asked', async () => {
      const r = await makeRoom();
      const runId = await run(r, 'x = 1\n', 'python3');
      const res = await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ runId });
      expect(restoreCalls(one)).toEqual([
        {
          path: `/internal/rooms/${r.roomId}/restore`,
          token: TOKEN,
          body: { text: 'x = 1\n', language: 'python3', userId: r.iv.id },
        },
      ]);
      expect(restoreCalls(two), 'applying on both servers would apply it twice').toHaveLength(0);
      const ev = await db.select().from(roomEvents).where(eq(roomEvents.roomId, r.roomId));
      const restored = ev.filter((e) => e.kind === 'restore');
      expect(restored).toHaveLength(1);
      expect(restored[0]?.userId).toBe(r.iv.id);
      expect(restored[0]?.payload).toEqual({ runId });
    });

    it('FR-PAD-12: only the interviewer may; nobody else gets as far as collab', async () => {
      const r = await makeRoom();
      const runId = await run(r, 'x = 2\n');
      const stranger = await makeUser();
      await free(r.roomId);
      expect((await call('post', `/rooms/${r.roomId}/restore`, r.cand, { runId })).status).toBe(
        403,
      );
      expect((await call('post', `/rooms/${r.roomId}/restore`, r.obs, { runId })).status).toBe(403);
      expect((await call('post', `/rooms/${r.roomId}/restore`, stranger, { runId })).status).toBe(
        404,
      );
      expect((await call('post', `/rooms/${r.roomId}/restore`, undefined, { runId })).status).toBe(
        401,
      );
      expect(
        (await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId: 'nope' })).status,
      ).toBe(400);
      expect(
        (await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId, text: 'x' })).status,
      ).toBe(400);
      expect(restoreCalls(one)).toHaveLength(0);
      expect(restoreCalls(two)).toHaveLength(0);
    });

    it('FR-PAD-12: a closed room and a room past its 90 minutes cannot be restored', async () => {
      const closed = await makeRoom();
      const a = await run(closed, 'x = 3\n');
      expect((await call('post', `/rooms/${closed.roomId}/close`, closed.iv)).status).toBe(200);
      one.seen.length = 0;
      await free(closed.roomId);
      const res = await call('post', `/rooms/${closed.roomId}/restore`, closed.iv, { runId: a });
      expect(res.status).toBe(410);

      const old = await makeRoom();
      const b = await run(old, 'x = 4\n');
      await db
        .update(rooms)
        .set({ createdAt: new Date(Date.now() - 91 * 60_000) })
        .where(eq(rooms.id, old.roomId));
      await free(old.roomId);
      expect(
        (await call('post', `/rooms/${old.roomId}/restore`, old.iv, { runId: b })).status,
      ).toBe(410);
      expect(restoreCalls(one)).toHaveLength(0);
    });

    it("FR-PAD-12: an unknown run, and another room's run, are 404", async () => {
      const mine = await makeRoom();
      const other = await makeRoom();
      const theirs = await run(other, 'secret = 1\n');
      await free(mine.roomId);
      expect(
        (await call('post', `/rooms/${mine.roomId}/restore`, mine.iv, { runId: randomUUID() }))
          .status,
      ).toBe(404);
      expect(
        (await call('post', `/rooms/${mine.roomId}/restore`, mine.iv, { runId: theirs })).status,
      ).toBe(404);
      expect(restoreCalls(one)).toHaveLength(0);
    });

    it('FR-PAD-12: one restore every 2 seconds per room', async () => {
      const r = await makeRoom();
      const runId = await run(r, 'x = 5\n');
      await free(r.roomId);
      expect((await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId })).status).toBe(200);
      const again = await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId });
      expect(again.status).toBe(429);
      expect(Number(again.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      await free(r.roomId);
      expect((await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId })).status).toBe(200);
    });

    it('FR-PAD-12: if the first collab server cannot do it the next is tried; if none can, nothing is recorded', async () => {
      const r = await makeRoom();
      const runId = await run(r, 'x = 6\n');
      await free(r.roomId);
      one.status = 500;
      expect((await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId })).status).toBe(200);
      expect(restoreCalls(one)).toHaveLength(1);
      expect(restoreCalls(two)).toHaveLength(1);

      const before = (
        await db.select().from(roomEvents).where(eq(roomEvents.roomId, r.roomId))
      ).filter((e) => e.kind === 'restore').length;
      await free(r.roomId);
      two.status = 503;
      const res = await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId });
      expect(res.status).toBe(500);
      expect(res.body.detail).toMatch(/nothing was changed/);
      const after = (
        await db.select().from(roomEvents).where(eq(roomEvents.roomId, r.roomId))
      ).filter((e) => e.kind === 'restore').length;
      expect(after).toBe(before);
    });

    it('FR-PAD-12: snapshot text is not returned by any room route', async () => {
      const r = await makeRoom();
      const marker = `SNAPSHOT_MARKER_${randomUUID()}`;
      const runId = await run(r, `print("${marker}")\n`);
      await free(r.roomId);
      await call('post', `/rooms/${r.roomId}/restore`, r.iv, { runId });
      for (const who of [r.iv, r.cand, r.obs]) {
        for (const path of ['', '/runs', '/timeline', '/notes']) {
          const res = await call('get', `/rooms/${r.roomId}${path}`, who);
          expect(JSON.stringify(res.body), `${path} for ${who.handle}`).not.toContain(marker);
        }
        expect(JSON.stringify((await call('get', '/rooms', who)).body)).not.toContain(marker);
      }
    });

    it('FR-PAD-12: snapshots are purged with the log, 90 days after the room ended', async () => {
      const oldRoom = await makeRoom();
      const freshRoom = await makeRoom();
      const a = await run(oldRoom, 'old = 1\n');
      const b = await run(freshRoom, 'fresh = 1\n');
      await db
        .update(rooms)
        .set({ status: 'closed', closedAt: new Date(Date.now() - 91 * 86_400_000) })
        .where(eq(rooms.id, oldRoom.roomId));
      const out = await app.get(RoomsRetention).purge();
      expect(out.snapshots).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(roomSnapshots).where(eq(roomSnapshots.id, a))).toHaveLength(0);
      expect(await db.select().from(roomSnapshots).where(eq(roomSnapshots.id, b))).toHaveLength(1);
    });
  },
);
