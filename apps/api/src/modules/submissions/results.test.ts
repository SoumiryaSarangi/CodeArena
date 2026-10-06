import { randomBytes, randomUUID } from 'node:crypto';
import type { JudgeResult } from '@codearena/contracts';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  customRuns,
  judgeRuns,
  problems,
  problemVersions,
  submissions,
  testResults,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { MAX_COMPILE_LOG_BYTES, ResultsProcessor, type RealtimeMessage } from './results.processor';
import { RESULTS_GROUP, ResultsConsumer, type ConsumerOptions } from './results.consumer';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const log = pino({ level: 'silent' });

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
const ready = redisUp && (await postgresReachable());

const fixture = (name: string): JudgeResult =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../../packages/contracts/fixtures/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.skipIf(!ready)('Q-03: verdict consumer (needs the Compose Postgres and Redis)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let redis: Redis;
  let sub: Redis;
  let userId: string;
  let versionId: string;
  const prefix = `t_${randomBytes(4).toString('hex')}:`;
  let processor: ResultsProcessor;

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    redis = new Redis(config.REDIS_URL);
    sub = new Redis(config.REDIS_URL);
    processor = new ResultsProcessor(db, redis, prefix, log);
    const [u] = await db
      .insert(users)
      .values({ email: `q03-${randomBytes(3).toString('hex')}@example.com` })
      .returning();
    userId = u!.id;
    const [p] = await db
      .insert(problems)
      .values({ slug: `q03-${randomBytes(3).toString('hex')}`, title: 'Q03', difficulty: 800 })
      .returning();
    const [v] = await db
      .insert(problemVersions)
      .values({
        problemId: p!.id,
        version: 1,
        statementMd: 's',
        limits: { timeMs: 1000, memMb: 256, outputKb: 64 },
        checker: { kind: 'tokens' },
      })
      .returning();
    versionId = v!.id;
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    sub.disconnect();
    await drop();
  });

  const seed = async (over: Partial<typeof submissions.$inferInsert> = {}) => {
    const [s] = await db
      .insert(submissions)
      .values({
        userId,
        problemVersionId: versionId,
        language: 'cpp17',
        source: 'x',
        sourceBytes: 1,
        lane: 'practice',
        ...over,
      })
      .returning();
    return s!.id;
  };
  const result = (submissionId: string, over: Partial<JudgeResult> = {}): JudgeResult => ({
    submissionId,
    runVersion: 1,
    verdict: 'AC',
    timeMs: 12,
    memKb: 1024,
    tests: [{ no: 1, verdict: 'AC', timeMs: 12, memKb: 1024 }],
    workerId: 'w1',
    finishedAt: 1_790_000_001_000,
    ...over,
  });
  const raw = (r: JudgeResult) => JSON.stringify(r);
  const evtLen = (id: string) => redis.xlen(`${prefix}evt:sub:${id}`);

  /** Everything the processor may write about one submission, as comparable JSON. */
  const snapshot = async (id: string) => {
    const [s] = await db.select().from(submissions).where(eq(submissions.id, id));
    const runs = await db.select().from(judgeRuns).where(eq(judgeRuns.submissionId, id));
    const tests = runs.length
      ? await db.select().from(testResults).where(eq(testResults.judgeRunId, runs[0]!.id))
      : [];
    return JSON.parse(JSON.stringify({ s, runs, tests }));
  };

  describe('FR-QUEUE-06: idempotent on (submission id, run version)', () => {
    it('stores the first result completely and tells the user once', async () => {
      const id = await seed();
      const messages: RealtimeMessage[] = [];
      await sub.subscribe(`${prefix}rt:sub:${id}`);
      sub.on('message', (_ch, m) => messages.push(JSON.parse(m)));

      const out = await processor.handle(
        raw(
          result(id, {
            verdict: 'WA',
            tests: [
              { no: 1, verdict: 'AC', timeMs: 5, memKb: 100 },
              { no: 2, verdict: 'WA', timeMs: 7, memKb: 120, checkerMsg: 'token 1 differs' },
              { no: 3, verdict: 'AC', timeMs: 6, memKb: 110 },
            ],
          }),
        ),
      );
      expect(out.kind).toBe('applied');
      const snap = await snapshot(id);
      expect(snap.s).toMatchObject({
        status: 'done',
        verdict: 'WA',
        timeMs: 12,
        memKb: 1024,
        failedTest: 2,
      });
      expect(snap.s.judgedAt).toBeTruthy();
      expect(snap.runs).toHaveLength(1);
      expect(snap.runs[0]).toMatchObject({
        runVersion: 1,
        reason: 'initial',
        workerId: 'w1',
        verdict: 'WA',
      });
      expect(
        snap.tests.map((t: { testNo: number; verdict: string; checkerMsg: string | null }) => [
          t.testNo,
          t.verdict,
          t.checkerMsg,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [1, 'AC', null],
          [2, 'WA', 'token 1 differs'],
          [3, 'AC', null],
        ]),
      );

      await until('the realtime message', () => messages.length === 1);
      expect(messages[0]!.envelope).toMatchObject({
        topic: `sub:${id}`,
        type: 'submission.verdict',
        data: { submissionId: id, runVersion: 1, status: 'done', verdict: 'WA', failedTest: 2 },
      });
      const stream = await redis.xrange(`${prefix}evt:sub:${id}`, '-', '+');
      expect(stream).toHaveLength(1);
      expect(stream[0]![0]).toBe(messages[0]!.id); // the SSE id is the replay-stream id
      expect(await redis.ttl(`${prefix}evt:sub:${id}`)).toBeGreaterThan(0);
    });

    it('replaying the same result 3 times changes nothing (J-Q-03 acceptance)', async () => {
      const id = await seed();
      const r = raw(
        result(id, {
          tests: [
            { no: 1, verdict: 'AC', timeMs: 3, memKb: 90 },
            { no: 2, verdict: 'AC', timeMs: 4, memKb: 95 },
          ],
        }),
      );
      const messages: string[] = [];
      await sub.subscribe(`${prefix}rt:sub:${id}`);
      sub.on('message', (ch, m) => ch.endsWith(id) && messages.push(m));

      expect((await processor.handle(r)).kind).toBe('applied');
      const after1 = await snapshot(id);
      expect((await processor.handle(r)).kind).toBe('duplicate');
      expect((await processor.handle(r)).kind).toBe('duplicate');
      expect((await processor.handle(r)).kind).toBe('duplicate');
      expect(await snapshot(id)).toEqual(after1);
      expect(after1.runs).toHaveLength(1);
      expect(after1.tests).toHaveLength(2);
      expect(await evtLen(id)).toBe(1);
      await sleep(150);
      expect(messages).toHaveLength(1);
    });

    it('a replay with different content for the same run version still changes nothing', async () => {
      const id = await seed();
      await processor.handle(raw(result(id, { verdict: 'AC' })));
      const before = await snapshot(id);
      expect((await processor.handle(raw(result(id, { verdict: 'WA', timeMs: 999 })))).kind).toBe(
        'duplicate',
      );
      expect(await snapshot(id)).toEqual(before);
    });

    it('10 API instances handling the same result at once store it exactly once', async () => {
      const id = await seed();
      const r = raw(result(id));
      const outs = await Promise.all(Array.from({ length: 10 }, () => processor.handle(r)));
      expect(outs.filter((o) => o.kind === 'applied')).toHaveLength(1);
      expect(outs.filter((o) => o.kind === 'duplicate')).toHaveLength(9);
      expect((await snapshot(id)).runs).toHaveLength(1);
      expect(await evtLen(id)).toBe(1);
    });
  });

  describe('run versions (rejudge)', () => {
    it('a result for an older version is kept as history and never overwrites the newer summary', async () => {
      const id = await seed({ currentRunVersion: 2 });
      expect((await processor.handle(raw(result(id, { runVersion: 2, verdict: 'AC' })))).kind).toBe(
        'applied',
      );
      expect(
        (await processor.handle(raw(result(id, { runVersion: 1, verdict: 'WA', timeMs: 500 }))))
          .kind,
      ).toBe('stale');
      const runs = await db.select().from(judgeRuns).where(eq(judgeRuns.submissionId, id));
      expect(runs.map((r) => [r.runVersion, r.reason, r.verdict]).sort()).toEqual([
        [1, 'initial', 'WA'],
        [2, 'rejudge', 'AC'],
      ]);
      const [s] = await db.select().from(submissions).where(eq(submissions.id, id));
      expect(s).toMatchObject({ verdict: 'AC', timeMs: 12 });
      expect(await evtLen(id)).toBe(1); // only the current version notified the user
    });

    it('the older version arriving first does not block the newer one', async () => {
      const id = await seed({ currentRunVersion: 2 });
      expect((await processor.handle(raw(result(id, { runVersion: 1, verdict: 'WA' })))).kind).toBe(
        'stale',
      );
      expect((await processor.handle(raw(result(id, { runVersion: 2, verdict: 'AC' })))).kind).toBe(
        'applied',
      );
      const [s] = await db.select().from(submissions).where(eq(submissions.id, id));
      expect(s!.verdict).toBe('AC');
    });

    it('SD-§16.1: a version the submission never started is parked, not stored', async () => {
      const id = await seed({ currentRunVersion: 2 });
      const out = await processor.handle(raw(result(id, { runVersion: 3 })));
      expect(out).toMatchObject({ kind: 'parked', reason: 'unknown-run-version' });
      expect((await snapshot(id)).runs).toHaveLength(0);
      expect((await snapshot(id)).s.verdict).toBeNull();
    });
  });

  describe('verdict mapping', () => {
    it('CE: the compile log is cut to 16 KB, no failed test, status done', async () => {
      const id = await seed();
      await processor.handle(
        raw(result(id, { verdict: 'CE', tests: [], compileLog: 'é'.repeat(20_000) })),
      );
      const snap = await snapshot(id);
      expect(Buffer.byteLength(snap.runs[0].compileLog)).toBeLessThanOrEqual(MAX_COMPILE_LOG_BYTES);
      expect(snap.runs[0].compileLog.length).toBeGreaterThan(1000);
      expect(snap.s).toMatchObject({ status: 'done', verdict: 'CE', failedTest: null });
    });

    it('SE: the submission is failed, as in the state machine', async () => {
      const id = await seed();
      await processor.handle(raw(result(id, { verdict: 'SE', tests: [] })));
      expect((await snapshot(id)).s).toMatchObject({ status: 'failed', verdict: 'SE' });
    });

    it('the shared judge-result fixture from the contracts package is processed', async () => {
      const fx = fixture('judge-result');
      const id = await seed({ id: fx.submissionId });
      expect((await processor.handle(raw(fx))).kind).toBe('applied');
      const snap = await snapshot(id);
      expect(snap.s).toMatchObject({ verdict: 'WA', failedTest: 2, status: 'done' });
      expect(snap.tests).toHaveLength(2);
    });
  });

  describe('nothing untrustworthy gets in', () => {
    it.each([
      ['not json', 'this is not json', 'invalid-json'],
      [
        'an unknown field',
        JSON.stringify({ ...result(randomUUID()), admin: true }),
        'invalid-result',
      ],
      [
        'a missing field',
        JSON.stringify({ submissionId: randomUUID(), runVersion: 1 }),
        'invalid-result',
      ],
      [
        'a verdict that is not one of the eight',
        JSON.stringify({ ...result(randomUUID()), verdict: 'PASS' }),
        'invalid-result',
      ],
      [
        'a submission that does not exist',
        JSON.stringify(result(randomUUID())),
        'unknown-submission',
      ],
      ['an id that is not a UUID', JSON.stringify(result('sub-1')), 'unknown-submission'],
    ])('%s is parked', async (_name, body, reason) => {
      const out = await processor.handle(body);
      expect(out).toMatchObject({ kind: 'parked', reason });
    });
  });

  describe('custom runs (FR-SUB-05)', () => {
    it('a custom-run result completes the run once, with its output, and replays change nothing', async () => {
      const [run] = await db
        .insert(customRuns)
        .values({ userId, language: 'c', source: 'x', input: '1 2' })
        .returning();
      const r = raw(result(run!.id, { output: '3\n', stderr: '' }));
      expect((await processor.handle(r)).kind).toBe('applied');
      expect((await processor.handle(r)).kind).toBe('duplicate');
      const [after] = await db.select().from(customRuns).where(eq(customRuns.id, run!.id));
      expect(after).toMatchObject({
        status: 'done',
        result: { verdict: 'AC', output: '3\n', stderr: '' },
      });
      expect(await evtLen(run!.id)).toBe(1);
    });
  });

  describe('the consumer loop', () => {
    const fast: Partial<ConsumerOptions> = {
      blockMs: 100,
      reclaimEveryMs: 100,
      reclaimIdleMs: 300,
      trimEveryMs: 3_600_000,
      retryBackoffMs: [10, 10],
    };
    let consumer: ResultsConsumer | undefined;
    let streamPrefix: string;
    const make = (
      proc: Pick<ResultsProcessor, 'handle'> = processor,
      over: Partial<ConsumerOptions> = {},
    ) =>
      new ResultsConsumer(redis, streamPrefix, proc as ResultsProcessor, log, config, {
        ...fast,
        ...over,
      });
    // Before the consumer has created its group there is nothing pending to count.
    const pendingCount = async () => {
      try {
        return ((await redis.xpending(`${streamPrefix}results`, RESULTS_GROUP)) as [number])[0];
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    };
    const post = (body: string) => redis.xadd(`${streamPrefix}results`, '*', 'result', body);

    beforeEach(() => {
      streamPrefix = `${prefix}${randomBytes(3).toString('hex')}:`; // a fresh results stream per test
    });
    afterAll(async () => {
      await consumer?.stop();
    });

    // The processor publishes under `prefix`, the streams under `streamPrefix`: only the stream names matter here.
    const run = async (body: (c: ResultsConsumer) => Promise<void>, c = make()) => {
      consumer = c;
      c.start();
      try {
        await body(c);
      } finally {
        await c.stop();
      }
    };

    it('FR-QUEUE-01/06: a result the worker XADDs reaches Postgres, is acknowledged, and is judged once', async () => {
      const id = await seed();
      await run(async () => {
        await post(raw(result(id)));
        await until('the verdict in Postgres', async () => (await snapshot(id)).s.verdict === 'AC');
        await until('the ack', async () => (await pendingCount()) === 0);
      });
      expect((await snapshot(id)).runs).toHaveLength(1);
    });

    it('the same result posted twice (an at-least-once redelivery) still ends with one run', async () => {
      const id = await seed();
      await run(async () => {
        await post(raw(result(id)));
        await post(raw(result(id)));
        await until(
          'both acknowledged',
          async () =>
            (await redis.xlen(`${streamPrefix}results`)) === 2 && (await pendingCount()) === 0,
        );
      });
      expect((await snapshot(id)).runs).toHaveLength(1);
      expect(await evtLen(id)).toBe(1);
    });

    it('FR-QUEUE-06: a result held by an API instance that died is taken over and stored once', async () => {
      const id = await seed();
      await redis.xgroup('CREATE', `${streamPrefix}results`, RESULTS_GROUP, '0', 'MKSTREAM');
      await post(raw(result(id)));
      await redis.xreadgroup(
        'GROUP',
        RESULTS_GROUP,
        'ghost-api',
        'COUNT',
        1,
        'STREAMS',
        `${streamPrefix}results`,
        '>',
      ); // read, never acked
      await run(async () => {
        await until('the takeover', async () => (await snapshot(id)).s.verdict === 'AC');
        await until('the ack', async () => (await pendingCount()) === 0);
      });
      expect((await snapshot(id)).runs).toHaveLength(1);
    });

    it('a transient failure (Postgres hiccup) is retried and ends with one run', async () => {
      const id = await seed();
      const flaky = {
        handle: vi
          .fn()
          .mockRejectedValueOnce(new Error('connection reset'))
          .mockImplementation((b: string) => processor.handle(b)),
      };
      await run(async () => {
        await post(raw(result(id)));
        await until('the verdict', async () => (await snapshot(id)).s.verdict === 'AC');
        await until('the ack', async () => (await pendingCount()) === 0);
      }, make(flaky));
      expect(flaky.handle.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect((await snapshot(id)).runs).toHaveLength(1);
    });

    it('an unusable result is parked in results:dlq and acknowledged, not retried forever', async () => {
      await run(async () => {
        await post('garbage');
        await until(
          'the dead letter',
          async () => (await redis.xlen(`${streamPrefix}results:dlq`)) === 1,
        );
        await until('the ack', async () => (await pendingCount()) === 0);
      });
      const e = (await redis.xrange(`${streamPrefix}results:dlq`, '-', '+'))[0]![1];
      expect(e).toEqual(expect.arrayContaining(['reason', 'invalid-json', 'result', 'garbage']));
    });

    it('a result that keeps failing is parked after too many deliveries', async () => {
      const id = await seed();
      const broken = { handle: vi.fn().mockRejectedValue(new Error('db down')) };
      await run(
        async () => {
          await post(raw(result(id)));
          await until(
            'the dead letter',
            async () => (await redis.xlen(`${streamPrefix}results:dlq`)) === 1,
            15_000,
          );
        },
        make(broken, { maxDeliveries: 2 }),
      );
      const e = (await redis.xrange(`${streamPrefix}results:dlq`, '-', '+'))[0]![1];
      expect(e).toEqual(expect.arrayContaining(['reason', 'too-many-deliveries']));
      expect((await snapshot(id)).runs).toHaveLength(0);
    });

    it('trimming drops old acknowledged results but never an unacknowledged one or an undelivered one', async () => {
      const key = `${streamPrefix}results`;
      const now = Date.now();
      const old1 = `${now - 3 * 3_600_000}-0`;
      const old2 = `${now - 2 * 3_600_000}-0`;
      await redis.xgroup('CREATE', key, RESULTS_GROUP, '0', 'MKSTREAM');
      await redis.xadd(key, old1, 'result', 'a');
      await redis.xadd(key, old2, 'result', 'b');
      await redis.xadd(key, `${now - 1000}-0`, 'result', 'recent');
      const got = (await redis.xreadgroup(
        'GROUP',
        RESULTS_GROUP,
        'ghost',
        'COUNT',
        10,
        'STREAMS',
        key,
        '>',
      )) as [string, [string, string[]][]][];
      expect(got[0]![1]).toHaveLength(3);
      await redis.xack(key, RESULTS_GROUP, old1);
      await redis.xack(key, RESULTS_GROUP, `${now - 1000}-0`);
      await redis.xadd(key, `${now - 500}-0`, 'result', 'undelivered');
      const c = make();
      await c.trim(now);
      const left = (await redis.xrange(key, '-', '+')).map(([id]) => id);
      expect(left).toEqual([old2, `${now - 1000}-0`, `${now - 500}-0`]); // old1 gone; b still pending; the rest are recent
    });

    it('trimming with nothing pending drops everything older than an hour', async () => {
      const key = `${streamPrefix}results`;
      const now = Date.now();
      await redis.xgroup('CREATE', key, RESULTS_GROUP, '0', 'MKSTREAM');
      await redis.xadd(key, `${now - 2 * 3_600_000}-0`, 'result', 'old');
      await redis.xadd(key, `${now - 10}-0`, 'result', 'recent');
      const got = (await redis.xreadgroup(
        'GROUP',
        RESULTS_GROUP,
        'ghost',
        'COUNT',
        10,
        'STREAMS',
        key,
        '>',
      )) as [string, [string, string[]][]][];
      for (const [id] of got[0]![1]) await redis.xack(key, RESULTS_GROUP, id);
      await make().trim(now);
      expect(await redis.xlen(key)).toBe(1);
    });
  });
});
