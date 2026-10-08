import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contests,
  judgeRuns,
  problemVersions,
  problems,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { seedLoad } from './load-test';
import { verifyContest } from './verify';

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
const redisUp = await new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
})
  .connect()
  .then(() => true)
  .catch(() => false);
const ready = s3Up && redisUp && (await postgresReachable());
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const [P1] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name) as [string];
const log = pino({ level: 'silent' });
const prefix = `v${randomBytes(4).toString('hex')}:`;

describe.skipIf(!ready)(
  'O-06: the invariants every failure drill checks (needs Postgres, Redis, S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let redis: Redis;
    let slug = '';
    let contestId = '';
    let userId = '';
    let version = '';
    let n = 0;

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      redis = new Redis(config.REDIS_URL);
      const r = parsePackage(P1, readPackageDirectory(`${root}${P1}`));
      if (!r.ok) throw new Error('package rejected');
      await new ProblemImporter(db, s3, config).import(r.pkg, { visibility: 'public' });
      const seed = await seedLoad(db, log, { count: 1, problems: [P1], tag: 'drl' });
      slug = seed.contest.slug;
      const [c] = await db
        .select({ id: contests.id })
        .from(contests)
        .where(eq(contests.slug, slug));
      contestId = c!.id;
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.handle, seed.users[0]!.handle));
      userId = u!.id;
      version = (
        await db
          .select({ id: problemVersions.id })
          .from(problemVersions)
          .innerJoin(problems, eq(problems.id, problemVersions.problemId))
          .where(eq(problems.slug, P1))
      )[0]!.id;
    });
    afterAll(async () => {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await drop?.();
    });

    const sub = async (over: { judged?: boolean; run?: boolean } = {}) => {
      const judged = over.judged ?? true;
      const [s] = await db
        .insert(submissions)
        .values({
          userId,
          problemVersionId: version,
          contestId,
          language: 'cpp17',
          source: `x${n++}`,
          sourceBytes: 2,
          lane: 'contest',
          status: judged ? 'done' : 'queued',
          verdict: judged ? 'AC' : null,
          judgedAt: judged ? new Date() : null,
        })
        .returning({ id: submissions.id });
      if (judged && over.run !== false) {
        await db
          .insert(judgeRuns)
          .values({ submissionId: s!.id, runVersion: 1, workerId: 'w', verdict: 'AC' });
      }
      return s!.id;
    };
    const result = (id: string) =>
      redis.xadd(
        `${prefix}results`,
        '*',
        'result',
        JSON.stringify({ submissionId: id, runVersion: 1, verdict: 'AC' }),
      );
    const check = (expectJobsDlq = 0) => verifyContest(db, redis, slug, { prefix, expectJobsDlq });

    it('NFR-REL-01: a clean contest passes: verdicts, one run and one result each, empty dead-letter streams', async () => {
      for (let i = 0; i < 2; i++) await result(await sub());
      const v = await check();
      expect(v.problems).toEqual([]);
      expect(v).toMatchObject({
        ok: true,
        submissions: 2,
        withVerdict: 2,
        resultEntries: 2,
        duplicateResultEntries: 0,
      });
      expect(v.byVerdict).toEqual({ AC: 2 });
    });

    it('NFR-REL-01: a submission without a verdict fails the check', async () => {
      const id = await sub({ judged: false });
      const v = await check();
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('no final verdict');
      expect(v.problems.join(' ')).toContain(id);
      await db.delete(submissions).where(eq(submissions.id, id));
    });

    it('NFR-REL-01: a submission the API could not queue (stored as failed) is counted, not a problem', async () => {
      const id = await sub({ judged: false });
      await db.update(submissions).set({ status: 'failed' }).where(eq(submissions.id, id));
      const v = await check();
      expect(v.problems).toEqual([]);
      expect(v.failedSubmissions).toBe(1);
      await db.delete(submissions).where(eq(submissions.id, id));
    });

    it('NFR-REL-01: a verdict with no stored run fails the check', async () => {
      const id = await sub({ run: false });
      const v = await check();
      expect(v.problems.join(' ')).toContain('no stored run');
      await db.delete(submissions).where(eq(submissions.id, id));
    });

    it('FR-QUEUE-07: a job that published two results fails the check', async () => {
      const id = await sub();
      await result(id);
      await result(id);
      const v = await check();
      expect(v.duplicateResultEntries).toBe(1);
      expect(v.problems.join(' ')).toContain('more than one result');
      await redis.del(`${prefix}results`);
      await db.delete(judgeRuns).where(eq(judgeRuns.submissionId, id));
      await db.delete(submissions).where(eq(submissions.id, id));
    });

    it('NFR-REL-01: a parked result fails the check, and a dead-lettered job only when it is not expected', async () => {
      await redis.xadd(`${prefix}results:dlq`, '*', 'raw', '{}', 'reason', 'unknown-submission');
      expect((await check()).problems.join(' ')).toContain('parked in results:dlq');
      await redis.del(`${prefix}results:dlq`);

      await redis.xadd(`${prefix}jobs:dlq`, '*', 'job', '{}', 'reason', 'execution-failed');
      expect((await check()).problems.join(' ')).toContain('jobs:dlq has 1 entries, expected 0');
      expect((await check(1)).problems).toEqual([]); // the poison drill expects exactly one
      await redis.del(`${prefix}jobs:dlq`);
    });

    it('FR-QUEUE-07: a job still claimed by a judge fails the check', async () => {
      const key = `${prefix}jobs:contest`;
      await redis.xgroup('CREATE', key, 'judges', '$', 'MKSTREAM');
      await redis.xadd(key, '*', 'job', '{}');
      await redis.xreadgroup('GROUP', 'judges', 'w1', 'COUNT', 1, 'STREAMS', key, '>');
      const v = await check();
      expect(v.pendingJobs).toBe(1);
      expect(v.problems.join(' ')).toContain('still claimed by a judge');
      await redis.del(key);
    });

    it('a Redis command the user may not run is reported as not checked, not as a failure', async () => {
      const v = await verifyContest(db, null, slug, { prefix });
      expect(v.ok).toBe(true);
      expect(v.notChecked).toContain('redis: not given');
    });
  },
);
