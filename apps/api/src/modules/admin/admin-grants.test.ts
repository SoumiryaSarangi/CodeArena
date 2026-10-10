import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { adminGrants, users } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { UsersService } from '../users/users.service';
import { MAX_GRANTS } from './admin-grants.service';

const OWNER = 'owner@example.test';
const ready = await postgresReachable();
const prefix = `t${randomBytes(4).toString('hex')}:`;
const csrf = randomBytes(32).toString('base64url');

const login = (svc: UsersService, email: string) =>
  svc.upsertFromOAuth({
    provider: 'google',
    providerUserId: `g-${email}`,
    email,
    name: null,
    avatarUrl: null,
  });

describe.skipIf(!ready)('FR-AUTH-12..14: admin grants (needs the Compose Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let tokens: AccessTokens;
  let svc: UsersService;

  const makeUser = async (role: 'user' | 'setter' | 'admin', email?: string) => {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      email: email ?? `${id}@example.test`,
      role,
      handle: `u${id.slice(0, 8)}`,
    });
    const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
    return { id, token };
  };
  const call = (method: 'get' | 'post' | 'delete', path: string, token?: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api${path}`);
    if (token) r.set('Authorization', `Bearer ${token}`);
    r.set('Cookie', `ca_csrf=${csrf}`).set('X-CSRF-Token', csrf);
    return body ? r.send(body) : r;
  };
  const roleOf = async (email: string) =>
    (await db.select({ role: users.role }).from(users).where(eq(users.email, email)))[0]?.role;
  const fresh = () => `p${randomBytes(5).toString('hex')}@example.test`;

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    app = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_DEFAULT_PER_MIN: '100000',
        DATABASE_URL: t.url,
        QUEUE_KEY_PREFIX: prefix,
        OWNER_EMAIL: OWNER,
      }),
    );
    await app.init();
    tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    svc = app.get(UsersService);
  });
  afterAll(async () => {
    await app?.close();
    await drop?.();
  });

  it('FR-AUTH-12: the owner is admin from the first sign-in, whatever the capitals, and stays admin', async () => {
    expect((await login(svc, 'Owner@Example.TEST')).role).toBe('admin');
    expect((await login(svc, OWNER)).role).toBe('admin');
  });

  it('FR-AUTH-12: with OWNER_EMAIL unset nobody is owner or promoted', async () => {
    const t = await createTestDatabase();
    try {
      const alone = new UsersService(t.db, loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
      expect(alone.isOwnerEmail(OWNER)).toBe(false);
      expect((await login(alone, OWNER)).role).toBe('user');
    } finally {
      await t.drop();
    }
  });

  it('FR-AUTH-12: a listed address that signs up later becomes admin; an unlisted one stays a user', async () => {
    const boss = await login(svc, OWNER);
    const { token } = await tokens.sign({ sub: boss.id, role: 'admin', sid: randomUUID() });
    const later = fresh();
    expect(
      (await call('post', '/admin/admins', token, { email: later.toUpperCase() })).status,
    ).toBe(204);
    expect((await login(svc, later)).role).toBe('admin');
    expect((await login(svc, fresh())).role).toBe('user');
  });

  it('FR-AUTH-12: adding a listed address promotes an account that already exists, and a later sign-in never lowers a role', async () => {
    const boss = await login(svc, OWNER);
    const { token } = await tokens.sign({ sub: boss.id, role: 'admin', sid: randomUUID() });
    const there = fresh();
    await makeUser('user', there);
    expect(await roleOf(there)).toBe('user');
    expect((await call('post', '/admin/admins', token, { email: there })).status).toBe(204);
    expect(await roleOf(there)).toBe('admin');
    // an admin who is not listed keeps the role at sign-in (only removal lowers it)
    const manual = fresh();
    await makeUser('admin', manual);
    expect((await login(svc, manual)).role).toBe('admin');
  });

  it('FR-AUTH-13: only the owner can list, add or remove: guests 401, users, setters and ordinary admins 403', async () => {
    const boss = await login(svc, OWNER);
    const owner = await tokens.sign({ sub: boss.id, role: 'admin', sid: randomUUID() });
    const target = fresh();
    expect((await call('get', '/admin/admins')).status).toBe(401);
    for (const role of ['user', 'setter', 'admin'] as const) {
      const u = await makeUser(role);
      expect((await call('get', '/admin/admins', u.token)).status, `${role} list`).toBe(403);
      expect(
        (await call('post', '/admin/admins', u.token, { email: target })).status,
        `${role} add`,
      ).toBe(403);
      expect(
        (await call('delete', `/admin/admins/${encodeURIComponent(target)}`, u.token)).status,
        `${role} remove`,
      ).toBe(403);
    }
    const ok = await call('get', '/admin/admins', owner.token);
    expect(ok.status).toBe(200);
    expect(ok.body.owner).toBe(OWNER);
    expect(ok.body.max).toBe(MAX_GRANTS);
  });

  it('FR-AUTH-13: the list says who has signed up; the owner cannot be added or removed; duplicates, bad addresses and the cap are refused', async () => {
    const boss = await login(svc, OWNER);
    const { token } = await tokens.sign({ sub: boss.id, role: 'admin', sid: randomUUID() });
    const waiting = fresh();
    const here = fresh();
    await makeUser('user', here);
    await call('post', '/admin/admins', token, { email: waiting });
    await call('post', '/admin/admins', token, { email: here });
    const list = await call('get', '/admin/admins', token);
    const find = (e: string) => list.body.grants.find((g: { email: string }) => g.email === e);
    expect(find(waiting)).toMatchObject({ signedUp: false, grantedBy: OWNER });
    expect(find(here)).toMatchObject({ signedUp: true });
    expect((await call('post', '/admin/admins', token, { email: OWNER })).status).toBe(409);
    expect((await call('delete', `/admin/admins/${OWNER}`, token)).status).toBe(409);
    expect((await call('post', '/admin/admins', token, { email: waiting })).status).toBe(409);
    expect((await call('post', '/admin/admins', token, { email: 'not an email' })).status).toBe(
      400,
    );
    expect(
      (await call('delete', `/admin/admins/${encodeURIComponent(fresh())}`, token)).status,
    ).toBe(404);
    // fill to the cap directly, then one more is refused
    const have = list.body.grants.length;
    for (let i = have; i < MAX_GRANTS; i++) await db.insert(adminGrants).values({ email: fresh() });
    expect((await call('post', '/admin/admins', token, { email: fresh() })).status).toBe(400);
  });

  it('FR-AUTH-14: removing an address makes that account an ordinary user at once; the owner is untouched', async () => {
    const boss = await login(svc, OWNER);
    const { token } = await tokens.sign({ sub: boss.id, role: 'admin', sid: randomUUID() });
    // make room under the cap first
    await db.delete(adminGrants);
    const who = fresh();
    await login(svc, who);
    expect((await call('post', '/admin/admins', token, { email: who })).status).toBe(204);
    expect(await roleOf(who)).toBe('admin');
    expect((await call('delete', `/admin/admins/${encodeURIComponent(who)}`, token)).status).toBe(
      204,
    );
    expect(await roleOf(who)).toBe('user');
    expect(await roleOf(OWNER)).toBe('admin');
    // signing in again does not bring the role back
    expect((await login(svc, who)).role).toBe('user');
  });

  it('FR-AUTH-13: /me says isOwner for the owner and for nobody else', async () => {
    const boss = await login(svc, OWNER);
    const owner = await tokens.sign({ sub: boss.id, role: 'admin', sid: randomUUID() });
    const other = await makeUser('admin');
    expect((await call('get', '/me', owner.token)).body.isOwner).toBe(true);
    expect((await call('get', '/me', other.token)).body.isOwner).toBe(false);
  });
});
