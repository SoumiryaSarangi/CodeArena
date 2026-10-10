import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { auditLog, setterGrants, users } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { UsersService } from '../users/users.service';
import { MAX_SETTERS } from './setter-grants.service';

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

describe.skipIf(!ready)('FR-AUTH-15..17: setter grants (needs the Compose Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let tokens: AccessTokens;
  let svc: UsersService;
  let ownerToken: string;

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
  const fresh = () => `s${randomBytes(5).toString('hex')}@example.test`;
  const audit = async (action: string, email: string) =>
    (await db.select().from(auditLog).where(eq(auditLog.targetId, email))).filter(
      (r) => r.action === action,
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
        DATABASE_URL: t.url,
        QUEUE_KEY_PREFIX: prefix,
        OWNER_EMAIL: OWNER,
      }),
    );
    await app.init();
    tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    svc = app.get(UsersService);
    const boss = await login(svc, OWNER);
    ownerToken = (await tokens.sign({ sub: boss.id, role: 'admin', sid: randomUUID() })).token;
  });
  afterAll(async () => {
    await app?.close();
    await drop?.();
  });

  it('FR-AUTH-15: a listed address that signs up later becomes a setter; an unlisted one stays a user', async () => {
    const later = fresh();
    expect(
      (await call('post', '/admin/setters', ownerToken, { email: later.toUpperCase() })).status,
    ).toBe(204);
    expect((await login(svc, later)).role).toBe('setter');
    expect((await login(svc, fresh())).role).toBe('user');
  });

  it('FR-AUTH-16: adding promotes an existing user at once, but never lowers an admin or the owner', async () => {
    const there = fresh();
    await makeUser('user', there);
    expect((await call('post', '/admin/setters', ownerToken, { email: there })).status).toBe(204);
    expect(await roleOf(there)).toBe('setter');
    const adm = fresh();
    await makeUser('admin', adm);
    expect((await call('post', '/admin/setters', ownerToken, { email: adm })).status).toBe(204);
    expect(await roleOf(adm)).toBe('admin');
    expect((await login(svc, adm)).role).toBe('admin');
    expect((await call('post', '/admin/setters', ownerToken, { email: OWNER })).status).toBe(409);
    expect(await roleOf(OWNER)).toBe('admin');
  });

  it('FR-AUTH-16: removing turns a setter back into a user at once, leaves an admin an admin, and a later sign-in does not bring the role back', async () => {
    const who = fresh();
    await login(svc, who);
    await call('post', '/admin/setters', ownerToken, { email: who });
    expect(await roleOf(who)).toBe('setter');
    const del = (e: string) =>
      call('delete', `/admin/setters/${encodeURIComponent(e)}`, ownerToken);
    expect((await del(who)).status).toBe(204);
    expect(await roleOf(who)).toBe('user');
    expect((await login(svc, who)).role).toBe('user');
    const adm = fresh();
    await makeUser('admin', adm);
    await call('post', '/admin/setters', ownerToken, { email: adm });
    expect((await del(adm)).status).toBe(204);
    expect(await roleOf(adm)).toBe('admin');
    expect((await del(fresh())).status).toBe(404);
  });

  it('FR-AUTH-17: only the owner can list, add or remove: guests 401, users, setters and ordinary admins 403', async () => {
    const target = fresh();
    expect((await call('get', '/admin/setters')).status).toBe(401);
    for (const role of ['user', 'setter', 'admin'] as const) {
      const u = await makeUser(role);
      expect((await call('get', '/admin/setters', u.token)).status, `${role} list`).toBe(403);
      expect(
        (await call('post', '/admin/setters', u.token, { email: target })).status,
        `${role} add`,
      ).toBe(403);
      expect(
        (await call('delete', `/admin/setters/${encodeURIComponent(target)}`, u.token)).status,
        `${role} remove`,
      ).toBe(403);
    }
    const ok = await call('get', '/admin/setters', ownerToken);
    expect(ok.status).toBe(200);
    expect(ok.body.owner).toBe(OWNER);
    expect(ok.body.max).toBe(MAX_SETTERS);
  });

  it('FR-AUTH-17: the list says who has signed up; duplicates and bad addresses are refused; every change is in the audit log', async () => {
    const waiting = fresh();
    const here = fresh();
    await makeUser('user', here);
    await call('post', '/admin/setters', ownerToken, { email: waiting });
    await call('post', '/admin/setters', ownerToken, { email: here });
    const list = await call('get', '/admin/setters', ownerToken);
    const find = (e: string) => list.body.grants.find((g: { email: string }) => g.email === e);
    expect(find(waiting)).toMatchObject({ signedUp: false, grantedBy: OWNER });
    expect(find(here)).toMatchObject({ signedUp: true });
    expect((await call('post', '/admin/setters', ownerToken, { email: waiting })).status).toBe(409);
    expect(
      (await call('post', '/admin/setters', ownerToken, { email: 'not an email' })).status,
    ).toBe(400);
    await call('delete', `/admin/setters/${encodeURIComponent(waiting)}`, ownerToken);
    expect(await audit('setter.add', waiting)).toHaveLength(1);
    expect(await audit('setter.remove', waiting)).toHaveLength(1);
    expect((await audit('setter.add', waiting))[0]!.actorId).not.toBeNull();
  });

  it('FR-AUTH-17: the list is capped', async () => {
    await db.delete(setterGrants);
    for (let i = 0; i < MAX_SETTERS; i++) await db.insert(setterGrants).values({ email: fresh() });
    expect((await call('post', '/admin/setters', ownerToken, { email: fresh() })).status).toBe(400);
  });

  it('FR-AUTH-14: removing an admin address returns the account to setter when it is also on the setter list', async () => {
    await db.delete(setterGrants);
    const who = fresh();
    await login(svc, who);
    await call('post', '/admin/setters', ownerToken, { email: who });
    await call('post', '/admin/admins', ownerToken, { email: who });
    expect(await roleOf(who)).toBe('admin');
    expect(
      (await call('delete', `/admin/admins/${encodeURIComponent(who)}`, ownerToken)).status,
    ).toBe(204);
    expect(await roleOf(who)).toBe('setter');
  });
});
