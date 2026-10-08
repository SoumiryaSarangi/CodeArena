import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contestProblems,
  contests,
  participants,
  problemVersions,
  problems,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { contestMinute, contestState } from './state';

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
const [P1, P2, PUBLIC] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .slice(0, 3) as [string, string, string];

const MIN = 60_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('FR-CONT-03: contest state comes from the clock', () => {
  const c = (status: 'draft' | 'scheduled' | 'finalized') => ({
    status,
    startsAt: new Date('2026-10-10T12:00:00Z'),
    endsAt: new Date('2026-10-10T14:00:00Z'),
  });
  it('scheduled before the start, running until the end, ended after', () => {
    const t = (iso: string) => new Date(iso);
    expect(contestState(c('scheduled'), t('2026-10-10T11:59:59Z'))).toBe('scheduled');
    expect(contestState(c('scheduled'), t('2026-10-10T12:00:00Z'))).toBe('running');
    expect(contestState(c('scheduled'), t('2026-10-10T13:59:59Z'))).toBe('running');
    expect(contestState(c('scheduled'), t('2026-10-10T14:00:00Z'))).toBe('ended');
  });
  it('draft and finalized are stored decisions, not time', () => {
    expect(contestState(c('draft'), new Date('2026-10-10T13:00:00Z'))).toBe('draft');
    expect(contestState(c('finalized'), new Date('2026-10-10T11:00:00Z'))).toBe('finalized');
  });
  it('PRD §9.1: the minute is floored from the official start', () => {
    const s = new Date('2026-10-10T12:00:00Z');
    expect(contestMinute(s, new Date('2026-10-10T12:00:59Z'))).toBe(0);
    expect(contestMinute(s, new Date('2026-10-10T12:01:00Z'))).toBe(1);
    expect(contestMinute(s, new Date('2026-10-10T11:59:00Z'))).toBe(0);
  });
});

