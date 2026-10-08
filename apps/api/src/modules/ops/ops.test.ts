import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  announcements,
  auditLog,
  contests,
  problemVersions,
  problems,
  submissions,
  users,
} from '../../db/schema';
import { ResultsProcessor } from '../submissions/results.processor';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { buildJob } from '../submissions/job-builder';
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
  'C-07: contest operations (needs the Compose Postgres, Redis and S3)',
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
    const registered = async () => {
      const u = await makeUser();
      expect((await call('post', `/contests/${c.slug}/register`, u.token)).status).toBe(201);
      return u;
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
      const slug = `o-${prefix.slice(0, -1)}`;
      const made = await call('post', '/admin/contests', admin.token, {
        slug,
        title: 'Ops',
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

    const versionOf = async (slug: string) =>
      (
        await db
          .select({ id: problemVersions.id, problemId: problems.id })
          .from(problemVersions)
          .innerJoin(problems, eq(problems.id, problemVersions.problemId))
          .where(eq(problems.slug, slug))
      )[0]!;
    const addSub = async (
      uid: string,
      slug: string,
      over: Partial<typeof submissions.$inferInsert> = {},
    ) => {
      const v = await versionOf(slug);
      const [s] = await db
        .insert(submissions)
        .values({
          userId: uid,
          problemVersionId: v.id,
          contestId: c.id,
          language: 'cpp17',
          source: 'int main(){}',
          sourceBytes: 12,
          lane: 'contest',
          contestMinute: 5,
          status: 'done',
          verdict: 'WA',
          judgedAt: new Date(),
          ...over,
        })
        .returning({ id: submissions.id });
      return s!.id;
    };
    const subRow = async (id: string) =>
      (await db.select().from(submissions).where(eq(submissions.id, id)))[0]!;
    const result = (id: string, verdict: string, runVersion: number) =>
      JSON.stringify({
        submissionId: id,
        runVersion,
        verdict,
        timeMs: 10,
        memKb: 1000,
        tests: [],
        workerId: 'w-test',
        finishedAt: Date.now(),
      });
    const jobs = async (lane: string) =>
      (await redis.xrange(`${prefix}jobs:${lane}`, '-', '+')).map(
        ([, f]) =>
          JSON.parse(f[f.indexOf('job') + 1]!) as {
            submissionId: string;
            runVersion: number;
            lane: string;
          },
      );

    it('FR-CONT-05: an admin extends a contest that has not ended; everyone is told', async () => {
      await times(-30 * MIN, 60 * MIN);
      const u = await makeUser();
      expect(
        (await call('post', `/admin/contests/${c.id}/extend`, u.token, { minutes: 10 })).status,
      ).toBe(403);
      expect(
        (await call('post', `/admin/contests/${c.id}/extend`, admin.token, { minutes: 0 })).status,
      ).toBe(400);
      expect(
        (await call('post', `/admin/contests/${c.id}/extend`, admin.token, { minutes: 181 }))
          .status,
      ).toBe(400);
      const before = (await db.select().from(contests).where(eq(contests.id, c.id)))[0]!.endsAt;
      const ok = await call('post', `/admin/contests/${c.id}/extend`, admin.token, { minutes: 15 });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const after = (await db.select().from(contests).where(eq(contests.id, c.id)))[0]!.endsAt;
      expect(after.getTime() - before.getTime()).toBe(15 * MIN);
      expect(ok.body.endsAt).toBe(after.toISOString());
      const notes = await db.select().from(announcements).where(eq(announcements.contestId, c.id));
      expect(notes.map((n) => n.body).join('\n')).toContain('extended by 15 minutes');
      const logged = await db.select().from(auditLog).where(eq(auditLog.action, 'contest.extend'));
      expect(logged.some((r) => r.targetId === c.id)).toBe(true);
      // The longest a contest may be is 1023 minutes.
      await db
        .update(contests)
        .set({ startsAt: new Date(Date.now() - MIN), endsAt: new Date(Date.now() + 1022 * MIN) })
        .where(eq(contests.id, c.id));
      const tooLong = await call('post', `/admin/contests/${c.id}/extend`, admin.token, {
        minutes: 5,
      });
      expect(tooLong.status).toBe(400);
      // Over: no extension.
      await times(-120 * MIN, -MIN);
      const over = await call('post', `/admin/contests/${c.id}/extend`, admin.token, {
        minutes: 5,
      });
      expect(over.status).toBe(400);
    });

    it('hiding a problem removes it from contestants, submissions and the board; showing restores it', async () => {
      await times(-30 * MIN, 120 * MIN);
      const u = await registered();
      const url = `/admin/contests/${c.id}/problems/B/visibility`;
      expect((await call('post', url, u.token, { hidden: true })).status).toBe(403);
      expect(
        (
          await call('post', `/admin/contests/${c.id}/problems/Z/visibility`, admin.token, {
            hidden: true,
          })
        ).status,
      ).toBe(404);
      const labels = async () =>
        (await call('get', `/contests/${c.slug}/problems`, u.token)).body.items.map(
          (p: { label: string }) => p.label,
        );
      const boardLabels = async () =>
        (await call('get', `/contests/${c.slug}/board`)).body.problems.map(
          (p: { label: string }) => p.label,
        );
      expect(await labels()).toEqual(['A', 'B']);
      expect(await boardLabels()).toEqual(['A', 'B']);

      expect((await call('post', url, admin.token, { hidden: true })).body).toEqual({
        hidden: true,
      });
      expect(await labels()).toEqual(['A']);
      expect(await boardLabels()).toEqual(['A']);
      const detail = await call('get', `/admin/contests/${c.id}`, admin.token);
      expect(
        detail.body.problems.map((p: { label: string; hidden: boolean }) => [p.label, p.hidden]),
      ).toEqual([
        ['A', false],
        ['B', true],
      ]);
      const sub = await call('post', '/submissions', u.token, {
        contestSlug: c.slug,
        label: 'B',
        language: 'cpp17',
        source: 'int main(){}',
      });
      expect(sub.status).toBe(404);

      await call('post', url, admin.token, { hidden: false });
      expect(await labels()).toEqual(['A', 'B']);
      expect(await boardLabels()).toEqual(['A', 'B']);
      const logged = await db.select().from(auditLog).where(eq(auditLog.targetId, c.id));
      expect(logged.map((r) => r.action)).toEqual(
        expect.arrayContaining(['contest.hide-problem', 'contest.show-problem']),
      );
    });

    it('FR-OPS-02: a rejudge raises the run version, queues a job, and the newer verdict wins', async () => {
      const u = await makeUser();
      const id = await addSub(u.id, P1);
      expect(
        (await call('post', '/admin/rejudge', u.token, { scope: 'submission', id })).status,
      ).toBe(403);
      expect(
        (await call('post', '/admin/rejudge', admin.token, { scope: 'submission', id: 'nope' }))
          .status,
      ).toBe(400);
      expect(
        (
          await call('post', '/admin/rejudge', admin.token, {
            scope: 'submission',
            id: randomUUID(),
          })
        ).status,
      ).toBe(404);

      const r = await call('post', '/admin/rejudge', admin.token, { scope: 'submission', id });
      expect(r.body).toEqual({ queued: 1, skipped: 0, truncated: false });
      expect((await subRow(id)).currentRunVersion).toBe(2);
      expect((await subRow(id)).verdict).toBe('WA'); // the old verdict stays until the new one arrives
      expect((await jobs('rejudge')).filter((j) => j.submissionId === id)).toEqual([
        expect.objectContaining({ runVersion: 2, lane: 'rejudge' }),
      ]);

      const processor = app.get(ResultsProcessor);
      expect((await processor.handle(result(id, 'AC', 2))).kind).toBe('applied');
      expect((await subRow(id)).verdict).toBe('AC');
      // The first run's result arriving late must not undo it.
      const late = await processor.handle(result(id, 'WA', 1));
      expect(late.kind).not.toBe('applied');
      expect((await subRow(id)).verdict).toBe('AC');

      const logged = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'rejudge'), eq(auditLog.targetId, id)));
      expect(logged).toHaveLength(1);
    });

    it('FR-OPS-02: contest and problem scopes; unfinished submissions are skipped; urgent uses the contest lane', async () => {
      const u = await makeUser();
      const a = await addSub(u.id, P1);
      const b = await addSub(u.id, P2);
      const waiting = await addSub(u.id, P1, { status: 'queued', verdict: null, judgedAt: null });
      const r = await call('post', '/admin/rejudge', admin.token, {
        scope: 'contest',
        id: c.id,
        urgent: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.skipped).toBeGreaterThanOrEqual(1);
      expect((await subRow(waiting)).currentRunVersion).toBe(1);
      for (const s of [a, b]) {
        expect((await subRow(s)).currentRunVersion).toBeGreaterThanOrEqual(2);
        expect(
          (await jobs('contest')).some((j) => j.submissionId === s && j.lane === 'contest'),
        ).toBe(true);
      }
      const bBefore = (await subRow(b)).currentRunVersion;
      const v = await versionOf(P1);
      const p = await call('post', '/admin/rejudge', admin.token, {
        scope: 'problem',
        id: v.problemId,
      });
      expect(p.body.queued).toBeGreaterThanOrEqual(1);
      expect((await subRow(a)).currentRunVersion).toBeGreaterThanOrEqual(3);
      expect((await subRow(b)).currentRunVersion).toBe(bBefore); // the other problem is untouched
    });

    it('FR-OPS-01: the summary shows lane depths, live workers, times to verdict and the dead letters', async () => {
      const u = await makeUser();
      const t = new Date();
      await addSub(u.id, P1, { createdAt: new Date(t.getTime() - 4000), judgedAt: t });
      await addSub(u.id, P1, { createdAt: new Date(t.getTime() - 1000), judgedAt: t });
      const now = Date.now();
      await redis.set(
        `${prefix}hb:w-live`,
        JSON.stringify({
          workerId: 'w-live',
          lanes: ['contest'],
          ts: now - 2000,
          busy: 1,
          concurrency: 2,
        }),
        'EX',
        30,
      );
      await redis.set(
        `${prefix}hb:w-old`,
        JSON.stringify({
          workerId: 'w-old',
          lanes: ['contest'],
          ts: now - 5 * MIN,
          busy: 0,
          concurrency: 2,
        }),
        'EX',
        30,
      );
      expect((await call('get', '/admin/ops/summary', u.token)).status).toBe(403);
      const s = await call('get', '/admin/ops/summary', admin.token);
      expect(s.status).toBe(200);
      expect(s.body.lanes.map((l: { lane: string }) => l.lane)).toEqual([
        'contest',
        'interactive',
        'practice',
        'rejudge',
      ]);
      const depth = Object.fromEntries(
        s.body.lanes.map((l: { lane: string; depth: number }) => [l.lane, l.depth]),
      );
      expect(depth.rejudge).toBe((await jobs('rejudge')).length);
      expect(s.body.workers).toEqual([
        expect.objectContaining({ id: 'w-live', busy: 1, concurrency: 2 }),
      ]);
      expect(s.body.p95Ms).toBeGreaterThanOrEqual(s.body.p50Ms);
      expect(s.body.p50Ms).toBeGreaterThan(0);
      expect(s.body.submissionsPerMin).toBeGreaterThan(0);
      expect(s.body.dlq).toBe(0);
    });

    it('FR-OPS-01: dead letters are listed and can be put back on their lane', async () => {
      const [job] = await jobs('rejudge');
      const full = (await redis.xrange(`${prefix}jobs:rejudge`, '-', '+'))[0]![1];
      const raw = full[full.indexOf('job') + 1]!;
      const dlq = `${prefix}jobs:dlq`;
      const id1 = await redis.xadd(
        dlq,
        '*',
        'job',
        raw,
        'reason',
        'crash-loop',
        'error',
        'boom',
        'workerId',
        'w1',
        'lane',
        'rejudge',
        'entry',
        '1-0',
        'ts',
        String(Date.now()),
      );
      const id2 = await redis.xadd(
        dlq,
        '*',
        'job',
        '{"nope":1}',
        'reason',
        'invalid-job',
        'error',
        'bad',
        'workerId',
        'w1',
        'lane',
        'practice',
        'entry',
        '2-0',
        'ts',
        String(Date.now()),
      );
      const u = await makeUser();
      expect((await call('get', '/admin/dlq', u.token)).status).toBe(403);
      const list = await call('get', '/admin/dlq', admin.token);
      expect(list.body.items[0]).toMatchObject({
        entryId: id2,
        reason: 'invalid-job',
        submissionId: null,
      });
      expect(list.body.items[1]).toMatchObject({
        entryId: id1,
        reason: 'crash-loop',
        submissionId: job!.submissionId,
      });
      expect((await call('get', '/admin/ops/summary', admin.token)).body.dlq).toBe(2);

      const before = (await jobs('rejudge')).length;
      expect((await call('post', `/admin/dlq/${id2}/requeue`, admin.token)).status).toBe(400);
      expect((await call('post', '/admin/dlq/zzz/requeue', admin.token)).status).toBe(404);
      const ok = await call('post', `/admin/dlq/${id1}/requeue`, admin.token);
      expect(ok.body).toEqual({ lane: 'rejudge' });
      expect((await jobs('rejudge')).length).toBe(before + 1);
      expect(
        (await call('get', '/admin/dlq', admin.token)).body.items.map(
          (i: { entryId: string }) => i.entryId,
        ),
      ).toEqual([id2]);
      expect(
        (await db.select().from(auditLog).where(eq(auditLog.action, 'dlq.requeue'))).length,
      ).toBe(1);
    });

    /** A dead-lettered job for a submission, as the worker writes it (`execution-failed`). */
    const deadJob = async (id: string, runVersion: number) => {
      const row = await subRow(id);
      const [v] = await db
        .select()
        .from(problemVersions)
        .where(eq(problemVersions.id, row.problemVersionId));
      const job = buildJob(
        { id, language: 'cpp17', source: 'int main(){}', lane: 'contest', runVersion },
        {
          problemId: '',
          title: '',
          id: v!.id,
          testsetHash: v!.testsetHash,
          testsetUri: v!.testsetUri,
          limits: v!.limits,
          checker: v!.checker,
          samples: v!.samples,
        } as never,
        'submit',
      );
      const raw = JSON.stringify({
        ...job,
        seq: 1,
        jobId: `j-${id}`,
        enqueuedAt: 1,
        traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
      });
      return redis.xadd(
        `${prefix}jobs:dlq`,
        '*',
        'job',
        raw,
        'reason',
        'execution-failed',
        'error',
        'testset missing',
        'workerId',
        'w1',
        'lane',
        'contest',
        'entry',
        '9-0',
        'ts',
        String(Date.now()),
      );
    };

    it('O-06: re-queueing a dead job whose run already stored a verdict starts a new run, so the new verdict counts', async () => {
      const u = await makeUser();
      const id = await addSub(u.id, P1, { status: 'queued', verdict: null, judgedAt: null });
      const processor = app.get(ResultsProcessor);
      // What the worker does with a job it cannot run: publishes SE, then dead-letters it.
      expect((await processor.handle(result(id, 'SE', 1))).kind).toBe('applied');
      const entry = await deadJob(id, 1);

      const ok = await call('post', `/admin/dlq/${entry}/requeue`, admin.token);
      expect(ok.status).toBe(200);
      expect((await subRow(id)).currentRunVersion).toBe(2);
      const queued = (await jobs('contest')).filter((j) => j.submissionId === id);
      expect(queued).toEqual([expect.objectContaining({ runVersion: 2 })]);

      // The retry's result is for run 2: it replaces the SE instead of being thrown away as a duplicate.
      expect((await processor.handle(result(id, 'AC', 2))).kind).toBe('applied');
      expect((await subRow(id)).verdict).toBe('AC');
      expect((await redis.xrange(`${prefix}jobs:dlq`, entry!, entry!)).length).toBe(0);
    });

    it('O-06: re-queueing a dead job whose submission has no verdict yet keeps its run version', async () => {
      const u = await makeUser();
      const id = await addSub(u.id, P1, { status: 'judging', verdict: null, judgedAt: null });
      const entry = await deadJob(id, 1);
      expect((await call('post', `/admin/dlq/${entry}/requeue`, admin.token)).status).toBe(200);
      expect((await subRow(id)).currentRunVersion).toBe(1);
      expect((await jobs('contest')).filter((j) => j.submissionId === id)).toEqual([
        expect.objectContaining({ runVersion: 1 }),
      ]);
    });
  },
);
