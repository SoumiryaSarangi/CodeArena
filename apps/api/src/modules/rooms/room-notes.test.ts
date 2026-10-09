import { randomBytes, randomUUID } from 'node:crypto';
import { ROOM_NOTES_MAX_BYTES } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { roomMembers, users } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { sql } from 'drizzle-orm';

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
const SECRET = 'SECRET-NOTE-the-candidate-is-nervous-but-strong-0f3a9c';

describe.skipIf(!ready)('CP-05: private interviewer notes (needs Compose Postgres + Redis)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let tokens: AccessTokens;
  let redis: Redis;

  type Who = { id: string; token: string; handle: string };
  const makeUser = async (): Promise<Who> => {
    const id = randomUUID();
    const handle = `u${id.slice(0, 8)}`;
    await db.insert(users).values({ id, email: `${id}@example.test`, role: 'user', handle });
    const { token } = await tokens.sign({ sub: id, role: 'user', sid: randomUUID() });
    return { id, token, handle };
  };
  const call = (
    method: 'get' | 'post' | 'put',
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
    const [iv, cand, obs, stranger] = [
      await makeUser(),
      await makeUser(),
      await makeUser(),
      await makeUser(),
    ];
    const created = await call('post', '/rooms', iv, { language: 'python3', durationMin: 45 });
    expect(created.status).toBe(201);
    const roomId = created.body.id as string;
    await db.insert(roomMembers).values([
      { roomId, userId: cand.id, role: 'candidate' },
      { roomId, userId: obs.id, role: 'observer' },
    ]);
    return { roomId, iv, cand, obs, stranger };
  };
  const save = (roomId: string, who: Who, body: string, baseUpdatedAt: string | null) =>
    call('put', `/rooms/${roomId}/notes`, who, { body, baseUpdatedAt });

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

  it('FR-PAD-09: the interviewer reads empty notes, saves, reads them back, and nothing is cached', async () => {
    const { roomId, iv } = await makeRoom();
    const first = await call('get', `/rooms/${roomId}/notes`, iv);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ body: '', updatedAt: null });
    expect(first.headers['cache-control']).toBe('no-store');
    const saved = await save(roomId, iv, 'first thoughts', null);
    expect(saved.status).toBe(200);
    expect(saved.body.body).toBe('first thoughts');
    expect(saved.headers['cache-control']).toBe('no-store');
    const again = await call('get', `/rooms/${roomId}/notes`, iv);
    expect(again.body).toEqual({ body: 'first thoughts', updatedAt: saved.body.updatedAt });
  });

  it('FR-PAD-09: only the interviewer: a candidate and an observer get 403, a stranger 404, a guest 401, for reading and for saving', async () => {
    const { roomId, iv, cand, obs, stranger } = await makeRoom();
    await save(roomId, iv, SECRET, null);
    for (const [who, status] of [
      [cand, 403],
      [obs, 403],
      [stranger, 404],
    ] as const) {
      const g = await call('get', `/rooms/${roomId}/notes`, who);
      expect(g.status).toBe(status);
      expect(JSON.stringify(g.body)).not.toContain(SECRET);
      expect((await save(roomId, who, 'overwritten', null)).status).toBe(status);
    }
    expect((await call('get', `/rooms/${roomId}/notes`)).status).toBe(401);
    expect(
      (await call('put', `/rooms/${roomId}/notes`, undefined, { body: 'x', baseUpdatedAt: null }))
        .status,
    ).toBe(401);
    // and nobody changed the notes
    expect((await call('get', `/rooms/${roomId}/notes`, iv)).body.body).toBe(SECRET);
  });

  it('a second window cannot silently overwrite: a stale base, or a first save over saved notes, is a 409 and changes nothing', async () => {
    const { roomId, iv } = await makeRoom();
    const a = await save(roomId, iv, 'one', null);
    expect((await save(roomId, iv, 'other window, first save', null)).status).toBe(409);
    const b = await save(roomId, iv, 'two', a.body.updatedAt);
    expect(b.status).toBe(200);
    expect(b.body.updatedAt > a.body.updatedAt).toBe(true); // strictly later, even within a millisecond
    expect((await save(roomId, iv, 'stale', a.body.updatedAt)).status).toBe(409);
    expect((await save(roomId, iv, 'garbage base', 'not a time')).status).toBe(400);
    expect((await call('get', `/rooms/${roomId}/notes`, iv)).body.body).toBe('two');
    expect((await save(roomId, iv, 'three', b.body.updatedAt)).status).toBe(200);
  });

  it('refuses bad bodies and notes over 64 KB', async () => {
    const { roomId, iv } = await makeRoom();
    for (const bad of [
      {},
      { body: 1, baseUpdatedAt: null },
      { body: 'x' },
      { body: 'x', baseUpdatedAt: null, extra: 1 },
    ]) {
      expect(
        (await call('put', `/rooms/${roomId}/notes`, iv, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    expect((await save(roomId, iv, 'é'.repeat(ROOM_NOTES_MAX_BYTES / 2 + 1), null)).status).toBe(
      413,
    ); // 64 KB + 2 bytes
    expect((await save(roomId, iv, 'a'.repeat(ROOM_NOTES_MAX_BYTES), null)).status).toBe(200);
  });

  it('after the room has ended the interviewer can still read and finish the notes, and the candidate still cannot', async () => {
    const { roomId, iv, cand } = await makeRoom();
    const s = await save(roomId, iv, 'during', null);
    await call('post', `/rooms/${roomId}/close`, iv);
    expect((await call('get', `/rooms/${roomId}/notes`, iv)).body.body).toBe('during');
    expect((await save(roomId, iv, 'after', s.body.updatedAt)).status).toBe(200);
    expect((await call('get', `/rooms/${roomId}/notes`, cand)).status).toBe(403);
  });

  /** Every GET route the app has, from Express's own router, so a route added later is included. */
  interface Layer {
    route?: { path: string; methods?: { get?: boolean } };
    handle?: { stack?: Layer[] };
    matchers?: unknown;
  }
  const getRoutes = (): string[] => {
    const router = (app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } }).router;
    const out = new Set<string>();
    const walk = (stack: Layer[]) => {
      for (const layer of stack) {
        if (layer.route?.methods?.get) out.add(layer.route.path);
        else if (layer.handle?.stack && layer.matchers) walk(layer.handle.stack);
      }
    };
    walk(router.stack);
    return [...out].filter((p) => p.startsWith('/api'));
  };

  it("FR-PAD-09 (the card's acceptance test): a candidate cannot read the notes by any route; and no route but one ever returns them, not even to the interviewer", async () => {
    const { roomId, iv, cand, obs, stranger } = await makeRoom();
    await save(roomId, iv, SECRET, null);
    const routes = getRoutes();
    expect(routes.length).toBeGreaterThan(40); // the sweep really saw the application
    expect(routes).toContain('/api/rooms/:id/notes');

    const fill = (pattern: string) =>
      pattern.replace(/:([A-Za-z]+)/g, (_m, name: string) =>
        /^(id|roomId)$/.test(name)
          ? roomId
          : name === 'slug' || name === 'handle'
            ? 'x'
            : randomUUID(),
      );
    const sweep = async (who?: { token: string }) => {
      const hits: string[] = [];
      for (const pattern of routes) {
        if (pattern === '/api/sse' || pattern.endsWith('/stream')) continue; // long-lived streams: covered by the topic tests
        const path = fill(pattern).replace(/^\/api/, '');
        const res = await call('get', path.includes('?') ? path : path, who);
        if (res.text.includes(SECRET) || JSON.stringify(res.body ?? '').includes(SECRET))
          hits.push(pattern);
      }
      return hits;
    };
    expect(await sweep(cand)).toEqual([]);
    expect(await sweep(obs)).toEqual([]);
    expect(await sweep(stranger)).toEqual([]);
    expect(await sweep()).toEqual([]);
    // the interviewer: the notes route and nothing else (not the room, not the list, not the runs, not a ticket)
    expect(await sweep(iv)).toEqual(['/api/rooms/:id/notes']);
  }, 60_000);

  it('the notes text is stored nowhere but its own table: not in audit rows, room events, runs, the document, or any Redis key', async () => {
    const { roomId, iv } = await makeRoom();
    await save(roomId, iv, SECRET, null);
    await call('post', `/rooms/${roomId}/runs`, iv, {
      runId: randomUUID(),
      mode: 'run',
      language: 'python3',
      source: 'print(1)',
      input: '',
    });
    const like = `%${SECRET}%`;
    for (const t of [
      'audit_log',
      'room_events',
      'custom_runs',
      'room_docs',
      'room_updates',
      'rooms',
      'room_invites',
    ]) {
      const r = await db.execute<{ n: number }>(
        sql.raw(`select count(*)::int as n from ${t} x where x::text like '${like}'`),
      );
      expect((r.rows ?? (r as unknown as { rows: { n: number }[] }).rows)[0]!.n, t).toBe(0);
    }
    const keys = await redis.keys(`${prefix}*`);
    for (const k of keys) {
      const type = await redis.type(k);
      const dump =
        type === 'stream'
          ? JSON.stringify(await redis.xrange(k, '-', '+'))
          : type === 'string'
            ? ((await redis.get(k)) ?? '')
            : type === 'hash'
              ? JSON.stringify(await redis.hgetall(k))
              : '';
      expect(dump, k).not.toContain(SECRET);
    }
    // and it is stored exactly once, in its own table
    const own = await db.execute<{ n: number }>(
      sql.raw(`select count(*)::int as n from interviewer_notes where room_id = '${roomId}'`),
    );
    expect((own.rows ?? (own as unknown as { rows: { n: number }[] }).rows)[0]!.n).toBe(1);
  });
});