describe.skipIf(!ready)(
  'C-01: contests, registration, visibility, lanes (needs the Compose Postgres, Redis and S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let redis: Redis;
    let tokens: AccessTokens;
    let admin: { id: string; token: string };
    let setter: { id: string; token: string };

    const makeUser = async (role: 'user' | 'setter' | 'admin') => {
      const id = randomUUID();
      await db.insert(users).values({
        id,
        email: `${id}@example.test`,
        role,
        handle: `u${id.slice(0, 8)}`,
      });
      const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
      return { id, token };
    };
    const call = (
      method: 'get' | 'post' | 'patch' | 'put',
      path: string,
      token?: string,
      body?: unknown,
    ) => {
      const r = request(app.getHttpServer())[method](`/api${path}`);
      if (token) r.set('Authorization', `Bearer ${token}`);
      r.set('Cookie', `ca_csrf=${csrf}`).set('X-CSRF-Token', csrf);
      return body === undefined ? r : r.send(body as object);
    };
    const markValidated = async (...slugs: string[]) => {
      for (const slug of slugs) {
        const [p] = await db
          .select({ id: problems.id })
          .from(problems)
          .where(eq(problems.slug, slug));
        await db
          .update(problemVersions)
          .set({ validationStatus: 'passed' })
          .where(eq(problemVersions.problemId, p!.id));
      }
    };
    let n = 0;
    /** A published contest with problems A and B, starting `startIn` ms from now and lasting `len`. */
    const makeContest = async (startIn: number, len = 120 * MIN, extra: object = {}) => {
      await markValidated(P1, P2);
      const slug = `c-${prefix.replace(':', '')}-${n++}`;
      const created = await call('post', '/admin/contests', admin.token, {
        slug,
        title: `Contest ${n}`,
        startsAt: at(startIn),
        endsAt: at(startIn + len),
        ...extra,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      const put = await call('put', `/admin/contests/${id}/problems`, admin.token, {
        items: [
          { label: 'A', slug: P1 },
          { label: 'B', slug: P2 },
        ],
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const pub = await call('patch', `/admin/contests/${id}`, admin.token, { published: true });
      expect(pub.status, JSON.stringify(pub.body)).toBe(200);
      return { id, slug };
    };
    /** Moves the clock by rewriting the times (the server decides state from `now()`). */
    const setTimes = (id: string, startIn: number, endIn: number, freezeIn?: number) =>
      db
        .update(contests)
        .set({
          startsAt: new Date(Date.now() + startIn),
          endsAt: new Date(Date.now() + endIn),
          freezeAt: freezeIn === undefined ? null : new Date(Date.now() + freezeIn),
        })
        .where(eq(contests.id, id));

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
      for (const [slug, visibility] of [
        [P1, 'contest'],
        [P2, 'contest'],
        [PUBLIC, 'public'],
      ] as const) {
        const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
        if (!r.ok) throw new Error(`${slug} rejected`);
        await importer.import(r.pkg, { visibility });
      }
      admin = await makeUser('admin');
      setter = await makeUser('setter');
    });

    afterAll(async () => {
      await app?.close();
      redis?.disconnect();
      await drop?.();
    });

    it('FR-AUTH-09: only admins create and edit contests', async () => {
      const user = await makeUser('user');
      const body = { slug: 'role-matrix', title: 'Roles', startsAt: at(MIN), endsAt: at(61 * MIN) };
      expect((await call('post', '/admin/contests', undefined, body)).status).toBe(401);
      expect((await call('post', '/admin/contests', user.token, body)).status).toBe(403);
      expect((await call('post', '/admin/contests', setter.token, body)).status).toBe(403);
      expect((await call('get', '/admin/contests', setter.token)).status).toBe(403);
      expect((await call('post', '/admin/contests', admin.token, body)).status).toBe(201);
    });

    it('FR-CONT-01: times and slug are validated, defaults fill the rules', async () => {
      const base = { title: 'Validation', startsAt: at(MIN), endsAt: at(61 * MIN) };
      const bad = async (extra: object) =>
        (await call('post', '/admin/contests', admin.token, { slug: 'val-x', ...base, ...extra }))
          .status;
      expect(await bad({ endsAt: at(MIN) })).toBe(400); // end == start
      expect(await bad({ freezeAt: at(61 * MIN) })).toBe(400); // freeze at the end
      expect(await bad({ freezeAt: at(-MIN) })).toBe(400); // freeze before the start
      expect(await bad({ slug: 'Bad Slug' })).toBe(400);
      expect(await bad({ rules: { penaltyMinutes: 500 } })).toBe(400);
      const ok = await call('post', '/admin/contests', admin.token, {
        slug: 'val-ok',
        ...base,
        freezeAt: at(31 * MIN),
      });
      expect(ok.status).toBe(201);
      expect(ok.body.state).toBe('draft');
      expect(ok.body.rules).toEqual({
        penaltyMinutes: 20,
        ceCountsAsAttempt: false,
        langMultipliers: { c: 1, cpp17: 1, cpp20: 1, java21: 2, node: 2, python3: 3 },
        rated: true,
        lateRegistration: true,
      });
      const dup = await call('post', '/admin/contests', admin.token, {
        slug: 'val-ok',
        ...base,
      });
      expect(dup.status).toBe(400);
      expect(dup.body.errors[0].path).toBe('slug');
    });

    it('FR-PROB-05: a draft is hidden, and publishing needs validated problem versions', async () => {
      const created = await call('post', '/admin/contests', admin.token, {
        slug: 'needs-validation',
        title: 'Needs validation',
        startsAt: at(60 * MIN),
        endsAt: at(180 * MIN),
      });
      const id = created.body.id as string;
      // Nothing to publish yet.
      expect(
        (await call('patch', `/admin/contests/${id}`, admin.token, { published: true })).status,
      ).toBe(400);
      // A draft accepts unvalidated problems...
      const put = await call('put', `/admin/contests/${id}/problems`, admin.token, {
        items: [{ label: 'A', slug: P1 }],
      });
      expect(put.status).toBe(200);
      expect(put.body.problems[0]).toMatchObject({
        label: 'A',
        slug: P1,
        validationStatus: 'pending',
      });
      // ...but publishing it does not, and names the offender.
      const refused = await call('patch', `/admin/contests/${id}`, admin.token, {
        published: true,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.errors[0].path).toBe(`problems.${P1}`);
      // Hidden from everyone but admins while it is a draft.
      const user = await makeUser('user');
      expect((await call('get', '/contests/needs-validation')).status).toBe(404);
      expect((await call('get', '/contests/needs-validation', setter.token)).status).toBe(404);
      expect((await call('get', '/contests/needs-validation', admin.token)).status).toBe(200);
      expect(
        (await call('get', '/contests', user.token)).body.items.map(
          (c: { slug: string }) => c.slug,
        ),
      ).not.toContain('needs-validation');
      // After validation passes, publishing works and the problem shows as validated.
      await db
        .update(problemVersions)
        .set({ validationStatus: 'passed' })
        .where(
          eq(
            problemVersions.problemId,
            (await db.select({ id: problems.id }).from(problems).where(eq(problems.slug, P1)))[0]!
              .id,
          ),
        );
      const ok = await call('patch', `/admin/contests/${id}`, admin.token, { published: true });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.state).toBe('scheduled');
      // A published contest refuses an unvalidated problem in its list.
      const again = await call('put', `/admin/contests/${id}/problems`, admin.token, {
        items: [
          { label: 'A', slug: P1 },
          { label: 'B', slug: P2 },
        ],
      });
      expect(again.status).toBe(400);
      expect(again.body.errors[0].path).toBe('items.1.slug');
    });

    it('FR-CONT-03: details carry the server clock, the state follows it', async () => {
      const { id, slug } = await makeContest(60 * MIN);
      const before = Date.now();
      const d = await call('get', `/contests/${slug}`);
      expect(d.status).toBe(200);
      expect(d.body.state).toBe('scheduled');
      expect(Math.abs(Date.parse(d.body.serverNow) - before)).toBeLessThan(5000);
      expect(d.body.problemCount).toBe(2);
      await setTimes(id, -MIN, 60 * MIN);
      expect((await call('get', `/contests/${slug}`)).body.state).toBe('running');
      await setTimes(id, -120 * MIN, -MIN);
      expect((await call('get', `/contests/${slug}`)).body.state).toBe('ended');
    });

    it('FR-CONT-02: registration until the end, once, counted', async () => {
      const { id, slug } = await makeContest(60 * MIN);
      const a = await makeUser('user');
      const b = await makeUser('user');
      expect((await call('post', `/contests/${slug}/register`)).status).toBe(401);
      const first = await call('post', `/contests/${slug}/register`, a.token);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        registered: true,
        registeredCount: 1,
        canRegister: false,
      });
      const again = await call('post', `/contests/${slug}/register`, a.token);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already-registered');
      expect((await call('post', `/contests/${slug}/register`, b.token)).status).toBe(201);
      const seen = await call('get', `/contests/${slug}`, a.token);
      expect(seen.body).toMatchObject({ registered: true, registeredCount: 2 });
      expect((await call('get', `/contests/${slug}`)).body.registered).toBe(false);
      // Late registration while it runs (default), refused once it has ended.
      const late = await makeUser('user');
      await setTimes(id, -MIN, 60 * MIN);
      expect((await call('post', `/contests/${slug}/register`, late.token)).status).toBe(201);
      await setTimes(id, -120 * MIN, -MIN);
      const after = await makeUser('user');
      const r = await call('post', `/contests/${slug}/register`, after.token);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('contest-ended');
    });

    it('FR-CONT-01: with late registration off, registration closes at the start', async () => {
      const { id, slug } = await makeContest(60 * MIN, 120 * MIN, {
        rules: { lateRegistration: false },
      });
      const u = await makeUser('user');
      expect((await call('get', `/contests/${slug}`, u.token)).body.canRegister).toBe(true);
      await setTimes(id, -MIN, 60 * MIN);
      expect((await call('get', `/contests/${slug}`, u.token)).body.canRegister).toBe(false);
      const r = await call('post', `/contests/${slug}/register`, u.token);
      expect(r.status).toBe(403);
    });

    it('FR-PROB-09: problems are invisible before the start, for contestants once it runs', async () => {
      const { id, slug } = await makeContest(60 * MIN);
      const user = await makeUser('user');
      await call('post', `/contests/${slug}/register`, user.token);
      // Before the start: 404 for guests and registered users, readable by staff.
      for (const path of [`/contests/${slug}/problems`, `/contests/${slug}/problems/A`]) {
        expect((await call('get', path)).status, path).toBe(404);
        expect((await call('get', path, user.token)).status, path).toBe(404);
        expect((await call('get', path, setter.token)).status, path).toBe(200);
        expect((await call('get', path, admin.token)).status, path).toBe(200);
      }
      // Not in practice either, however it is listed.
      expect((await call('get', `/problems/${P1}`)).status).toBe(404);
      expect(
        (await call('get', '/problems')).body.items.map((p: { slug: string }) => p.slug),
      ).not.toContain(P1);
      // Running: registered contestants read it, a stranger does not.
      await setTimes(id, -MIN, 60 * MIN);
      const stranger = await makeUser('user');
      expect((await call('get', `/contests/${slug}/problems`, stranger.token)).status).toBe(403);
      expect((await call('get', `/contests/${slug}/problems`)).status).toBe(403);
      const list = await call('get', `/contests/${slug}/problems`, user.token);
      expect(list.status).toBe(200);
      expect(list.body.items.map((p: { label: string }) => p.label)).toEqual(['A', 'B']);
      const one = await call('get', `/contests/${slug}/problems/b`, user.token);
      expect(one.body).toMatchObject({ label: 'B', slug: P2 });
      expect(one.body.statementMd.length).toBeGreaterThan(20);
      expect((await call('get', `/contests/${slug}/problems/Z`, user.token)).status).toBe(404);
      expect((await call('get', `/problems/${P1}`)).status).toBe(404);
      // Ended: open to everyone, and it appears in practice. (The other tests' contests reuse these
      // problems; practice waits for *all* of them, so end those too.)
      await db
        .update(contests)
        .set({
          startsAt: new Date(Date.now() - 300 * MIN),
          endsAt: new Date(Date.now() - 200 * MIN),
        })
        .where(ne(contests.id, id));
      await setTimes(id, -120 * MIN, -MIN);
      expect((await call('get', `/contests/${slug}/problems/A`)).status).toBe(200);
      expect((await call('get', `/problems/${P1}`)).status).toBe(200);
      expect(
        (await call('get', '/problems')).body.items.map((p: { slug: string }) => p.slug),
      ).toContain(P1);
    });

    it('FR-PROB-09: a public problem inside a published contest leaves practice until it ends', async () => {
      const { id } = await makeContest(60 * MIN);
      await call('put', `/admin/contests/${id}/problems`, admin.token, {
        items: [{ label: 'A', slug: PUBLIC }],
      }).then((r) => expect(r.status, JSON.stringify(r.body)).toBe(400)); // unvalidated, published
      await markValidated(PUBLIC);
      expect((await call('get', `/problems/${PUBLIC}`)).status).toBe(200);
      const r = await call('put', `/admin/contests/${id}/problems`, admin.token, {
        items: [{ label: 'A', slug: PUBLIC }],
      });
      expect(r.status).toBe(200);
      expect((await call('get', `/problems/${PUBLIC}`)).status).toBe(404);
      await setTimes(id, -120 * MIN, -MIN);
      expect((await call('get', `/problems/${PUBLIC}`)).status).toBe(200);
    });

    describe('FR-SUB-03/08: submissions and lanes', () => {
      const src = 'int main(){return 0;}';
      const submit = (token: string, body: object) =>
        call('post', '/submissions', token, { language: 'cpp17', source: src, ...body });

      it('before the start: contest-not-started; running: contest lane with minute and freeze flag', async () => {
        const { id, slug } = await makeContest(60 * MIN);
        const user = await makeUser('user');
        await call('post', `/contests/${slug}/register`, user.token);
        const early = await submit(user.token, { contestSlug: slug, label: 'A' });
        expect(early.status).toBe(422);
        expect(early.body.code).toBe('contest-not-started');

        await setTimes(id, -(7 * MIN + 30_000), 100 * MIN, 5 * MIN);
        const ok = await submit(user.token, { contestSlug: slug, label: 'A' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.lane).toBe('contest');
        const [row] = await db.select().from(submissions).where(eq(submissions.id, ok.body.id));
        expect(row).toMatchObject({
          lane: 'contest',
          contestId: id,
          contestMinute: 7,
          afterFreeze: false,
        });
        const queued = await redis.xrange(`${prefix}jobs:contest`, '-', '+');
        expect(queued.some(([, f]) => JSON.stringify(f).includes(ok.body.id))).toBe(true);

        // After the freeze time the flag is set.
        await setTimes(id, -60 * MIN, 60 * MIN, -MIN);
        const frozen = await submit(user.token, { contestSlug: slug, label: 'B' });
        const [fr] = await db.select().from(submissions).where(eq(submissions.id, frozen.body.id));
        expect(fr).toMatchObject({ lane: 'contest', afterFreeze: true, contestMinute: 60 });
      });

      it('a contest submission needs registration; the problem is judged at the pinned version', async () => {
        const { id, slug } = await makeContest(-MIN, 60 * MIN);
        const stranger = await makeUser('user');
        expect((await submit(stranger.token, { contestSlug: slug, label: 'A' })).status).toBe(403);
        const user = await makeUser('user');
        await db.insert(participants).values({ contestId: id, userId: user.id });
        const ok = await submit(user.token, { contestSlug: slug, label: 'A' });
        expect(ok.status).toBe(201);
        const [row] = await db.select().from(submissions).where(eq(submissions.id, ok.body.id));
        const [pinned] = await db
          .select({ versionId: contestProblems.versionId })
          .from(contestProblems)
          .where(and(eq(contestProblems.contestId, id), eq(contestProblems.label, 'A')));
        expect(row!.problemVersionId).toBe(pinned!.versionId);
        expect((await submit(user.token, { contestSlug: slug, label: 'Q' })).status).toBe(404);
        expect((await submit(user.token, { contestSlug: 'nope', label: 'A' })).status).toBe(404);
      });

      it('after the end: accepted as practice, no contest id, never on the board', async () => {
        const { id, slug } = await makeContest(-MIN, 60 * MIN);
        const user = await makeUser('user');
        await db.insert(participants).values({ contestId: id, userId: user.id });
        await setTimes(id, -120 * MIN, -MIN);
        const r = await submit(user.token, { contestSlug: slug, label: 'A' });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.lane).toBe('practice');
        const [row] = await db.select().from(submissions).where(eq(submissions.id, r.body.id));
        expect(row).toMatchObject({ lane: 'practice', contestId: null, contestMinute: null });
      });

      it('a hidden problem cannot be submitted to by slug, and the two forms do not mix', async () => {
        const user = await makeUser('user');
        const { slug } = await makeContest(60 * MIN);
        expect((await submit(user.token, { problemSlug: P1 })).status).toBe(404);
        expect(
          (await submit(user.token, { problemSlug: PUBLIC, contestSlug: slug, label: 'A' })).status,
        ).toBe(400);
        expect((await submit(user.token, { contestSlug: slug })).status).toBe(400);
        expect((await submit(user.token, {})).status).toBe(400);
      });

      it('C-04: sample and custom runs work on contest problems under the same rules', async () => {
        const run = (token: string, body: object) =>
          call('post', '/runs', token, { language: 'cpp17', source: 'int main(){}', ...body });
        const { id, slug } = await makeContest(60 * MIN);
        const user = await makeUser('user');
        await call('post', `/contests/${slug}/register`, user.token);
        const early = await run(user.token, { contestSlug: slug, label: 'A', sampleIds: [1] });
        expect(early.status).toBe(422);
        expect(early.body.code).toBe('contest-not-started');
        await setTimes(id, -MIN, 60 * MIN);
        const ok = await run(user.token, { contestSlug: slug, label: 'A', sampleIds: [1] });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.runIds).toHaveLength(1);
        const custom = await run(user.token, { contestSlug: slug, label: 'B', input: '1 2\n' });
        expect(custom.status).toBe(201);
        const stranger = await makeUser('user');
        expect(
          (await run(stranger.token, { contestSlug: slug, label: 'A', input: '1' })).status,
        ).toBe(403);
        expect((await run(user.token, { contestSlug: slug, label: 'Q', input: '1' })).status).toBe(
          404,
        );
        expect(
          (
            await run(user.token, {
              problemSlug: PUBLIC,
              contestSlug: slug,
              label: 'A',
              input: '1',
            })
          ).status,
        ).toBe(400);
        // The statement for the arena carries the checker kind, never its source.
        const detail = await call('get', `/contests/${slug}/problems/A`, user.token);
        expect(detail.body.checker).toEqual({ kind: expect.any(String) });
        expect(JSON.stringify(detail.body)).not.toContain('sourceUri');
      });

      it('FR-SUB-03: an ordinary public problem still goes to the practice lane', async () => {
        const user = await makeUser('user');
        const r = await submit(user.token, { problemSlug: PUBLIC });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.lane).toBe('practice');
      });
    });
  },
);
