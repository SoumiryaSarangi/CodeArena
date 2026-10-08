import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  auditLog,
  contests,
  participants,
  problemVersions,
  problems,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
});
const s3Up = await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET_TESTS })).then(
  () => true,
  () => false,
);
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
const ready = s3Up && redisUp && (await postgresReachable());

const prefix = `t${randomBytes(4).toString('hex')}:`;
const csrf = randomBytes(32).toString('base64url');
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const [P1, P2] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .slice(0, 2) as [string, string];
const MIN = 60_000;
const SRC = 'int main(){return 0;}';

describe.skipIf(!ready)('C-10: exam mode (needs the Compose Postgres, Redis and S3)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let redis: Redis;
  let tokens: AccessTokens;
  let admin: { id: string; token: string };
  let exam: { id: string; slug: string };
  let plain: { id: string; slug: string };

  const makeUser = async (role: 'user' | 'setter' | 'admin' = 'user') => {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      email: `${id}@example.test`,
      role,
      handle: `m${id.slice(0, 8)}`,
    });
    const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
    return { id, token };
  };
  const call = (
    method: 'get' | 'post' | 'put' | 'patch',
    path: string,
    token?: string,
    body?: unknown,
  ) => {
    const r = request(app.getHttpServer())[method](`/api${path}`);
    if (token) r.set('Authorization', `Bearer ${token}`);
    r.set('Cookie', `ca_csrf=${csrf}`).set('X-CSRF-Token', csrf);
    return body === undefined ? r : r.send(body as object);
  };
  const times = (id: string, startIn: number, endIn: number) =>
    db
      .update(contests)
      .set({ startsAt: new Date(Date.now() + startIn), endsAt: new Date(Date.now() + endIn) })
      .where(eq(contests.id, id));
  const make = async (slug: string, rules?: object) => {
    const made = await call('post', '/admin/contests', admin.token, {
      slug,
      title: slug,
      startsAt: new Date(Date.now() + 60 * MIN).toISOString(),
      endsAt: new Date(Date.now() + 180 * MIN).toISOString(),
      ...(rules ? { rules } : {}),
    });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    await call('put', `/admin/contests/${id}/problems`, admin.token, {
      items: [
        { label: 'A', slug: P1 },
        { label: 'B', slug: P2 },
      ],
    });
    expect(
      (await call('patch', `/admin/contests/${id}`, admin.token, { published: true })).status,
    ).toBe(200);
    return { id, slug };
  };
  const join = async (c: { slug: string }, role: 'user' | 'setter' = 'user') => {
    const u = await makeUser(role);
    expect((await call('post', `/contests/${c.slug}/register`, u.token)).status).toBe(201);
    return u;
  };
  /** Each test starts from a running contest and expires the debounce of its own participant. */
  const resetDebounce = (userId: string) =>
    db
      .update(participants)
      .set({ lastLeaveAt: new Date(Date.now() - 10_000) })
      .where(eq(participants.userId, userId));
  const leave = (u: { token: string }, c = exam) =>
    call('post', `/contests/${c.slug}/leave`, u.token);
  const finish = (u: { token: string }, c = exam) =>
    call('post', `/contests/${c.slug}/finish`, u.token);
  const submit = (u: { token: string }, c = exam) =>
    call('post', '/submissions', u.token, {
      contestSlug: c.slug,
      label: 'A',
      language: 'cpp17',
      source: SRC,
    });

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DEFAULT_PER_MIN: '100000',
      DATABASE_URL: t.url,
      QUEUE_KEY_PREFIX: prefix,
    });
    redis = new Redis(cfg.REDIS_URL);
    app = await createApp(cfg);
    await app.init();
    tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    const importer = app.get(ProblemImporter);
    for (const slug of [P1, P2]) {
      const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
      if (!r.ok) throw new Error(`${slug} rejected`);
      await importer.import(r.pkg, { visibility: 'contest' });
      await db
        .update(problemVersions)
        .set({ validationStatus: 'passed' })
        .where(
          eq(
            problemVersions.problemId,
            (await db.select({ id: problems.id }).from(problems).where(eq(problems.slug, slug)))[0]!
              .id,
          ),
        );
    }
    admin = await makeUser('admin');
    exam = await make(`e-${prefix.slice(0, -1)}`, { examMode: true });
    plain = await make(`p-${prefix.slice(0, -1)}`);
    await times(exam.id, -MIN, 120 * MIN);
    await times(plain.id, -MIN, 120 * MIN);
  });

  afterAll(async () => {
    await app?.close();
    const keys = redis ? await redis.keys(`${prefix}*`) : [];
    if (keys.length) await redis.del(...keys);
    redis?.disconnect();
    await drop?.();
  });

  it('FR-EXAM-01: the contest says whether it is an exam, and a participant sees their own state', async () => {
    const u = await join(exam);
    const mine = await call('get', `/contests/${exam.slug}`, u.token);
    expect(mine.body.rules.examMode).toBe(true);
    expect(mine.body.exam).toEqual({
      finishedAt: null,
      finishReason: null,
      strikes: 0,
      maxStrikes: 3,
    });
    const guest = await call('get', `/contests/${exam.slug}`);
    expect(guest.body.exam).toBeNull();
    const other = await join(plain);
    const normal = await call('get', `/contests/${plain.slug}`, other.token);
    expect(normal.body.rules.examMode).toBe(false);
    expect(normal.body.exam).toBeNull();
  });

  it('FR-EXAM-01: contests stored before exam mode existed read as off', async () => {
    await db
      .update(contests)
      .set({ rules: { penaltyMinutes: 20 } })
      .where(eq(contests.id, plain.id));
    const r = await call('get', `/contests/${plain.slug}`);
    expect(r.status).toBe(200);
    expect(r.body.rules.examMode).toBe(false);
  });

  it('FR-EXAM-02: strikes 1 and 2 warn, the 3rd finishes the test as left-window', async () => {
    const u = await join(exam);
    const one = await leave(u);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ strikes: 1, remaining: 2, finished: false, counted: true });
    await resetDebounce(u.id);
    const two = await leave(u);
    expect(two.body).toEqual({ strikes: 2, remaining: 1, finished: false, counted: true });
    expect((await submit(u)).status).toBe(201); // two strikes: still in the test
    await resetDebounce(u.id);
    const three = await leave(u);
    expect(three.body).toEqual({ strikes: 3, remaining: 0, finished: true, counted: true });
    const d = await call('get', `/contests/${exam.slug}`, u.token);
    expect(d.body.exam).toMatchObject({ finishReason: 'left-window', strikes: 3 });
    expect(d.body.exam.finishedAt).not.toBeNull();
  });

  it('FR-EXAM-02: a burst inside two seconds counts once (Alt-Tab fires blur and visibilitychange)', async () => {
    const u = await join(exam);
    const first = await leave(u);
    expect(first.body.counted).toBe(true);
    const second = await leave(u);
    expect(second.body).toEqual({ strikes: 1, remaining: 2, finished: false, counted: false });
    const third = await leave(u);
    expect(third.body.strikes).toBe(1);
  });

  it('FR-EXAM-02: parallel calls never skip or double a strike', async () => {
    const u = await join(exam);
    const results = await Promise.all(Array.from({ length: 8 }, () => leave(u)));
    expect(results.filter((r) => r.body.counted)).toHaveLength(1);
    const row = (await db.select().from(participants).where(eq(participants.userId, u.id)))[0]!;
    expect(row.leaveCount).toBe(1);
  });

  it('FR-EXAM-01: finishing is idempotent and records the reason', async () => {
    const u = await join(exam);
    const a = await finish(u);
    expect(a.status).toBe(200);
    expect(a.body.exam).toMatchObject({ finishReason: 'self' });
    const stamp = a.body.exam.finishedAt;
    const b = await finish(u);
    expect(b.status).toBe(200);
    expect(b.body.exam.finishedAt).toBe(stamp);
  });

  it('FR-EXAM-03: after finishing there is no way back in while the contest runs', async () => {
    const u = await join(exam);
    expect((await submit(u)).status).toBe(201);
    await finish(u);
    const blocked = await submit(u);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('contest-finished');
    const run = await call('post', '/runs', u.token, {
      contestSlug: exam.slug,
      label: 'A',
      language: 'cpp17',
      source: SRC,
      input: '1',
    });
    expect(run.status).toBe(403);
    expect(run.body.code).toBe('contest-finished');
    for (const path of [`/contests/${exam.slug}/problems`, `/contests/${exam.slug}/problems/A`]) {
      const r = await call('get', path, u.token);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('contest-finished');
    }
    // The board and the announcements are still readable.
    expect((await call('get', `/contests/${exam.slug}/board`, u.token)).status).toBe(200);
    expect((await call('get', `/contests/${exam.slug}/announcements`, u.token)).status).toBe(200);
    // Other contestants and staff are not affected.
    const other = await join(exam);
    expect((await submit(other)).status).toBe(201);
    expect((await call('get', `/contests/${exam.slug}/problems`, admin.token)).status).toBe(200);
  });

  it('FR-EXAM-03: once the contest has ended a finished participant is a normal contestant again', async () => {
    const u = await join(exam);
    await finish(u);
    await times(exam.id, -200 * MIN, -MIN);
    expect((await call('get', `/contests/${exam.slug}/problems`, u.token)).status).toBe(200);
    const late = await submit(u);
    expect(late.status).toBe(201);
    expect(late.body.lane).toBe('practice');
    await times(exam.id, -MIN, 120 * MIN);
  });

  it('FR-EXAM-04: the endpoints refuse a contest without exam mode, outside the run, and strangers', async () => {
    await db
      .update(contests)
      .set({ rules: { examMode: false } })
      .where(eq(contests.id, plain.id));
    const u = await join(plain);
    expect((await finish(u, plain)).status).toBe(403);
    expect((await leave(u, plain)).status).toBe(403);
    const stranger = await makeUser();
    expect((await leave(stranger)).status).toBe(403);
    expect((await finish(stranger)).status).toBe(403);
    expect((await call('post', `/contests/${exam.slug}/leave`)).status).toBe(401);
    const soon = await make(`s-${prefix.slice(0, -1)}`, { examMode: true });
    const v = await join(soon);
    const early = await leave(v, soon);
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('contest-not-started');
    await times(soon.id, -200 * MIN, -MIN);
    expect((await leave(v, soon)).body.code).toBe('contest-ended');
  });

  it('FR-EXAM-04: staff are never counted', async () => {
    const staff = await makeUser('setter');
    const r = await leave(staff);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ strikes: 0, remaining: 3, finished: false, counted: false });
  });

  it('FR-EXAM-05: the admin sees who left or finished and can reopen a test (audited)', async () => {
    const u = await join(exam);
    await leave(u);
    await resetDebounce(u.id);
    await leave(u);
    await resetDebounce(u.id);
    await leave(u); // finished by leaving
    expect((await call('get', `/admin/contests/${exam.id}/exam`, u.token)).status).toBe(403);
    const list = await call('get', `/admin/contests/${exam.id}/exam`, admin.token);
    expect(list.status).toBe(200);
    const mine = list.body.items.find((i: { userId: string }) => i.userId === u.id);
    expect(mine).toMatchObject({
      leaveCount: 3,
      finishReason: 'left-window',
      handle: expect.stringMatching(/^m/),
    });
    expect((await submit(u)).status).toBe(403);

    const denied = await call(
      'post',
      `/admin/contests/${exam.id}/participants/${u.id}/reopen`,
      u.token,
    );
    expect(denied.status).toBe(403);
    const ok = await call(
      'post',
      `/admin/contests/${exam.id}/participants/${u.id}/reopen`,
      admin.token,
    );
    expect(ok.status).toBe(204);
    const after = await call('get', `/contests/${exam.slug}`, u.token);
    expect(after.body.exam).toEqual({
      finishedAt: null,
      finishReason: null,
      strikes: 0,
      maxStrikes: 3,
    });
    expect((await submit(u)).status).toBe(201);
    const rows = await db.select().from(auditLog);
    expect(rows.some((r) => r.action === 'contest.reopen' && r.actorId === admin.id)).toBe(true);
    expect(
      (
        await call(
          'post',
          `/admin/contests/${exam.id}/participants/${randomUUID()}/reopen`,
          admin.token,
        )
      ).status,
    ).toBe(404);
  });

  it('FR-EXAM-01: admins can switch exam mode on when creating a contest, and it is stored in the rules', async () => {
    const r = await call('get', `/admin/contests/${exam.id}`, admin.token);
    expect(r.body.rules.examMode).toBe(true);
  });
});
