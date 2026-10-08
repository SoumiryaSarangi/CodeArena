import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contests,
  participants,
  problemTags,
  problemVersions,
  problems,
  submissions,
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
describe.skipIf(!ready)(
  'UI-05: profile and home (needs the Compose Postgres, Redis and S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let redis: Redis;
    let tokens: AccessTokens;
    let admin: { id: string; token: string };
    let c: { id: string; slug: string };

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
              (
                await db.select({ id: problems.id }).from(problems).where(eq(problems.slug, slug))
              )[0]!.id,
            ),
          );
      }
      admin = await makeUser('admin');
      const slug = `p-${prefix.slice(0, -1)}`;
      const made = await call('post', '/admin/contests', admin.token, {
        slug,
        title: 'Profile',
        startsAt: new Date(Date.now() + 60 * MIN).toISOString(),
        endsAt: new Date(Date.now() + 180 * MIN).toISOString(),
      });
      c = { id: made.body.id, slug };
      await call('put', `/admin/contests/${c.id}/problems`, admin.token, {
        items: [
          { label: 'A', slug: P1 },
          { label: 'B', slug: P2 },
        ],
      });
      expect(
        (await call('patch', `/admin/contests/${c.id}`, admin.token, { published: true })).status,
      ).toBe(200);
    });

    afterAll(async () => {
      await app?.close();
      const keys = redis ? await redis.keys(`${prefix}*`) : [];
      if (keys.length) await redis.del(...keys);
      redis?.disconnect();
      await drop?.();
    });

    const MIN = 60_000;
    const versionOf = async (slug: string) =>
      (
        await db
          .select({ id: problemVersions.id, pid: problems.id })
          .from(problemVersions)
          .innerJoin(problems, eq(problems.id, problemVersions.problemId))
          .where(eq(problems.slug, slug))
      )[0]!;
    const sub = async (
      uid: string,
      slug: string,
      verdict: 'AC' | 'WA',
      over: Partial<typeof submissions.$inferInsert> = {},
    ) => {
      const v = await versionOf(slug);
      await db.insert(submissions).values({
        userId: uid,
        problemVersionId: v.id,
        language: 'cpp17',
        source: 'x',
        sourceBytes: 1,
        lane: 'practice',
        status: 'done',
        verdict,
        ...over,
      });
    };
    const handleOf = async (id: string) =>
      (await db.select({ h: users.handle }).from(users).where(eq(users.id, id)))[0]!.h!;

    it('FR-RATE-03: a public profile has rating, solved counts by difficulty and tag, and a year of activity, and nothing private', async () => {
      const u = await makeUser();
      await db.update(users).set({ rating: 1523 }).where(eq(users.id, u.id));
      const [p1, p2] = [await versionOf(P1), await versionOf(P2)];
      await db
        .update(problems)
        .set({ difficulty: 800, visibility: 'public' })
        .where(eq(problems.id, p1.pid));
      await db
        .update(problems)
        .set({ difficulty: 1500, visibility: 'public' })
        .where(eq(problems.id, p2.pid));
      await db.delete(problemTags).where(inArray(problemTags.problemId, [p1.pid, p2.pid]));
      await db
        .insert(problemTags)
        .values([
          { problemId: p1.pid, tag: 'math' },
          { problemId: p1.pid, tag: 'greedy' },
          { problemId: p2.pid, tag: 'math' },
        ])
        .onConflictDoNothing();
      await sub(u.id, P1, 'WA');
      await sub(u.id, P1, 'AC');
      await sub(u.id, P1, 'AC'); // the same problem twice counts once
      await sub(u.id, P2, 'AC', { createdAt: new Date(Date.now() - 3 * 86_400_000) });
      await sub(u.id, P2, 'AC', { createdAt: new Date(Date.now() - 400 * 86_400_000) }); // older than a year

      const r = await call('get', `/users/${await handleOf(u.id)}/profile`); // no token
      expect(r.status).toBe(200);
      expect(r.body.rating).toBe(1523);
      expect(r.body.solved.total).toBe(2);
      expect(r.body.solved.byDifficulty).toEqual([
        { label: 'Under 1000', count: 1 },
        { label: '1000–1399', count: 0 },
        { label: '1400–1799', count: 1 },
        { label: '1800 and up', count: 0 },
      ]);
      expect(r.body.solved.byTag).toEqual([
        { tag: 'math', count: 2 },
        { tag: 'greedy', count: 1 },
      ]);
      expect(r.body.activity.total).toBe(4); // five submissions, one of them 400 days old
      expect(r.body.activity.days.reduce((n: number, d: { count: number }) => n + d.count, 0)).toBe(
        4,
      );
      expect(r.body.activity.days.every((d: { count: number }) => d.count > 0)).toBe(true);
      // Public data only.
      expect(Object.keys(r.body).sort()).toEqual([
        'activity',
        'avatarUrl',
        'handle',
        'joinedAt',
        'rating',
        'solved',
      ]);
      expect(JSON.stringify(r.body)).not.toContain('@example.test');
      expect((await call('get', '/users/nobody-here/profile')).status).toBe(404);
    });

    it('a contest problem only counts once its contest is over', async () => {
      const u = await makeUser();
      const v = await versionOf(P1);
      const [c] = await db
        .insert(contests)
        .values({
          slug: `pc-${randomBytes(3).toString('hex')}`,
          title: 'Running',
          startsAt: new Date(Date.now() - 30 * MIN),
          endsAt: new Date(Date.now() + 60 * MIN),
          status: 'scheduled',
          rules: {},
        })
        .returning({ id: contests.id });
      await sub(u.id, P1, 'AC', { contestId: c!.id, lane: 'contest' });
      const h = await handleOf(u.id);
      expect((await call('get', `/users/${h}/profile`)).body.solved.total).toBe(0);
      await db
        .update(contests)
        .set({ endsAt: new Date(Date.now() - MIN) })
        .where(eq(contests.id, c!.id));
      expect((await call('get', `/users/${h}/profile`)).body.solved.total).toBe(1);
      void v;
    });

    it('S03: home shows the next contest with my registration, my last practised problems, and warm-ups only for a newcomer', async () => {
      const u = await makeUser();
      // The contest from beforeAll holds these problems: while it is unfinished practice hides them.
      await db.update(contests).set({ status: 'draft' }).where(eq(contests.status, 'scheduled'));
      expect((await call('get', '/me/home')).status).toBe(401);
      const [p1, p2] = [await versionOf(P1), await versionOf(P2)];
      await db
        .update(problems)
        .set({ visibility: 'public', difficulty: 800 })
        .where(eq(problems.id, p1.pid));
      await db
        .update(problems)
        .set({ visibility: 'public', difficulty: 900 })
        .where(eq(problems.id, p2.pid));
      const fresh = await call('get', '/me/home', u.token);
      expect(fresh.status).toBe(200);
      expect(fresh.body.continuePracticing).toEqual([]);
      expect(fresh.body.warmUps.map((w: { slug: string }) => w.slug)).toEqual(
        expect.arrayContaining([P1, P2]),
      );
      expect(fresh.body.warmUps.length).toBeLessThanOrEqual(5);

      await sub(u.id, P1, 'WA', { createdAt: new Date(Date.now() - 2 * MIN) });
      await sub(u.id, P2, 'AC', { createdAt: new Date(Date.now() - MIN) });
      const home = await call('get', '/me/home', u.token);
      expect(home.body.warmUps).toEqual([]); // no longer a newcomer
      expect(home.body.continuePracticing).toEqual([
        expect.objectContaining({ slug: P2, solved: true, lastVerdict: 'AC' }),
        expect.objectContaining({ slug: P1, solved: false, lastVerdict: 'WA' }),
      ]);

      // Next contest: the earliest published one that has not ended; mine shows registration.
      const mk = (slug: string, startIn: number, status: 'scheduled' | 'draft') =>
        db
          .insert(contests)
          .values({
            slug: `${slug}-${randomBytes(3).toString('hex')}`,
            title: slug,
            startsAt: new Date(Date.now() + startIn),
            endsAt: new Date(Date.now() + startIn + 60 * MIN),
            status,
            rules: {},
          })
          .returning({ id: contests.id, slug: contests.slug });
      await db.update(contests).set({ status: 'draft' }).where(eq(contests.status, 'scheduled'));
      const [later] = await mk('later', 5 * 60 * MIN, 'scheduled');
      const [soon] = await mk('soon', 2 * 60 * MIN, 'scheduled');
      await mk('draft-first', 10 * MIN, 'draft'); // drafts never show
      const a = await call('get', '/me/home', u.token);
      expect(a.body.nextContest).toMatchObject({
        slug: soon!.slug,
        state: 'scheduled',
        registered: false,
      });
      await db.insert(participants).values({ contestId: soon!.id, userId: u.id });
      expect((await call('get', '/me/home', u.token)).body.nextContest.registered).toBe(true);
      void later;
    });
  },
);
