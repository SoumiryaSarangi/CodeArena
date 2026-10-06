import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JudgeJob, type JudgeResult } from '@codearena/contracts';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  customRuns,
  judgeRuns,
  problems,
  problemVersions,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { buildJob } from './job-builder';
import { QueuePositionService } from './queue-position.service';
import { QueueService } from './queue.service';
import { MAX_ATTEMPTS, Reconciler } from './reconciler';
import { ResultsProcessor } from './results.processor';

const probe = new Redis(loadConfig({ NODE_ENV: 'test' }).REDIS_URL, {
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
const ready = redisUp && (await postgresReachable());

const STUCK_MS = 300;
const prefix = `t${randomBytes(4).toString('hex')}:`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!ready)('Q-03b: reconciler (needs the Compose Postgres and Redis)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let redis: Redis;
  let rec: Reconciler;
  let queue: QueueService;
  let positions: QueuePositionService;
  let processor: ResultsProcessor;
  let userId: string;
  let version: typeof problemVersions.$inferSelect;

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    redis = new Redis(loadConfig({ NODE_ENV: 'test' }).REDIS_URL);
    app = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: t.url,
        QUEUE_KEY_PREFIX: prefix,
        RECONCILER_STUCK_MS: String(STUCK_MS),
      }),
    );
    await app.init();
    rec = app.get(Reconciler);
    queue = app.get(QueueService);
    positions = app.get(QueuePositionService);
    processor = app.get(ResultsProcessor);
    const [u] = await db
      .insert(users)
      .values({ email: `q03b-${randomBytes(3).toString('hex')}@example.test` })
      .returning();
    userId = u!.id;
    const [p] = await db
      .insert(problems)
      .values({ slug: `q03b-${randomBytes(3).toString('hex')}`, title: 'Q03b', difficulty: 800 })
      .returning();
    const [v] = await db
      .insert(problemVersions)
      .values({
        problemId: p!.id,
        version: 1,
        statementMd: 's',
        limits: { timeMs: 1000, memMb: 256, outputKb: 64 },
        checker: { kind: 'tokens' },
        testsetHash: 'a'.repeat(64),
        testsetUri: `s3://codearena/testsets/${'a'.repeat(64)}.tar`,
        testsCount: 1,
      })
      .returning();
    version = v!;
  });

  afterAll(async () => {
    const keys = await redis?.keys(`${prefix}*`);
    if (keys?.length) await redis.del(...keys);
    redis?.disconnect();
    await app?.close();
    await drop?.();
  });

  const old = () => new Date(Date.now() - STUCK_MS - 100);
  const jobsOf = async (id: string) =>
    (await redis.xrange(`${prefix}jobs:practice`, '-', '+'))
      .map(([entry, f]) => ({ entry, job: JudgeJob.parse(JSON.parse(f[1]!)) }))
      .filter((j) => j.job.submissionId === id);

  /** What POST /submissions does: save, queue, remember. `age` backdates it past the stuck threshold. */
  const submit = async (opts: { aged?: boolean; queued?: boolean } = {}) => {
    const [s] = await db
      .insert(submissions)
      .values({
        userId,
        problemVersionId: version.id,
        language: 'cpp17',
        source: `int main(){} // ${randomUUID()}`,
        sourceBytes: 20,
        lane: 'practice',
        ...(opts.aged === false ? {} : { createdAt: old() }),
      })
      .returning();
    if (opts.queued !== false) {
      const q = await queue.enqueue(
        buildJob(
          { id: s!.id, language: 'cpp17', source: s!.source, lane: 'practice' },
          version,
          'submit',
        ),
      );
      await positions.remember(s!.id, 'practice', q.entryId);
    }
    return s!;
  };
  /** The job vanishes: the failure the reconciler exists for. */
  const loseJob = async (id: string) => {
    for (const j of await jobsOf(id)) await redis.xdel(`${prefix}jobs:practice`, j.entry);
  };
  const row = async (id: string) =>
    (await db.select().from(submissions).where(eq(submissions.id, id)))[0]!;
  const result = (id: string, verdict: JudgeResult['verdict'] = 'AC'): string =>
    JSON.stringify({
      submissionId: id,
      runVersion: 1,
      verdict,
      timeMs: 5,
      memKb: 1000,
      tests: [],
      workerId: 'w',
      finishedAt: Date.now(),
    });
  const clearCooldown = async (id: string) => redis.del(`${prefix}recon:cool:${id}`);

  it('FR-QUEUE-09: a lost job is queued again, identical to the first, and judged exactly once', async () => {
    const s = await submit();
    const [first] = await jobsOf(s.id);
    await loseJob(s.id);
    expect(await jobsOf(s.id)).toHaveLength(0);

    const report = await rec.sweep();
    expect(report.requeued).toContain(s.id);
    const again = await jobsOf(s.id);
    expect(again).toHaveLength(1);
    const a = again[0]!.job;
    const f = first!.job;
    // same job but for the stamped fields (a fresh jobId/seq/enqueuedAt/traceparent)
    expect({ ...a, jobId: '', seq: 0, enqueuedAt: 0, traceparent: '' }).toEqual({
      ...f,
      jobId: '',
      seq: 0,
      enqueuedAt: 0,
      traceparent: '',
    });
    expect(a.runVersion).toBe(1);
    // position works again: the new entry is remembered
    expect((await positions.peek(s.id))?.position).toBeGreaterThanOrEqual(1);

    expect(await processor.handle(result(s.id))).toMatchObject({ kind: 'applied' });
    expect((await row(s.id)).status).toBe('done');
    expect(await db.select().from(judgeRuns).where(eq(judgeRuns.submissionId, s.id))).toHaveLength(
      1,
    );
  });

  it('FR-QUEUE-09: if both copies are judged anyway, only one verdict is stored', async () => {
    const s = await submit();
    await loseJob(s.id);
    await rec.sweep();
    expect(await processor.handle(result(s.id))).toMatchObject({ kind: 'applied' });
    expect(await processor.handle(result(s.id))).toMatchObject({ kind: 'duplicate' });
    expect(await db.select().from(judgeRuns).where(eq(judgeRuns.submissionId, s.id))).toHaveLength(
      1,
    );
  });

  it('a job still waiting in the queue is left alone', async () => {
    const s = await submit();
    const report = await rec.sweep();
    expect(report.requeued).not.toContain(s.id);
    expect(report.live).toBeGreaterThanOrEqual(1);
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it('a job a judge has claimed but not finished is left alone (Q-02 owns that case)', async () => {
    const jobs = `${prefix}jobs:practice`;
    await redis.xgroup('CREATE', jobs, 'judges', '0', 'MKSTREAM').catch(() => {});
    const s = await submit();
    await redis.xreadgroup('GROUP', 'judges', 'wx', 'COUNT', 1000, 'STREAMS', jobs, '>');
    await db.update(submissions).set({ status: 'judging' }).where(eq(submissions.id, s.id));
    const report = await rec.sweep();
    expect(report.requeued).not.toContain(s.id);
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it('a submission younger than the threshold, or already judged, is never touched', async () => {
    const fresh = await submit({ aged: false });
    await loseJob(fresh.id);
    const done = await submit();
    await loseJob(done.id);
    await processor.handle(result(done.id));
    const report = await rec.sweep();
    expect(report.requeued).not.toContain(fresh.id);
    expect(report.requeued).not.toContain(done.id);
    expect(await jobsOf(fresh.id)).toHaveLength(0);
    expect(await jobsOf(done.id)).toHaveLength(0);
  });

  it('a Redis that lost everything is repaired: no remembered entry, no job, still re-queued', async () => {
    const s = await submit();
    await loseJob(s.id);
    await redis.del(`${prefix}sub:entry:${s.id}`);
    expect((await rec.sweep()).requeued).toContain(s.id);
    expect(await jobsOf(s.id)).toHaveLength(1);
  });

  it('attempts are spaced out: a second sweep right away does nothing, a later one tries again', async () => {
    const s = await submit();
    await loseJob(s.id);
    expect((await rec.sweep()).requeued).toContain(s.id);
    await loseJob(s.id);
    const soon = await rec.sweep();
    expect(soon.requeued).not.toContain(s.id);
    expect(soon.cooldown).toBeGreaterThanOrEqual(1);
    expect(await jobsOf(s.id)).toHaveLength(0);
    await sleep(STUCK_MS + 50);
    expect((await rec.sweep()).requeued).toContain(s.id);
  });

  it('after the maximum attempts the submission fails as SE, the user is told, nothing loops', async () => {
    const s = await submit();
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await loseJob(s.id);
      await clearCooldown(s.id);
      expect((await rec.sweep()).requeued, `attempt ${i}`).toContain(s.id);
    }
    await loseJob(s.id);
    await clearCooldown(s.id);
    const last = await rec.sweep();
    expect(last.requeued).not.toContain(s.id);
    expect(last.failed).toContain(s.id);
    const r = await row(s.id);
    expect(r).toMatchObject({ status: 'failed', verdict: 'SE' });
    expect(r.judgedAt).not.toBeNull();
    expect(await jobsOf(s.id)).toHaveLength(0);
    const evts = await redis.xrange(`${prefix}evt:sub:${s.id}`, '-', '+');
    expect(evts).toHaveLength(1);
    expect(JSON.parse(evts[0]![1][1]!).data).toMatchObject({ verdict: 'SE', status: 'failed' });
    // and it stays quiet afterwards
    await clearCooldown(s.id);
    expect((await rec.sweep()).failed).not.toContain(s.id);
  });

  it('a job the judges gave up on (dead letter) fails the submission instead of being retried', async () => {
    const s = await submit();
    const [only] = await jobsOf(s.id);
    await loseJob(s.id);
    await redis.xadd(
      `${prefix}jobs:dlq`,
      '*',
      'job',
      JSON.stringify(only!.job),
      'reason',
      'execution-failed',
    );
    const report = await rec.sweep();
    expect(report.failed).toContain(s.id);
    expect(report.requeued).not.toContain(s.id);
    expect(await row(s.id)).toMatchObject({ status: 'failed', verdict: 'SE' });
    expect(await jobsOf(s.id)).toHaveLength(0);
  });

  it('a verdict that lands just before the re-queue wins: nothing is queued for a judged submission', async () => {
    const s = await submit();
    await loseJob(s.id);
    rec.beforeRequeue = async (id) => {
      await processor.handle(result(id));
    };
    try {
      const report = await rec.sweep();
      expect(report.requeued).not.toContain(s.id);
    } finally {
      rec.beforeRequeue = undefined;
    }
    expect((await row(s.id)).status).toBe('done');
    expect(await jobsOf(s.id)).toHaveLength(0);
    expect(await db.select().from(judgeRuns).where(eq(judgeRuns.submissionId, s.id))).toHaveLength(
      1,
    );
  });

  it('the re-queued job carries the submission’s current run version and lane', async () => {
    const [s] = await db
      .insert(submissions)
      .values({
        userId,
        problemVersionId: version.id,
        language: 'python3',
        source: 'print(1)',
        sourceBytes: 8,
        lane: 'rejudge',
        currentRunVersion: 3,
        createdAt: old(),
      })
      .returning();
    expect((await rec.sweep()).requeued).toContain(s!.id);
    const [entry] = (await redis.xrange(`${prefix}jobs:rejudge`, '-', '+')).filter(([, f]) =>
      f[1]!.includes(s!.id),
    );
    const job = JudgeJob.parse(JSON.parse(entry![1][1]!));
    expect(job).toMatchObject({
      runVersion: 3,
      lane: 'rejudge',
      language: 'python3',
      mode: 'submit',
    });
  });

  it('only one instance sweeps at a time', async () => {
    const s = await submit();
    await loseJob(s.id);
    const [a, b, c] = await Promise.all([rec.sweepLocked(), rec.sweepLocked(), rec.sweepLocked()]);
    expect([a, b, c].filter((r) => r !== null)).toHaveLength(1);
    expect(await jobsOf(s.id)).toHaveLength(1);
    // the lease is released, so the next tick can sweep
    expect(await rec.sweepLocked()).not.toBeNull();
  });

  it('a custom run stuck for too long is failed so the user can run it again', async () => {
    const [stale] = await db
      .insert(customRuns)
      .values({
        userId,
        language: 'cpp17',
        source: 'x',
        input: '1',
        createdAt: new Date(Date.now() - 11 * 60_000),
      })
      .returning();
    const [fresh] = await db
      .insert(customRuns)
      .values({ userId, language: 'cpp17', source: 'x', input: '1' })
      .returning();
    const report = await rec.sweep();
    expect(report.runsFailed).toBeGreaterThanOrEqual(1);
    expect(
      (await db.select().from(customRuns).where(eq(customRuns.id, stale!.id)))[0]!.status,
    ).toBe('failed');
    expect(
      (await db.select().from(customRuns).where(eq(customRuns.id, fresh!.id)))[0]!.status,
    ).toBe('queued');
  });
});
