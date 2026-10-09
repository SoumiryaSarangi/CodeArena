import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  MAX_OPEN_ROOMS,
  MAX_ROOM_MEMBERS,
  ROOM_SESSION_MAX_MINUTES,
  RoomView,
} from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { problems, roomInvites, roomMembers, rooms, users } from '../../db/schema';
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
const MIN = 60_000;
const COLLAB_TOKEN = randomBytes(24).toString('hex');

describe.skipIf(!ready)('CP-02: interview rooms (needs Compose Postgres + Redis)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let tokens: AccessTokens;
  let collab: Server;
  let collab2: Server;
  const collabCalls: { port: number; path: string; token: string | undefined }[] = [];

  const makeUser = async (role: 'user' | 'admin' = 'user', handle: string | null = 'auto') => {
    const id = randomUUID();
    const h = handle === 'auto' ? `u${id.slice(0, 8)}` : handle;
    await db.insert(users).values({ id, email: `${id}@example.test`, role, handle: h });
    const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
    return { id, token, handle: h! };
  };
  const call = (method: 'get' | 'post', path: string, who?: { token: string }, body?: unknown) => {
    const r = request(app.getHttpServer())[method](`/api${path}`).set('Cookie', `ca_csrf=${csrf}`);
    if (who) r.set('Authorization', `Bearer ${who.token}`).set('X-CSRF-Token', csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const newRoom = (who: { token: string }, over: object = {}) =>
    call('post', '/rooms', who, { language: 'cpp17', durationMin: 45, ...over });
  const inviteOf = async (
    owner: { token: string },
    roomId: string,
    role: 'candidate' | 'observer' = 'candidate',
  ) => {
    const r = await call('post', `/rooms/${roomId}/invites`, owner, { role });
    expect(r.status).toBe(201);
    return { token: new URL(r.body.url).searchParams.get('token')!, ...r.body };
  };

  beforeAll(async () => {
    // two collab instances: a room may live on either, so closing it must reach both
    const instance = () =>
      createServer((req, res) => {
        collabCalls.push({
          port: (req.socket.localPort ?? 0) as number,
          path: req.url ?? '',
          token: req.headers['x-service-token'] as string | undefined,
        });
        res.writeHead(204).end();
      });
    collab = instance();
    collab2 = instance();
    await Promise.all(
      [collab, collab2].map((c) => new Promise<void>((r) => c.listen(0, '127.0.0.1', r))),
    );
    const portOf = (c: Server) => (c.address() as { port: number }).port;
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    app = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_DEFAULT_PER_MIN: '100000',
        RATE_LIMIT_ANON_PER_MIN: '100000',
        COLLAB_SERVICE_TOKEN: COLLAB_TOKEN,
        COLLAB_URL: `http://127.0.0.1:${portOf(collab)} http://127.0.0.1:${portOf(collab2)}`,
        WEB_URL: 'https://codearena.example',
        DATABASE_URL: t.url,
      }),
    );
    await app.init();
    tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    await db.insert(problems).values([
      { slug: 'pub-one', title: 'Public One', difficulty: 800, visibility: 'public' },
      { slug: 'priv-one', title: 'Private One', difficulty: 800, visibility: 'private' },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await drop?.();
    for (const c of [collab, collab2])
      await new Promise((r) => (c?.listening ? c.close(r) : r(undefined)));
  });

  it('FR-PAD-01: anyone signed in with a handle creates a room and becomes its interviewer', async () => {
    const u = await makeUser();
    const r = await newRoom(u, { problemSlug: 'pub-one', durationMin: 60 });
    expect(r.status).toBe(201);
    const room = RoomView.parse(r.body);
    expect(room).toMatchObject({
      role: 'interviewer',
      status: 'open',
      language: 'cpp17',
      durationMin: 60,
      problem: { slug: 'pub-one', title: 'Public One' },
      memberCount: 1,
      members: [{ handle: u.handle, role: 'interviewer' }],
    });
    expect(Date.parse(room.expiresAt) - Date.parse(room.createdAt)).toBe(
      ROOM_SESSION_MAX_MINUTES * MIN,
    );
    const blank = await newRoom(u);
    expect(blank.body.problem).toBeNull();
  });

  it('refuses guests, people without a handle, and bad input: duration, language, extra fields, unknown or private problem', async () => {
    const u = await makeUser();
    expect(
      (await call('post', '/rooms', undefined, { language: 'cpp17', durationMin: 45 })).status,
    ).toBe(401);
    const nameless = await makeUser('user', null);
    expect((await newRoom(nameless)).status).toBe(403);
    for (const bad of [
      { durationMin: 50 },
      { durationMin: '45' },
      { language: 'cobol' },
      { extra: 1 },
      { problemSlug: '' },
    ]) {
      expect((await newRoom(u, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await newRoom(u, { problemSlug: 'nope' })).status).toBe(404);
    expect((await newRoom(u, { problemSlug: 'priv-one' })).status).toBe(404);
    const admin = await makeUser('admin');
    expect((await newRoom(admin, { problemSlug: 'priv-one' })).status).toBe(201); // staff may use any problem
  });

  it('at most five open rooms per person; ending one frees a place', async () => {
    const u = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_ROOMS; i++) ids.push((await newRoom(u)).body.id);
    expect((await newRoom(u)).status).toBe(400);
    await call('post', `/rooms/${ids[0]}/close`, u);
    expect((await newRoom(u)).status).toBe(201);
  });

  it('a room is visible to its members only; the list is mine, newest first; no e-mail addresses anywhere', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const first = (await newRoom(a)).body.id;
    const second = (await newRoom(a)).body.id;
    const theirs = (await newRoom(b)).body.id;
    expect((await call('get', `/rooms/${first}`)).status).toBe(401);
    expect((await call('get', `/rooms/${first}`, b)).status).toBe(404);
    expect((await call('get', `/rooms/${randomUUID()}`, a)).status).toBe(404);
    expect((await call('get', '/rooms/nope', a)).status).toBe(400);
    const list = await call('get', '/rooms', a);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([second, first]);
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(theirs);
    expect(JSON.stringify(list.body)).not.toContain('example.test');
  });

  it('FR-PAD-02: only the interviewer invites; the link carries a token stored only as a hash and lasts until the room ends', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const room = (await newRoom(owner)).body;
    expect(
      (await call('post', `/rooms/${room.id}/invites`, other, { role: 'candidate' })).status,
    ).toBe(404);
    for (const bad of [{ role: 'interviewer' }, { role: 'god' }, {}, { role: 'candidate', x: 1 }]) {
      expect((await call('post', `/rooms/${room.id}/invites`, owner, bad)).status).toBe(400);
    }
    const inv = await inviteOf(owner, room.id, 'observer');
    expect(inv.url.startsWith('https://codearena.example/r/join?token=')).toBe(true);
    expect(inv.token.length).toBeGreaterThanOrEqual(32);
    expect(inv.expiresAt).toBe(room.expiresAt);
    const stored = await db.select().from(roomInvites).where(eq(roomInvites.roomId, room.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.role).toBe('observer');
    expect(
      Buffer.from(stored[0]!.tokenHash).equals(createHash('sha256').update(inv.token).digest()),
    ).toBe(true);
    expect(JSON.stringify(stored[0])).not.toContain(inv.token);
    // a candidate cannot invite others
    const cand = await makeUser();
    const cinv = await inviteOf(owner, room.id, 'candidate');
    await call('post', '/rooms/join', cand, { token: cinv.token });
    expect(
      (await call('post', `/rooms/${room.id}/invites`, cand, { role: 'observer' })).status,
    ).toBe(403);
  });

  it('FR-PAD-02: joining gives the invited role, keeps an existing role, and the member can then get a collab ticket', async () => {
    const owner = await makeUser();
    const room = (await newRoom(owner)).body;
    const candInv = await inviteOf(owner, room.id, 'candidate');
    const obsInv = await inviteOf(owner, room.id, 'observer');
    const cand = await makeUser();
    const obs = await makeUser();
    expect((await call('post', '/rooms/join', cand, { token: candInv.token })).body).toEqual({
      roomId: room.id,
      role: 'candidate',
    });
    expect((await call('post', '/rooms/join', obs, { token: obsInv.token })).body).toEqual({
      roomId: room.id,
      role: 'observer',
    });
    // opening your own candidate link does not demote the interviewer; opening twice changes nothing
    expect((await call('post', '/rooms/join', owner, { token: candInv.token })).body.role).toBe(
      'interviewer',
    );
    expect((await call('post', '/rooms/join', cand, { token: candInv.token })).body.role).toBe(
      'candidate',
    );
    const view = RoomView.parse((await call('get', `/rooms/${room.id}`, obs)).body);
    expect(view.members.map((m) => m.role)).toEqual(['interviewer', 'candidate', 'observer']);
    expect(view.role).toBe('observer');
    const ticket = await call('post', '/realtime/ticket', cand, { roomId: room.id });
    expect(ticket.status).toBe(200);
  });

  it('a link that is unknown, malformed, revoked, expired, for a closed room or for a full room is refused', async () => {
    const owner = await makeUser();
    const room = (await newRoom(owner)).body;
    const u = await makeUser();
    for (const token of ['x'.repeat(32), 'short', '', 'a'.repeat(300)]) {
      expect([400, 404], token.slice(0, 8)).toContain(
        (await call('post', '/rooms/join', u, { token })).status,
      );
    }
    expect((await call('post', '/rooms/join', undefined, { token: 'x'.repeat(32) })).status).toBe(
      401,
    );
    // expired invite
    const old = await inviteOf(owner, room.id);
    await db
      .update(roomInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(roomInvites.roomId, room.id));
    expect((await call('post', '/rooms/join', u, { token: old.token })).status).toBe(404);
    // a revoked invite on a room that is still open (revoking is also what closing does)
    const revoked = await inviteOf(owner, room.id);
    await db
      .update(roomInvites)
      .set({ revokedAt: new Date() })
      .where(eq(roomInvites.tokenHash, createHash('sha256').update(revoked.token).digest()));
    expect((await call('post', '/rooms/join', u, { token: revoked.token })).status).toBe(404);
    // a room past its 90 minutes
    const aged = (await newRoom(owner)).body;
    const agedInv = await inviteOf(owner, aged.id);
    await db
      .update(rooms)
      .set({ createdAt: new Date(Date.now() - (ROOM_SESSION_MAX_MINUTES + 1) * MIN) })
      .where(eq(rooms.id, aged.id));
    expect((await call('post', '/rooms/join', u, { token: agedInv.token })).status).toBe(404);
    expect((await call('get', `/rooms/${aged.id}`, owner)).body.status).toBe('closed'); // over, even though nobody pressed End
    // full
    const full = (await newRoom(owner)).body;
    const fullInv = await inviteOf(owner, full.id, 'observer');
    for (let i = 1; i < MAX_ROOM_MEMBERS; i++) {
      const m = await makeUser();
      expect((await call('post', '/rooms/join', m, { token: fullInv.token })).status).toBe(200);
    }
    expect((await call('post', '/rooms/join', u, { token: fullInv.token })).status).toBe(400);
  });

  it("FR-PAD-02: closing is the interviewer's; it revokes every link, tells the collab server, is repeatable, and the room cannot be joined again", async () => {
    const owner = await makeUser();
    const room = (await newRoom(owner)).body;
    const inv = await inviteOf(owner, room.id);
    const cand = await makeUser();
    await call('post', '/rooms/join', cand, { token: inv.token });
    expect((await call('post', `/rooms/${room.id}/close`, cand)).status).toBe(403);
    expect((await call('post', `/rooms/${room.id}/close`, await makeUser())).status).toBe(404);
    collabCalls.length = 0;
    expect((await call('post', `/rooms/${room.id}/close`, owner)).body).toEqual({
      status: 'closed',
    });
    expect(collabCalls.map((c) => ({ path: c.path, token: c.token }))).toEqual([
      { path: `/internal/rooms/${room.id}/close`, token: COLLAB_TOKEN },
      { path: `/internal/rooms/${room.id}/close`, token: COLLAB_TOKEN },
    ]);
    expect(new Set(collabCalls.map((c) => c.port)).size).toBe(2); // each instance was told
    const view = await call('get', `/rooms/${room.id}`, owner);
    expect(view.body.status).toBe('closed');
    const [row] = await db.select().from(rooms).where(eq(rooms.id, room.id));
    expect(row!.closedAt).not.toBeNull();
    const invites = await db.select().from(roomInvites).where(eq(roomInvites.roomId, room.id));
    expect(invites.every((i) => i.revokedAt !== null)).toBe(true);
    expect((await call('post', '/rooms/join', await makeUser(), { token: inv.token })).status).toBe(
      404,
    );
    expect(
      (await call('post', `/rooms/${room.id}/invites`, owner, { role: 'observer' })).status,
    ).toBe(400);
    expect((await call('post', `/rooms/${room.id}/close`, owner)).status).toBe(200); // again
    expect(
      (await db.select().from(roomMembers).where(eq(roomMembers.roomId, room.id))).length,
    ).toBe(2); // history stays
  });

  it('closing still works when the collab server cannot be reached', async () => {
    const owner = await makeUser();
    const room = (await newRoom(owner)).body;
    // the main app's collab double is up; take it down to simulate an outage
    await Promise.all([collab, collab2].map((c) => new Promise((r) => c.close(r))));
    expect((await call('post', `/rooms/${room.id}/close`, owner)).status).toBe(200);
    expect((await call('get', `/rooms/${room.id}`, owner)).body.status).toBe('closed');
  });
});
