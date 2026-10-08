import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contests,
  judgeRuns,
  participants,
  problemVersions,
  problems,
  refreshTokens,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { contestState } from '../contests/state';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { cleanupLoad, hasLoadData, reportLoad, seedLoad } from './load-test';

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
const ready = s3Up && (await postgresReachable());
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const [P1, P2] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .slice(0, 2) as [string, string];
const log = pino({ level: 'silent' });

describe('O-03: the load-test CLI refuses to run without the flag', () => {
  it('exits 1 and does nothing unless LOAD_TEST=on', () => {
    const cli = fileURLToPath(new URL('./load-cli.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli, 'cleanup'], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('LOAD_TEST=on');
  });
});

describe.skipIf(!ready)(
  'O-03: load-test seed, report and cleanup (needs Compose Postgres + S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let bystander: string;

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      const importer = new ProblemImporter(db, s3, config);
      for (const slug of [P1, P2]) {
        const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
        if (!r.ok) throw new Error(`${slug} rejected`);
        await importer.import(r.pkg, { visibility: 'public' });
      }
      bystander = randomUUID();
      await db
        .insert(users)
        .values({ id: bystander, email: 'real@example.test', handle: 'realone' });
    });
    afterAll(async () => {
      await drop?.();
    });

    const versionOf = async (slug: string) =>
      (
        await db
          .select({ id: problemVersions.id })
          .from(problemVersions)
          .innerJoin(problems, eq(problems.id, problemVersions.problemId))
          .where(eq(problems.slug, slug))
      )[0]!.id;

    it('seed makes tagged users in a running contest, each with a refresh token', async () => {
      expect(await hasLoadData(db)).toBe(false);
      const seed = await seedLoad(db, log, { count: 3, problems: [P1, P2], tag: 'abc' });
      expect(seed.users.map((u) => u.handle)).toEqual([
        'lt-abc-0001',
        'lt-abc-0002',
        'lt-abc-0003',
      ]);
      expect(seed.contest.problems).toEqual([
        { label: 'A', slug: P1 },
        { label: 'B', slug: P2 },
      ]);
      const [c] = await db.select().from(contests).where(eq(contests.slug, 'lt-abc'));
      expect(contestState(c!, new Date())).toBe('running');
      expect(
        await db.select().from(participants).where(eq(participants.contestId, c!.id)),
      ).toHaveLength(3);
      expect(await db.select().from(refreshTokens)).toHaveLength(4); // 3 users + the admin
      expect(await hasLoadData(db)).toBe(true);
    });

    it('seed fails clearly for a problem that is not imported', async () => {
      await expect(seedLoad(db, log, { count: 1, problems: ['nope'], tag: 'zzz' })).rejects.toThrow(
        'not imported',
      );
    });

    it('report computes queue wait, time to verdict, service time and drain from the rows', async () => {
      const [c] = await db.select().from(contests).where(eq(contests.slug, 'lt-abc'));
      const us = await db
        .select()
        .from(users)
        .where(sql`email like '%@loadtest.invalid' and role = 'user'`);
      const t0 = Date.now() - 600_000;
      const version = await versionOf(P1);
      // Three submissions at t0, t0+10s, t0+20s; each waits 5/10/15 s then runs 2 s (cpp17).
      for (const [i, u] of us.entries()) {
        const created = new Date(t0 + i * 10_000);
        const [s] = await db
          .insert(submissions)
          .values({
            userId: u.id,
            problemVersionId: version,
            contestId: c!.id,
            language: 'cpp17',
            source: 'x',
            sourceBytes: 1,
            lane: 'contest',
            status: 'done',
            verdict: 'AC',
            createdAt: created,
            judgedAt: new Date(created.getTime() + (5 + 5 * i + 2) * 1000),
          })
          .returning({ id: submissions.id });
        await db.insert(judgeRuns).values({
          submissionId: s!.id,
          runVersion: 1,
          workerId: i === 2 ? 'w2' : 'w1',
          journey: { steps: [{ phase: 'claimed', at: created.getTime() + (5 + 5 * i) * 1000 }] },
          finishedAt: new Date(created.getTime() + (5 + 5 * i + 2) * 1000),
          verdict: 'AC',
        });
      }
      const r = await reportLoad(db, 'lt-abc');
      expect(r.submissions).toBe(3);
      expect(r.judged).toBe(3);
      expect(r.byVerdict).toEqual({ AC: 3 });
      expect(r.byLanguage).toEqual({ cpp17: 3 });
      expect(r.queueWait.p50).toBeCloseTo(10, 3);
      expect(r.queueWait.max).toBeCloseTo(15, 3);
      expect(r.timeToVerdict.max).toBeCloseTo(17, 3);
      expect(r.serviceTime.cpp17!.mean).toBeCloseTo(2, 3);
      expect(r.submitWindowSeconds).toBeCloseTo(20, 3);
      expect(r.drainSeconds).toBeCloseTo(17, 3); // last verdict 17 s after the last submission
      expect(r.workers.map((w) => [w.id, w.runs])).toEqual([
        ['w1', 2],
        ['w2', 1],
      ]);
      expect(r.workers[0]!.firstStartSeconds).toBeCloseTo(5, 3);
    });

    it('cleanup removes only the load-test data', async () => {
      const [bv] = [await versionOf(P2)];
      await db.insert(submissions).values({
        userId: bystander,
        problemVersionId: bv,
        language: 'cpp17',
        source: 'x',
        sourceBytes: 1,
        lane: 'practice',
      });
      const cleaned = await cleanupLoad(db);
      expect(cleaned).toEqual({ users: 4, contests: 1, submissions: 3 });
      expect(await hasLoadData(db)).toBe(false);
      expect(await db.select().from(users).where(eq(users.id, bystander))).toHaveLength(1);
      expect(await db.select().from(submissions)).toHaveLength(1);
      expect(await db.select().from(refreshTokens)).toHaveLength(0);
      expect(await db.select().from(judgeRuns)).toHaveLength(0);
    });
  },
);
