import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { auditLog, roomMembers, rooms, users } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';

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

describe.skipIf(!ready)(
  'FR-EDIT-03: the interviewer switches code suggestions for the room (needs Compose Postgres + Redis)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;
    let redis: Redis;

    const makeUser = async () => {
      const id = randomUUID();
      const handle = `u${id.slice(0, 8)}`;
      await db.insert(users).values({ id, email: `${id}@example.test`, role: 'user', handle });
      const { token } = await tokens.sign({ sub: id, role: 'user', sid: randomUUID() });
      return { id, token, handle };
    };
    const call = (
      method: 'get' | 'post' | 'patch',
      path: string,
      who?: { token: string },
      body?: unknown,
    ) => {
      const agent = request(app.getHttpServer());
      const r = agent[method](`/api${path}`).set('Cookie', `ca_csrf=${csrf}`);
      if (who) r.set('Authorization', `Bearer ${who.token}`).set('X-CSRF-Token', csrf);
      return body === undefined ? r : r.send(body as object);
    };
    const makeRoom = async (extra: object = {}) => {
      const [iv, cand, obs] = [await makeUser(), await makeUser(), await makeUser()];
      const created = await call('post', '/rooms', iv, {
        language: 'python3',
        durationMin: 45,
        ...extra,
      });
      expect(created.status).toBe(201);
      const roomId = created.body.id as string;
      await db.insert(roomMembers).values([
        { roomId, userId: cand.id, role: 'candidate' },
        { roomId, userId: obs.id, role: 'observer' },
      ]);
      return { roomId, iv, cand, obs, created: created.body };
    };
    const topicEvents = async (roomId: string) =>
      (await redis.xrange(`${prefix}evt:room:${roomId}`, '-', '+')).map(([, f]) =>
        JSON.parse(f[f.indexOf('event') + 1]!),
      );

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      app = await createApp(
        loadConfig({
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          RATE_LIMIT_DEFAULT_PER_MIN: '100000',
          RATE_LIMIT_ANON_PER_MIN: '100000',
          QUEUE_KEY_PREFIX: prefix,
          DATABASE_URL: t.url,
        }),
      );
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
      redis = app.get<Redis>(REDIS);
    });
    afterAll(async () => {
      await app?.close();
      await drop?.();
    });

    it('FR-EDIT-03: suggestions are on unless the room is created with them off, and every member sees the value', async () => {
      const on = await makeRoom();
      expect(on.created.suggestions).toBe(true);
      const off = await makeRoom({ suggestions: false });
      expect(off.created.suggestions).toBe(false);
      for (const who of [off.iv, off.cand, off.obs]) {
        expect((await call('get', `/rooms/${off.roomId}`, who)).body.suggestions).toBe(false);
        const list = await call('get', '/rooms', who);
        expect(list.body.items.find((r: { id: string }) => r.id === off.roomId).suggestions).toBe(
          false,
        );
      }
      expect(
        (
          await call('post', '/rooms', on.iv, {
            language: 'python3',
            durationMin: 45,
            suggestions: 'no',
          })
        ).status,
      ).toBe(400);
    });

    it('FR-EDIT-03: the interviewer changes it, it is stored, audited and published to the room', async () => {
      const r = await makeRoom();
      const res = await call('patch', `/rooms/${r.roomId}/settings`, r.iv, { suggestions: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ suggestions: false });
      const [row] = await db.select().from(rooms).where(eq(rooms.id, r.roomId));
      expect(row?.suggestions).toBe(false);
      expect((await call('get', `/rooms/${r.roomId}`, r.cand)).body.suggestions).toBe(false);
      const evs = await topicEvents(r.roomId);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({
        topic: `room:${r.roomId}`,
        type: 'room.settings',
        data: { suggestions: false },
      });
      const audit = (await db.select().from(auditLog)).filter(
        (a) => a.targetId === r.roomId && a.action === 'room.settings',
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorId).toBe(r.iv.id);
      expect(audit[0]?.meta).toEqual({ suggestions: false });
      // and back on
      await call('patch', `/rooms/${r.roomId}/settings`, r.iv, { suggestions: true });
      expect((await call('get', `/rooms/${r.roomId}`, r.iv)).body.suggestions).toBe(true);
      expect(await topicEvents(r.roomId)).toHaveLength(2);
    });

    it('FR-EDIT-03: only the interviewer may; nothing changes and nothing is published for anyone else', async () => {
      const r = await makeRoom();
      const stranger = await makeUser();
      const body = { suggestions: false };
      expect((await call('patch', `/rooms/${r.roomId}/settings`, r.cand, body)).status).toBe(403);
      expect((await call('patch', `/rooms/${r.roomId}/settings`, r.obs, body)).status).toBe(403);
      expect((await call('patch', `/rooms/${r.roomId}/settings`, stranger, body)).status).toBe(404);
      expect((await call('patch', `/rooms/${r.roomId}/settings`, undefined, body)).status).toBe(
        401,
      );
      expect(
        (await call('patch', `/rooms/${r.roomId}/settings`, r.iv, { suggestions: 'x' })).status,
      ).toBe(400);
      expect(
        (await call('patch', `/rooms/${r.roomId}/settings`, r.iv, { suggestions: false, extra: 1 }))
          .status,
      ).toBe(400);
      expect((await call('patch', `/rooms/${r.roomId}/settings`, r.iv, {})).status).toBe(400);
      const [row] = await db.select().from(rooms).where(eq(rooms.id, r.roomId));
      expect(row?.suggestions).toBe(true);
      expect(await topicEvents(r.roomId)).toHaveLength(0);
    });

    it('FR-EDIT-03: a closed room and a room past its 90 minutes cannot be changed', async () => {
      const closed = await makeRoom();
      expect((await call('post', `/rooms/${closed.roomId}/close`, closed.iv)).status).toBe(200);
      expect(
        (await call('patch', `/rooms/${closed.roomId}/settings`, closed.iv, { suggestions: false }))
          .status,
      ).toBe(410);
      const old = await makeRoom();
      await db
        .update(rooms)
        .set({ createdAt: new Date(Date.now() - 91 * 60_000) })
        .where(eq(rooms.id, old.roomId));
      expect(
        (await call('patch', `/rooms/${old.roomId}/settings`, old.iv, { suggestions: false }))
          .status,
      ).toBe(410);
    });
  },
);
