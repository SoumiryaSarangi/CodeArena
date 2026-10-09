import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ContestRules } from '@codearena/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contestProblems,
  contests,
  judgeRuns,
  participants,
  plagClusters,
  plagRuns,
  problemVersions,
  problems,
  reviewDecisions,
  reviews,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { contestReport } from './contest-report';

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
const P1 = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory())!.name;
const MIN = 60_000;

describe.skipIf(!ready)('W-00: the contest report (needs Compose Postgres + S3)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let contestId: string;
  let problemId: string;
  let versionId: string;
  const people: string[] = [];

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    const r = parsePackage(P1, readPackageDirectory(`${root}${P1}`));
    if (!r.ok) throw new Error('package rejected');
    await new ProblemImporter(db, s3, config).import(r.pkg, { visibility: 'public' });
    const [p] = await db
      .select({ id: problems.id, v: problemVersions.id })
      .from(problems)
      .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
      .where(eq(problems.slug, P1));
    problemId = p!.id;
    versionId = p!.v;
    const admin = randomUUID();
    await db
      .insert(users)
      .values({ id: admin, email: 'a@example.test', handle: 'adm', role: 'admin' });
    const start = new Date(Date.now() - 200 * MIN);
    const [c] = await db
      .insert(contests)
      .values({
        slug: 'real-1',
        title: 'Real contest',
        startsAt: start,
        endsAt: new Date(start.getTime() + 120 * MIN),
        rules: ContestRules.parse({}),
        status: 'scheduled',
        createdBy: admin,
      })
      .returning({ id: contests.id });
    contestId = c!.id;
    await db
      .insert(contestProblems)
      .values({ contestId, label: 'A', problemId, versionId, position: 0 });
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      people.push(id);
      await db.insert(users).values({ id, email: `${id}@example.test`, handle: `p${i}` });
      await db.insert(participants).values({ contestId, userId: id });
    }
  });
  afterAll(async () => {
    await drop?.();
  });

  const submit = async (
    user: string,
    at: number,
    verdict: string | null,
    worker: string | null,
    ttvSec = 4,
  ) => {
    const created = new Date(at);
    const [s] = await db
      .insert(submissions)
      .values({
        userId: user,
        problemVersionId: versionId,
        contestId,
        language: 'cpp17',
        source: 'x',
        sourceBytes: 1,
        lane: 'contest',
        status: verdict ? 'done' : 'queued',
        verdict: verdict as 'AC' | 'WA' | null,
        createdAt: created,
        judgedAt: verdict ? new Date(at + ttvSec * 1000) : null,
      })
      .returning({ id: submissions.id });
    if (verdict && worker) {
      await db.insert(judgeRuns).values({
        submissionId: s!.id,
        runVersion: 1,
        workerId: worker,
        journey: { steps: [{ phase: 'claimed', at: at + 1000 }] },
        finishedAt: new Date(at + ttvSec * 1000),
        verdict: verdict as 'AC' | 'WA',
      });
    }
    return s!.id;
  };

  it('an empty contest reports zeros, not errors', async () => {
    const r = await contestReport(db, null, 'real-1');
    expect(r.participants).toEqual({ registered: 5, submitted: 0, solvedOne: 0 });
    expect(r.submissions).toMatchObject({
      total: 0,
      judged: 0,
      peakPerMinute: 0,
      peakMinuteAt: null,
    });
    expect(r.workers).toEqual([]);
    expect(r.plagiarism).toEqual({ runs: 0, latest: null });
    expect(r.reviews).toMatchObject({ total: 0, tokens: 0 });
    expect(r.deadLetters).toEqual({ jobs: null, results: null }); // no Redis given
  });

  it('counts people, the busiest minute, verdicts, workers, plagiarism clusters by decision and the AI reviews', async () => {
    const t0 = new Date(Date.now() - 150 * MIN).setSeconds(10, 0); // inside one minute
    // p0 solves; p1 gets a WA then an AC; p2 only WA; p3 submits but is not judged yet; p4 never submits
    const s0 = await submit(people[0]!, t0, 'AC', 'w1', 2);
    await submit(people[1]!, t0 + 5_000, 'WA', 'w1', 6);
    await submit(people[1]!, t0 + 60 * 1000 + 5_000, 'AC', 'w2', 4);
    await submit(people[2]!, t0 + 10_000, 'WA', 'w2', 10);
    await submit(people[3]!, t0 + 20_000, null, null);

    const [run] = await db
      .insert(plagRuns)
      .values({ contestId, status: 'done', params: {}, metrics: {} })
      .returning({ id: plagRuns.id });
    const cl = [];
    for (const score of [0.9, 0.8, 0.7]) {
      const [x] = await db
        .insert(plagClusters)
        .values({ runId: run!.id, problemId, submissionIds: [s0, randomUUID()], maxScore: score })
        .returning({ id: plagClusters.id });
      cl.push(x!.id);
    }
    const decide = (
      clusterId: string,
      decision: 'confirmed' | 'needs_more' | 'dismissed',
      note: string,
    ) => db.insert(reviewDecisions).values({ clusterId, decision, note, reviewerId: people[4]! });
    await decide(cl[0]!, 'confirmed', 'same names');
    await decide(cl[1]!, 'needs_more', 'ask');
    await new Promise((r) => setTimeout(r, 20));
    await decide(cl[1]!, 'dismissed', 'checked, fine'); // a later decision wins
    await db.insert(reviews).values([
      {
        userId: people[0]!,
        contestId,
        problemId,
        submissionId: s0,
        status: 'ready',
        model: 'gpt-oss-120b',
        tokens: 900,
        helpful: true,
      },
    ]);

    const r = await contestReport(db, null, 'real-1');
    expect(r.participants).toEqual({ registered: 5, submitted: 4, solvedOne: 2 });
    expect(r.submissions.total).toBe(5);
    expect(r.submissions.judged).toBe(4);
    expect(r.submissions.byVerdict).toEqual({ AC: 2, WA: 2 });
    expect(r.submissions.byLanguage).toEqual({ cpp17: 5 });
    expect(r.submissions.peakPerMinute).toBe(4); // the first minute: three judged and one waiting
    expect(r.submissions.peakMinuteAt).toBe(new Date(Math.floor(t0 / MIN) * MIN).toISOString());
    expect(r.submissions.meanPerMinute).toBeCloseTo(5 / 120, 2);
    expect(r.timeToVerdict.n).toBe(4);
    expect(r.timeToVerdict.max).toBeCloseTo(10, 3);
    expect(r.timeToVerdict.p50).toBeCloseTo(5, 3); // 2, 4, 6, 10
    expect(r.workers).toEqual([
      { id: 'w1', runs: 2 },
      { id: 'w2', runs: 2 },
    ]);
    expect(r.integrity.ok).toBe(false); // one submission is still queued: the report says so
    expect(r.integrity.problems.join(' ')).toMatch(/no final verdict/);
    expect(r.plagiarism).toEqual({
      runs: 1,
      latest: { status: 'done', clusters: 3, open: 1, cleared: 1, confirmed: 1, discuss: 0 },
    });
    expect(r.reviews).toEqual({
      total: 1,
      byStatus: { ready: 1 },
      tokens: 900,
      models: { 'gpt-oss-120b': 1 },
      helpful: { yes: 1, no: 0 },
    });
  });

  it('an unknown contest is an error', async () => {
    await expect(contestReport(db, null, 'nope')).rejects.toThrow('no contest');
  });
});
