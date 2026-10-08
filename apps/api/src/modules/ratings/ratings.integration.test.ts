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
  ratingChanges,
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
const MIN = 60_000;

describe.skipIf(!ready)(
  'C-08: finalising and ratings (needs the Compose Postgres, Redis and S3)',
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
    const times = (startIn: number, endIn: number) =>
      db
        .update(contests)
        .set({ startsAt: new Date(Date.now() + startIn), endsAt: new Date(Date.now() + endIn) })
        .where(eq(contests.id, c.id));
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
      const slug = `r-${prefix.slice(0, -1)}`;
      const made = await call('post', '/admin/contests', admin.token, {
        slug,
        title: 'Ratings',
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

    const versionId = async (slug: string) =>
      (
        await db
          .select({ id: problemVersions.id })
          .from(problemVersions)
          .innerJoin(problems, eq(problems.id, problemVersions.problemId))
          .where(eq(problems.slug, slug))
      )[0]!.id;
    /** A user with a rating, registered in the contest; `solves` are [slug, minute, verdict = AC] submissions. */
    const contestant = async (
      rating: number,
      solves: [string, number, ('AC' | 'WA')?][],
      opts: { register?: boolean } = {},
    ) => {
      const u = await makeUser();
      await db.update(users).set({ rating }).where(eq(users.id, u.id));
      if (opts.register !== false)
        await db.insert(participants).values({ contestId: c.id, userId: u.id });
      for (const [slug, minute, verdict] of solves) {
        await db.insert(submissions).values({
          userId: u.id,
          problemVersionId: await versionId(slug),
          contestId: c.id,
          language: 'cpp17',
          source: 'x',
          sourceBytes: 1,
          lane: 'contest',
          contestMinute: minute,
          status: 'done',
          verdict: verdict ?? 'AC',
          judgedAt: new Date(),
          createdAt: new Date(Date.now() - 200 * MIN + minute * MIN),
        });
      }
      return u;
    };
    const finalize = (token = admin.token) =>
      call('post', `/admin/contests/${c.id}/finalize`, token);
    const rows = () => db.select().from(ratingChanges).where(eq(ratingChanges.contestId, c.id));
    const rating = async (id: string) =>
      (await db.select({ r: users.rating }).from(users).where(eq(users.id, id)))[0]!.r;

    it('FR-CONT-07: only an admin, only after the end, only once', async () => {
      const u = await makeUser();
      await times(-30 * MIN, 60 * MIN);
      expect((await finalize(u.token)).status).toBe(403);
      expect((await finalize()).status).toBe(400); // still running
      expect((await call('get', `/contests/${c.slug}/results`)).status).toBe(404);
      await times(-120 * MIN, -MIN);
      await db
        .update(contests)
        .set({ freezeAt: new Date(Date.now() - 30 * MIN) })
        .where(eq(contests.id, c.id));
      // Nobody took part: it still finalises, as an unrated contest.
      const done = await finalize();
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body).toEqual({ rated: false, changes: 0 });
      expect((await finalize()).status).toBe(400); // already final
      expect((await call('get', `/contests/${c.slug}/results`)).body).toMatchObject({
        rated: false,
        changes: [],
      });
      expect((await db.select().from(contests).where(eq(contests.id, c.id)))[0]!.status).toBe(
        'finalized',
      );
    });

    it('FR-RATE-01: fewer than 5 participants, or an unrated contest, changes nobody', async () => {
      const mk = async (n: number, rated: boolean) => {
        const slug = `r-${randomBytes(4).toString('hex')}`;
        const made = await call('post', '/admin/contests', admin.token, {
          slug,
          title: 'Small',
          startsAt: new Date(Date.now() + 60 * MIN).toISOString(),
          endsAt: new Date(Date.now() + 180 * MIN).toISOString(),
          rules: { rated },
        });
        const other = { id: made.body.id as string };
        await db
          .update(contests)
          .set({
            status: 'scheduled',
            startsAt: new Date(Date.now() - 200 * MIN),
            endsAt: new Date(Date.now() - MIN),
          })
          .where(eq(contests.id, other.id));
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const u = await makeUser();
          ids.push(u.id);
          await db.insert(participants).values({ contestId: other.id, userId: u.id });
          await db.insert(submissions).values({
            userId: u.id,
            problemVersionId: await versionId(P1),
            contestId: other.id,
            language: 'cpp17',
            source: 'x',
            sourceBytes: 1,
            lane: 'contest',
            contestMinute: 10 + i,
            status: 'done',
            verdict: 'AC',
          });
        }
        return { id: other.id, ids };
      };
      for (const [n, rated] of [
        [4, true],
        [6, false],
      ] as const) {
        const { id, ids } = await mk(n, rated);
        const r = await call('post', `/admin/contests/${id}/finalize`, admin.token);
        expect(r.body).toEqual({ rated: false, changes: 0 });
        for (const u of ids) expect(await rating(u)).toBe(1400);
      }
    });

    it('FR-RATE-01/02, FR-CONT-07: a rated contest rates the active participants and can be recomputed identically', async () => {
      // A new contest so the earlier one does not interfere.
      const slug = `r-${randomBytes(4).toString('hex')}`;
      const made = await call('post', '/admin/contests', admin.token, {
        slug,
        title: 'Rated',
        startsAt: new Date(Date.now() + 60 * MIN).toISOString(),
        endsAt: new Date(Date.now() + 180 * MIN).toISOString(),
      });
      c = { id: made.body.id, slug };
      await call('put', `/admin/contests/${c.id}/problems`, admin.token, {
        items: [{ label: 'A', slug: P1 }],
      });
      await db
        .update(contests)
        .set({
          status: 'scheduled',
          startsAt: new Date(Date.now() - 200 * MIN),
          endsAt: new Date(Date.now() - MIN),
          freezeAt: new Date(Date.now() - 60 * MIN),
        })
        .where(eq(contests.id, c.id));
      // rating, solves: the strongest player is beaten by the weakest.
      const a = await contestant(1800, [[P1, 50]]);
      const b = await contestant(1600, [[P1, 20]]);
      const d = await contestant(1500, [[P1, 10]]);
      const e = await contestant(1400, [[P1, 30, 'WA']]); // tried, solved nothing
      const f = await contestant(1200, [[P1, 5]]);
      const g = await contestant(1400, [[P1, 5]]); // ties with f
      const idle = await contestant(2000, [], { register: true }); // registered, never submitted
      const before = new Map<string, number>(
        [a, b, d, e, f, g, idle].map(
          (u, i) => [u.id, [1800, 1600, 1500, 1400, 1200, 1400, 2000][i]!] as [string, number],
        ),
      );

      const done = await finalize();
      expect(done.body).toEqual({ rated: true, changes: 6 });
      const stored = await rows();
      expect(stored).toHaveLength(6);
      expect(stored.some((r) => r.userId === idle.id)).toBe(false);
      expect(await rating(idle.id)).toBe(2000);
      // f and g solved at minute 5: tied for first among the six; a and e are last (e solved none).
      const rank = (id: string) => stored.find((r) => r.userId === id)!.rank;
      expect([rank(f.id), rank(g.id), rank(d.id), rank(b.id), rank(a.id), rank(e.id)]).toEqual([
        1, 1, 3, 4, 5, 6,
      ]);
      expect(stored.reduce((s, r) => s + r.delta, 0)).toBeLessThanOrEqual(0);
      for (const r of stored) {
        expect(r.oldRating).toBe(before.get(r.userId));
        expect(r.newRating).toBe(r.oldRating + r.delta);
        expect(await rating(r.userId)).toBe(r.newRating);
      }
      // The weakest winner gains; the strongest, who came fifth of six, loses.
      expect(stored.find((r) => r.userId === f.id)!.delta).toBeGreaterThan(0);
      expect(stored.find((r) => r.userId === a.id)!.delta).toBeLessThan(0);

      // Final results are public; the board is no longer frozen.
      const res = await call('get', `/contests/${c.slug}/results`);
      expect(res.body.rated).toBe(true);
      expect(res.body.changes.map((x: { rank: number }) => x.rank)).toEqual([1, 1, 3, 4, 5, 6]);
      expect((await call('get', `/contests/${c.slug}/board`)).body.frozen).toBe(false);

      // Recomputing, twice, changes nothing.
      const snapshot = JSON.stringify(await rows());
      for (let i = 0; i < 2; i++) {
        const r = await call('post', `/admin/contests/${c.id}/recompute-ratings`, admin.token);
        expect(r.body).toEqual({ differing: 0, changes: 6 });
      }
      expect(JSON.stringify(await rows())).toBe(snapshot);
      for (const r of stored) expect(await rating(r.userId)).toBe(r.newRating);
      expect(
        (await call('post', `/admin/contests/${c.id}/recompute-ratings`, a.token)).status,
      ).toBe(403);
      const logged = await db.select().from(auditLog).where(eq(auditLog.targetId, c.id));
      expect(logged.map((l) => l.action)).toEqual(
        expect.arrayContaining(['contest.finalize', 'contest.recompute-ratings']),
      );

      // A disqualification changes the standings; the recompute notices, and later ratings are left alone.
      await db.update(submissions).set({ disqualified: true }).where(eq(submissions.userId, f.id));
      await db.update(users).set({ rating: 9999 }).where(eq(users.id, g.id)); // g has since played another contest
      const changed = await call('post', `/admin/contests/${c.id}/recompute-ratings`, admin.token);
      expect(changed.body.differing).toBeGreaterThan(0);
      expect(await rating(g.id)).toBe(9999);
      // f no longer counts, so f's row is not rewritten with a rank.
      expect((await rows()).length).toBe(6);
    });

    it('FR-RATE-03: a profile has its rating history, oldest first', async () => {
      const u = await makeUser();
      expect((await call('get', '/users/nobody-here/ratings')).status).toBe(404);
      const own = (await db.select({ h: users.handle }).from(users).where(eq(users.id, u.id)))[0]!
        .h!;
      const empty = await call('get', `/users/${own}/ratings`);
      expect(empty.body).toEqual({ handle: own, rating: 1400, history: [] });
      const [some] = await rows();
      const owner = (
        await db.select({ h: users.handle }).from(users).where(eq(users.id, some!.userId))
      )[0]!.h!;
      const h = await call('get', `/users/${owner}/ratings`);
      expect(h.status).toBe(200);
      expect(h.body.history).toHaveLength(1);
      expect(h.body.history[0]).toMatchObject({
        contestSlug: c.slug,
        oldRating: some!.oldRating,
        newRating: some!.newRating,
      });
      expect(h.body.rating).toBe(await rating(some!.userId));
    });
  },
);
