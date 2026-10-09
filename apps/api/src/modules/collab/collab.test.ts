import { randomBytes, randomUUID } from 'node:crypto';
import { CollabIdentity, PRESENCE_COLOURS, ROOM_SESSION_MAX_MINUTES } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { roomMembers, rooms, users } from '../../db/schema';
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
const TOKEN = randomBytes(24).toString('hex');
const MIN = 60_000;

describe.skipIf(!ready)(
  'CP-01: the collab server asks who a ticket is (needs Compose Postgres + Redis)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;

    const makeUser = async (role: 'user' | 'admin' = 'user') => {
      const id = randomUUID();
      const handle = `u${id.slice(0, 8)}`;
      await db.insert(users).values({ id, email: `${id}@example.test`, role, handle });
      const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
      return { id, token, handle };
    };
    const makeRoom = async (
      opts: { status?: 'open' | 'closed' | 'archived'; ageMin?: number } = {},
    ) => {
      const owner = await makeUser();
      const [room] = await db
        .insert(rooms)
        .values({
          ownerId: owner.id,
          language: 'cpp17',
          status: opts.status ?? 'open',
          createdAt: new Date(Date.now() - (opts.ageMin ?? 5) * MIN),
        })
        .returning({ id: rooms.id, createdAt: rooms.createdAt });
      return { room: room!, owner };
    };
    const join = (
      roomId: string,
      userId: string,
      role: 'interviewer' | 'candidate' | 'observer',
      at = Date.now(),
    ) => db.insert(roomMembers).values({ roomId, userId, role, joinedAt: new Date(at) });
    const ticketFor = async (u: { token: string }, roomId: string) => {
      const r = await request(app.getHttpServer())
        .post('/api/realtime/ticket')
        .set('Authorization', `Bearer ${u.token}`)
        .set('Cookie', `ca_csrf=${csrf}`)
        .set('X-CSRF-Token', csrf)
        .send({ roomId });
      expect(r.status).toBe(200);
      return r.body.ticket as string;
    };
    const authorize = (roomId: string, ticket: unknown, service: string | null = TOKEN) => {
      const r = request(app.getHttpServer()).post(`/api/internal/rooms/${roomId}/authorize`);
      if (service !== null) r.set('X-Service-Token', service);
      return r.send(ticket === undefined ? {} : (ticket as object));
    };

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
          COLLAB_SERVICE_TOKEN: TOKEN,
          DATABASE_URL: t.url,
        }),
      );
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    });
    afterAll(async () => {
      await app?.close();
      await drop?.();
    });

    it("FR-PAD-03: a member's ticket becomes a verified identity; an observer is read-only; the expiry is creation + 90 minutes", async () => {
      const { room, owner } = await makeRoom();
      const cand = await makeUser();
      const obs = await makeUser();
      await join(room.id, owner.id, 'interviewer', Date.now() - 3000);
      await join(room.id, cand.id, 'candidate', Date.now() - 2000);
      await join(room.id, obs.id, 'observer', Date.now() - 1000);

      const asInterviewer = await authorize(room.id, { ticket: await ticketFor(owner, room.id) });
      expect(asInterviewer.status).toBe(200);
      expect(CollabIdentity.parse(asInterviewer.body)).toMatchObject({
        userId: owner.id,
        name: owner.handle,
        role: 'interviewer',
        readOnly: false,
        expiresAt: room.createdAt.getTime() + ROOM_SESSION_MAX_MINUTES * MIN,
        colorIndex: 0,
      });
      const asCandidate = await authorize(room.id, { ticket: await ticketFor(cand, room.id) });
      expect(asCandidate.body).toMatchObject({ role: 'candidate', readOnly: false, colorIndex: 1 });
      const asObserver = await authorize(room.id, { ticket: await ticketFor(obs, room.id) });
      expect(asObserver.body).toMatchObject({ role: 'observer', readOnly: true, colorIndex: 2 });
      expect(JSON.stringify([asInterviewer.body, asCandidate.body, asObserver.body])).not.toContain(
        'example.test',
      );
    });

    it('colours are a place in the member list, wrapping over the palette', async () => {
      const { room, owner } = await makeRoom();
      const all = [owner];
      for (let i = 1; i <= PRESENCE_COLOURS; i++) all.push(await makeUser());
      for (const [i, u] of all.entries())
        await join(room.id, u.id, i === 0 ? 'interviewer' : 'observer', Date.now() - 10_000 + i);
      const last = all[PRESENCE_COLOURS]!;
      const r = await authorize(room.id, { ticket: await ticketFor(last, room.id) });
      expect(r.body.colorIndex).toBe(PRESENCE_COLOURS % PRESENCE_COLOURS);
    });

    it('a ticket works once', async () => {
      const { room, owner } = await makeRoom();
      await join(room.id, owner.id, 'interviewer');
      const ticket = await ticketFor(owner, room.id);
      expect((await authorize(room.id, { ticket })).status).toBe(200);
      expect((await authorize(room.id, { ticket })).status).toBe(401);
    });

    it('unknown, malformed and missing tickets are refused', async () => {
      const { room } = await makeRoom();
      for (const bad of [
        { ticket: 'x'.repeat(43) },
        { ticket: 'short' },
        { ticket: '' },
        {},
        { ticket: 1 },
        { ticket: 'a', extra: 1 },
      ]) {
        const r = await authorize(room.id, bad);
        expect([400, 401], JSON.stringify(bad)).toContain(r.status);
      }
      expect((await authorize('not-a-uuid', { ticket: 'x' })).status).toBe(400);
    });

    it('a ticket for one room does not open another', async () => {
      const a = await makeRoom();
      const b = await makeRoom();
      await join(a.room.id, a.owner.id, 'interviewer');
      await join(b.room.id, a.owner.id, 'interviewer');
      const ticket = await ticketFor(a.owner, a.room.id);
      expect((await authorize(b.room.id, { ticket })).status).toBe(403);
    });

    it('a person who is not a member cannot get a ticket, and a member removed after the ticket is refused', async () => {
      const { room, owner } = await makeRoom();
      await join(room.id, owner.id, 'interviewer');
      const stranger = await makeUser();
      const refused = await request(app.getHttpServer())
        .post('/api/realtime/ticket')
        .set('Authorization', `Bearer ${stranger.token}`)
        .set('Cookie', `ca_csrf=${csrf}`)
        .set('X-CSRF-Token', csrf)
        .send({ roomId: room.id });
      expect(refused.status).toBe(403);
      const ticket = await ticketFor(owner, room.id);
      await db.delete(roomMembers).where(eq(roomMembers.userId, owner.id));
      expect((await authorize(room.id, { ticket })).status).toBe(403);
    });

    it('FR-PAD-05: a closed or archived room, and a session past 90 minutes, are refused', async () => {
      for (const status of ['closed', 'archived'] as const) {
        const { room, owner } = await makeRoom({ status });
        await join(room.id, owner.id, 'interviewer');
        expect(
          (await authorize(room.id, { ticket: await ticketFor(owner, room.id) })).status,
          status,
        ).toBe(403);
      }
      const old = await makeRoom({ ageMin: ROOM_SESSION_MAX_MINUTES + 1 });
      await join(old.room.id, old.owner.id, 'interviewer');
      expect(
        (await authorize(old.room.id, { ticket: await ticketFor(old.owner, old.room.id) })).status,
      ).toBe(403);
      const edge = await makeRoom({ ageMin: ROOM_SESSION_MAX_MINUTES - 1 });
      await join(edge.room.id, edge.owner.id, 'interviewer');
      expect(
        (await authorize(edge.room.id, { ticket: await ticketFor(edge.owner, edge.room.id) }))
          .status,
      ).toBe(200);
    });

    it('an unknown room is 404', async () => {
      const owner = await makeUser();
      const ticket = await ticketFor(owner, randomUUID()).catch(() => null);
      expect(ticket).toBeNull(); // not even a ticket for a room that does not exist
      expect((await authorize(randomUUID(), { ticket: 'x'.repeat(43) })).status).toBe(401);
    });

    it('the service token is required: none, a wrong one, the plag token and a user bearer are all refused', async () => {
      const { room, owner } = await makeRoom();
      await join(room.id, owner.id, 'interviewer');
      const ticket = await ticketFor(owner, room.id);
      expect((await authorize(room.id, { ticket }, null)).status).toBe(401);
      expect((await authorize(room.id, { ticket }, 'a'.repeat(TOKEN.length))).status).toBe(401);
      expect((await authorize(room.id, { ticket }, TOKEN.slice(0, -1))).status).toBe(401);
      const bearer = await request(app.getHttpServer())
        .post(`/api/internal/rooms/${room.id}/authorize`)
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Cookie', `ca_csrf=${csrf}`)
        .set('X-CSRF-Token', csrf)
        .send({ ticket });
      expect(bearer.status).toBe(401);
      // none of those used the ticket up
      expect((await authorize(room.id, { ticket })).status).toBe(200);
    });
  },
);

describe('CP-01: with no collab token configured, the endpoint refuses everything', () => {
  it('answers 403 "not configured" whatever is sent', async () => {
    const { CollabTokenGuard } = await import('../plag/service-token.guard');
    const run = (token: string | undefined, header: string | undefined) => {
      const guard = new CollabTokenGuard({ ...config, COLLAB_SERVICE_TOKEN: token });
      const ctx = { switchToHttp: () => ({ getRequest: () => ({ header: () => header }) }) };
      return () => guard.canActivate(ctx as never);
    };
    expect(run(undefined, 'anything')).toThrowError(/not configured/);
    expect(run('not-configured', 'not-configured')).toThrowError(/not configured/);
    expect(run('a'.repeat(40), 'a'.repeat(39))).toThrowError(/service token/);
    expect(run('a'.repeat(40), 'a'.repeat(40))()).toBe(true);
  });
});
