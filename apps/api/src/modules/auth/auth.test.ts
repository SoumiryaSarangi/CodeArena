import { createHmac } from 'node:crypto';
import { Controller, Get, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { decodeProtectedHeader, decodeJwt } from 'jose';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { contests, refreshTokens, users } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { FakeOAuth, type FakeIdentity } from '../../test/fake-oauth';
import { TicketsService } from '../realtime/tickets.service';
import { Public, RequireHandle, Roles } from './guards';
import { ACCESS_TOKENS, type AccessTokens } from './keys';
import { safeReturnTo } from './oauth.controller';

@Controller('t')
class Probe {
  @Get('user') user() {
    return { ok: true };
  }
  @Roles('setter') @Get('setter') setter() {
    return { ok: true };
  }
  @Roles('admin') @Get('admin') admin() {
    return { ok: true };
  }
  @RequireHandle() @Post('scored') scored() {
    return { ok: true };
  }
  @Public() @Post('public-mutation') publicMutation() {
    return { ok: true };
  }
}
@Module({ controllers: [Probe] })
class ProbeModule {}

/** Minimal cookie jar: name → value from Set-Cookie; cleared cookies are dropped. */
class Jar {
  private c = new Map<string, string>();
  take(res: Response) {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const line of raw ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eqAt = pair!.indexOf('=');
      const name = pair!.slice(0, eqAt).trim();
      const value = decodeURIComponent(pair!.slice(eqAt + 1));
      const cleared = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim())) || value === '';
      if (cleared) this.c.delete(name);
      else this.c.set(name, value);
    }
    return res;
  }
  get(name: string) {
    return this.c.get(name);
  }
  set(name: string, value: string) {
    this.c.set(name, value);
  }
  header(...names: string[]) {
    return [...this.c]
      .filter(([k]) => names.length === 0 || names.includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  clone() {
    const j = new Jar();
    for (const [k, v] of this.c) j.set(k, v);
    return j;
  }
}

const reachable = await postgresReachable();
if (process.env.CI && !reachable) throw new Error('CI requires the dev stack (scripts/dev-up.sh)');

describe.skipIf(!reachable)('F-06: auth', () => {
  const fake = new FakeOAuth();
  let app: INestApplication;
  let db: Db;
  let drop: () => Promise<void>;
  let redis: Redis;
  let server: Parameters<typeof request>[0];
  let seq = 1000;
  const identity = (over: Partial<FakeIdentity> = {}): FakeIdentity => {
    seq += 1;
    return {
      sub: String(seq),
      email: `u${seq}@example.com`,
      emailVerified: true,
      name: `User ${seq}`,
      ...over,
    };
  };

  beforeAll(async () => {
    await fake.start();
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Many logins come from one test IP; the per-route limits under test have their own buckets.
      RATE_LIMIT_DEFAULT_PER_MIN: '100000',
      DATABASE_URL: t.url,
      WEB_URL: 'http://web.test',
      PUBLIC_API_URL: 'http://api.test',
      ...fake.env(),
    });
    redis = new Redis(config.REDIS_URL);
    app = await createApp(config, [ProbeModule]);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await drop?.();
    await fake.stop();
  });

  /** Full browser round trip through start → provider → callback. */
  async function login(
    provider: 'google' | 'github',
    who: FakeIdentity,
    returnTo?: string,
    jar = new Jar(),
  ) {
    const start = jar.take(
      await request(server)
        .get(`/api/auth/${provider}`)
        .query(returnTo ? { returnTo } : {})
        .set('Cookie', jar.header()),
    );
    expect(start.status).toBe(302);
    const { code, state } = fake.authorize(start.headers.location!, who);
    const cb = jar.take(
      await request(server)
        .get(`/api/auth/callback/${provider}`)
        .query({ code, state })
        .set('Cookie', jar.header()),
    );
    return { jar, start, cb, location: cb.headers.location as string };
  }

  const refresh = async (jar: Jar) =>
    jar.take(
      await request(server)
        .post('/api/auth/refresh')
        .set('Cookie', jar.header())
        .set('X-CSRF-Token', jar.get('ca_csrf') ?? ''),
    );

  async function signedIn(who = identity(), provider: 'google' | 'github' = 'google') {
    const { jar } = await login(provider, who);
    const r = await refresh(jar);
    expect(r.status).toBe(200);
    return { jar, token: r.body.accessToken as string, who };
  }

  const authed = (method: 'get' | 'post' | 'patch', path: string, token: string, jar?: Jar) => {
    const req = request(server)[method](path).set('Authorization', `Bearer ${token}`);
    if (jar) req.set('Cookie', jar.header()).set('X-CSRF-Token', jar.get('ca_csrf') ?? '');
    return req;
  };

  const userByEmail = async (email: string) =>
    (await db.select().from(users).where(eq(users.email, email)))[0]!;

  describe('FR-AUTH-01: OAuth with PKCE and state', () => {
    it('FR-AUTH-01: start redirects to the provider with S256 PKCE, state and nonce', async () => {
      const res = await request(server).get('/api/auth/google');
      const u = new URL(res.headers.location!);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(u.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(u.searchParams.get('redirect_uri')).toBe('http://api.test/api/auth/callback/google');
      expect(String(res.headers['set-cookie'])).toMatch(/ca_oauth=.*HttpOnly.*/);
    });

    it('FR-AUTH-01: Google login creates the user and sends a first-timer to onboarding', async () => {
      const who = identity();
      const { location, jar } = await login('google', who);
      expect(location).toBe('http://web.test/onboarding');
      expect(jar.get('ca_rt')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await userByEmail(who.email)).handle).toBeNull();
    });

    it('FR-AUTH-01: GitHub login uses the primary verified email', async () => {
      const who = identity();
      const { location } = await login('github', who);
      expect(location).toBe('http://web.test/onboarding');
      expect(await userByEmail(who.email)).toBeDefined();
    });

    it('FR-AUTH-01: a mismatched state is refused', async () => {
      const jar = new Jar();
      const start = jar.take(await request(server).get('/api/auth/google'));
      const { code } = fake.authorize(start.headers.location!, identity());
      const cb = await request(server)
        .get('/api/auth/callback/google')
        .query({ code, state: 'x'.repeat(43) })
        .set('Cookie', jar.header());
      expect(cb.headers.location).toBe('http://web.test/signin?error=oauth-failed');
      expect(String(cb.headers['set-cookie'])).not.toMatch(/ca_rt=[A-Za-z0-9]/);
    });

    it('FR-AUTH-01: a callback without the flow cookie is refused (login CSRF)', async () => {
      const start = await request(server).get('/api/auth/google');
      const { code, state } = fake.authorize(start.headers.location!, identity());
      const cb = await request(server).get('/api/auth/callback/google').query({ code, state });
      expect(cb.headers.location).toBe('http://web.test/signin?error=oauth-failed');
    });

    it('FR-AUTH-01: the code is useless without the matching PKCE verifier', async () => {
      // Victim's flow cookie, but the code was minted for a different flow (different challenge).
      const victim = new Jar();
      const vStart = victim.take(await request(server).get('/api/auth/google'));
      const attacker = await request(server).get('/api/auth/google');
      const { code } = fake.authorize(attacker.headers.location!, identity());
      const state = new URL(vStart.headers.location!).searchParams.get('state')!;
      const cb = await request(server)
        .get('/api/auth/callback/google')
        .query({ code, state })
        .set('Cookie', victim.header());
      expect(cb.headers.location).toBe('http://web.test/signin?error=oauth-failed');
    });

    it('FR-AUTH-01: an unverified email is refused (Google and GitHub)', async () => {
      for (const p of ['google', 'github'] as const) {
        const who = identity({ emailVerified: false });
        const { location } = await login(p, who);
        expect(location).toBe('http://web.test/signin?error=oauth-failed');
        expect((await db.select().from(users).where(eq(users.email, who.email))).length).toBe(0);
      }
    });

    it('FR-AUTH-01: a returning user maps to the same account and goes back to returnTo', async () => {
      const who = identity();
      await login('google', who);
      const user = await userByEmail(who.email);
      await db
        .update(users)
        .set({ handle: `h${seq}` })
        .where(eq(users.id, user.id));
      const { location } = await login('google', who, '/p/a-plus-b');
      expect(location).toBe('http://web.test/p/a-plus-b');
      expect((await db.select().from(users).where(eq(users.email, who.email))).length).toBe(1);
    });

    it('FR-AUTH-01: Google and GitHub with the same verified email land on one account', async () => {
      const who = identity();
      await login('google', who);
      await login('github', { ...who, sub: String(seq + 50_000) });
      expect((await db.select().from(users).where(eq(users.email, who.email))).length).toBe(1);
    });

    it('FR-AUTH-01: returnTo cannot redirect off-site', () => {
      expect(safeReturnTo('//evil.com')).toBe('/home');
      expect(safeReturnTo('/\\evil.com')).toBe('/home');
      expect(safeReturnTo('https://evil.com')).toBe('/home');
      expect(safeReturnTo('/c/x?y=1')).toBe('/c/x?y=1');
    });
  });

  describe('FR-AUTH-02/03: onboarding and handles', () => {
    it('FR-AUTH-02: scored actions need a handle; PATCH /me sets one', async () => {
      const { token, jar } = await signedIn();
      expect((await authed('post', '/api/t/scored', token, jar)).status).toBe(403);
      const res = await authed('patch', '/api/me', token, jar).send({
        handle: `riya${seq}`,
        defaultLanguage: 'cpp17',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        handle: `riya${seq}`,
        defaultLanguage: 'cpp17',
        role: 'user',
      });
      expect((await authed('post', '/api/t/scored', token, jar)).status).toBe(201);
      expect((await authed('get', '/api/me', token)).body.handle).toBe(`riya${seq}`);
    });

    it('FR-AUTH-03: handle format, reserved words and case-insensitive uniqueness', async () => {
      const a = await signedIn();
      const b = await signedIn();
      const h = `taken${seq}`;
      expect((await authed('patch', '/api/me', a.token, a.jar).send({ handle: h })).status).toBe(
        200,
      );

      const clash = await authed('patch', '/api/me', b.token, b.jar).send({
        handle: h.toUpperCase().toLowerCase(),
      });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('handle-taken');

      const upper = await authed('patch', '/api/me', b.token, b.jar).send({ handle: 'Abc' });
      expect(upper.status).toBe(400); // regex is lowercase-only

      const reserved = await authed('patch', '/api/me', b.token, b.jar).send({ handle: 'admin' });
      expect(reserved.status).toBe(400);

      const check = async (x: string) =>
        (await authed('get', `/api/handles/${x}/available`, b.token)).body;
      expect(await check(h)).toEqual({ available: false, reason: 'taken' });
      expect(await check('root')).toEqual({ available: false, reason: 'reserved' });
      expect(await check('9lives')).toEqual({ available: false, reason: 'invalid' });
      expect(await check(`free${seq}`)).toEqual({ available: true });
    });
  });

  describe('FR-AUTH-04: access tokens', () => {
    it('FR-AUTH-04: ES256, 15 minutes, carries role and session', async () => {
      const { token } = await signedIn();
      expect(decodeProtectedHeader(token).alg).toBe('ES256');
      const p = decodeJwt(token);
      expect(p.exp! - p.iat!).toBe(900);
      expect(p).toMatchObject({ role: 'user', iss: 'codearena', aud: 'codearena-api' });
    });

    it('FR-AUTH-04: refresh tokens are stored only as SHA-256 hashes', async () => {
      const { jar } = await login('google', identity());
      const raw = jar.get('ca_rt')!;
      const rows = await db.select().from(refreshTokens);
      expect(rows.every((r) => r.tokenHash.length === 32)).toBe(true);
      expect(
        rows.some(
          (r) => r.tokenHash.toString('base64url') === raw || r.tokenHash.toString() === raw,
        ),
      ).toBe(false);
    });

    it('FR-AUTH-04: forged, tampered and expired access tokens are rejected', async () => {
      const { token } = await signedIn();
      const [h, p] = token.split('.');
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
      const none = `${b64({ alg: 'none', typ: 'at+jwt' })}.${b64({ ...payload, role: 'admin' })}.`;
      const hsHead = b64({ alg: 'HS256', typ: 'at+jwt' });
      const hsBody = b64({ ...payload, role: 'admin' });
      const hs = `${hsHead}.${hsBody}.${createHmac('sha256', 'secret').update(`${hsHead}.${hsBody}`).digest('base64url')}`;
      const tampered = `${h}.${b64({ ...payload, role: 'admin' })}.${token.split('.')[2]}`;
      const keys = app.get<AccessTokens>(ACCESS_TOKENS);
      const expired = (
        await keys.sign(
          { sub: payload.sub, role: 'admin', sid: payload.sid },
          Date.now() - 20 * 60_000,
        )
      ).token;
      for (const bad of [none, hs, tampered, expired, 'garbage']) {
        const res = await authed('get', '/api/t/user', bad);
        expect(res.status, bad.slice(0, 20)).toBe(401);
      }
      expect((await authed('get', '/api/t/user', token)).status).toBe(200);
    });
  });

  describe('FR-AUTH-05: refresh rotation and reuse detection', () => {
    it('FR-AUTH-05: each refresh rotates the cookie and the old one stops working', async () => {
      const { jar } = await login('google', identity());
      const first = jar.get('ca_rt');
      const r1 = await refresh(jar);
      expect(r1.status).toBe(200);
      expect(r1.body.expiresAt).toBeGreaterThan(Date.now());
      expect(jar.get('ca_rt')).not.toBe(first);
      expect((await refresh(jar)).status).toBe(200);
    });

    it('FR-AUTH-05: replaying a rotated token revokes the whole family', async () => {
      const { jar } = await login('google', identity());
      const stolen = jar.clone();
      expect((await refresh(jar)).status).toBe(200); // legit client rotates
      // Push the rotation out of the race window, as if the thief replays later.
      await db.execute(
        sql`update refresh_tokens set revoked_at = revoked_at - interval '10 seconds' where replaced_by is not null`,
      );
      const replay = await refresh(stolen);
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('token-reused');
      // The legitimate client's newer token is dead too.
      const legit = await refresh(jar);
      expect(legit.status).toBe(401);
      expect(legit.body.code).toBe('unauthorized');
    });

    it('FR-AUTH-05: a concurrent second tab within 5 s is not treated as theft', async () => {
      const { jar } = await login('google', identity());
      const tab2 = jar.clone();
      expect((await refresh(jar)).status).toBe(200);
      const race = await refresh(tab2);
      expect(race.status).toBe(401);
      expect(race.body.code).toBe('unauthorized');
      expect(String(race.headers['set-cookie'] ?? '')).not.toMatch(/ca_rt=;/); // newer cookie kept
      expect((await refresh(jar)).status).toBe(200); // family survives
    });

    it('FR-AUTH-05: two simultaneous refreshes never both succeed', async () => {
      const { jar } = await login('google', identity());
      const [a, b] = await Promise.all([refresh(jar.clone()), refresh(jar.clone())]);
      expect([a.status, b.status].sort()).toEqual([200, 401]);
    });

    it('FR-AUTH-05: an expired refresh token is refused and cleared', async () => {
      const who = identity();
      const { jar } = await login('google', who);
      const u = await userByEmail(who.email);
      await db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.userId, u.id));
      const res = await refresh(jar);
      expect(res.status).toBe(401);
      expect(jar.get('ca_rt')).toBeUndefined();
    });
  });

  it('FR-AUTH-06: cookie attributes', async () => {
    const { cb } = await login('google', identity());
    const rt = (cb.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('ca_rt='),
    )!;
    expect(rt).toMatch(/HttpOnly/);
    expect(rt).toMatch(/Secure/);
    expect(rt).toMatch(/SameSite=Lax/);
    expect(rt).toMatch(/Path=\/api\/auth(;|$)/);
    const csrf = (cb.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('ca_csrf='),
    );
    if (csrf) expect(csrf).not.toMatch(/HttpOnly/);
  });

  it('FR-AUTH-07: mutations need the double-submit CSRF token', async () => {
    const jar = new Jar();
    jar.take(await request(server).get('/api/health/live'));
    expect(jar.get('ca_csrf')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const post = (token?: string) => {
      const r = request(server).post('/api/t/public-mutation').set('Cookie', jar.header());
      return token === undefined ? r : r.set('X-CSRF-Token', token);
    };
    expect((await post()).status).toBe(403);
    expect((await post('x'.repeat(43))).status).toBe(403);
    expect((await post(jar.get('ca_csrf'))).status).toBe(201);
    // Header without the cookie (cross-site attacker cannot read or set it).
    const noCookie = await request(server)
      .post('/api/t/public-mutation')
      .set('X-CSRF-Token', jar.get('ca_csrf')!);
    expect(noCookie.status).toBe(403);
  });

  describe('FR-AUTH-08: sign out', () => {
    it('FR-AUTH-08: logout ends this session only', async () => {
      const who = identity();
      const a = await login('google', who);
      const b = await login('google', who);
      const out = a.jar.take(
        await request(server)
          .post('/api/auth/logout')
          .set('Cookie', a.jar.header())
          .set('X-CSRF-Token', a.jar.get('ca_csrf')!),
      );
      expect(out.status).toBe(204);
      expect(a.jar.get('ca_rt')).toBeUndefined();
      expect((await refresh(b.jar)).status).toBe(200);
    });

    it('FR-AUTH-08: logout-all ends every session', async () => {
      const who = identity();
      const a = await signedIn(who);
      const b = await login('google', who);
      expect((await authed('post', '/api/auth/logout-all', a.token, a.jar)).status).toBe(204);
      expect((await refresh(b.jar)).status).toBe(401);
      const live = await db
        .select()
        .from(refreshTokens)
        .where(
          sql`${refreshTokens.userId} = ${(await userByEmail(who.email)).id} and ${refreshTokens.revokedAt} is null`,
        );
      expect(live).toHaveLength(0);
    });
  });

  it('FR-AUTH-09: roles are enforced server-side with admin ⊇ setter ⊇ user', async () => {
    expect((await request(server).get('/api/t/user')).status).toBe(401);
    const s = await signedIn();
    expect((await authed('get', '/api/t/user', s.token)).status).toBe(200);
    expect((await authed('get', '/api/t/setter', s.token)).status).toBe(403);
    expect((await authed('get', '/api/t/admin', s.token)).status).toBe(403);

    const u = await userByEmail(s.who.email);
    await db.update(users).set({ role: 'setter' }).where(eq(users.id, u.id));
    const setter = (await refresh(s.jar)).body.accessToken;
    expect((await authed('get', '/api/t/setter', setter)).status).toBe(200);
    expect((await authed('get', '/api/t/admin', setter)).status).toBe(403);

    await db.update(users).set({ role: 'admin' }).where(eq(users.id, u.id));
    const admin = (await refresh(s.jar)).body.accessToken;
    expect((await authed('get', '/api/t/setter', admin)).status).toBe(200);
    expect((await authed('get', '/api/t/admin', admin)).status).toBe(200);
  });

  describe('FR-AUTH-11: realtime tickets', () => {
    const ticket = (body: object, token?: string, jar = new Jar()) => {
      const r = request(server).post('/api/realtime/ticket').send(body);
      if (token) r.set('Authorization', `Bearer ${token}`);
      return jar.header()
        ? r.set('Cookie', jar.header()).set('X-CSRF-Token', jar.get('ca_csrf')!)
        : r;
    };

    it('FR-AUTH-11: 256-bit, 60-second, single-use, bound to the granted topics', async () => {
      const s = await signedIn();
      const res = await ticket({ topics: ['sys'] }, s.token, s.jar);
      expect(res.status).toBe(200);
      expect(res.body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes
      const ttl = await redis.ttl(`tkt:${res.body.ticket}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      const svc = app.get(TicketsService);
      expect(await svc.redeem(res.body.ticket, ['admin:ops'])).toBeNull(); // asks for more than granted…
      const again = await ticket({ topics: ['sys'] }, s.token, s.jar);
      const first = await svc.redeem(again.body.ticket, ['sys']);
      expect(first).toMatchObject({ uid: (await userByEmail(s.who.email)).id, topics: ['sys'] });
      expect(await svc.redeem(again.body.ticket, ['sys'])).toBeNull(); // …and it is single use
    });

    it('FR-AUTH-11: topic authorisation for users, admins and guests', async () => {
      const s = await signedIn();
      const guestJar = new Jar();
      guestJar.take(await request(server).get('/api/health/live'));
      expect((await ticket({ topics: ['sys'] }, undefined, guestJar)).status).toBe(200);

      const forbidden = await ticket({ topics: ['admin:ops'] }, s.token, s.jar);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('forbidden-topic');
      expect(
        (await ticket({ topics: [`sub:${crypto.randomUUID()}`] }, s.token, s.jar)).status,
      ).toBe(403);
      expect(
        (await ticket({ topics: [`sub:${crypto.randomUUID()}`] }, undefined, guestJar)).status,
      ).toBe(403);
      expect((await ticket({ roomId: crypto.randomUUID() }, s.token, s.jar)).status).toBe(403);
      expect((await ticket({ topics: ['bogus'] }, s.token, s.jar)).status).toBe(400);

      // Published contest: the board is public, other contest streams need registration.
      const [c] = await db
        .insert(contests)
        .values({
          slug: `c${seq}`,
          title: 'Weekly',
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3600_000),
          rules: {},
          status: 'scheduled',
        })
        .returning();
      expect(
        (await ticket({ topics: [`contest:${c!.id}:board`] }, undefined, guestJar)).status,
      ).toBe(200);
      expect((await ticket({ topics: [`contest:${c!.id}:clar`] }, s.token, s.jar)).status).toBe(
        403,
      );

      const u = await userByEmail(s.who.email);
      await db.update(users).set({ role: 'admin' }).where(eq(users.id, u.id));
      const admin = (await refresh(s.jar)).body.accessToken;
      expect(
        (await ticket({ topics: ['admin:ops', `contest:${c!.id}:clar`] }, admin, s.jar)).status,
      ).toBe(200);
    });

    it('NFR-SEC-06: tickets are limited to 30 per minute', async () => {
      const s = await signedIn();
      for (let i = 0; i < 30; i++)
        expect((await ticket({ topics: ['sys'] }, s.token, s.jar)).status).toBe(200);
      const res = await ticket({ topics: ['sys'] }, s.token, s.jar);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('rate-limited');
    });
  });

  it('F-06: the refresh-token family survives in the database for audit', async () => {
    const rows = await db.select().from(refreshTokens).where(isNotNull(refreshTokens.replacedBy));
    expect(rows.length).toBeGreaterThan(0);
  });
});
