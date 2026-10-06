import { randomBytes } from 'node:crypto';
import type { JudgeResult } from '@codearena/contracts';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config';
import type { Db } from '../db/client';
import { problems, problemVersions, submissions, users } from '../db/schema';
import { RESULTS_GROUP, ResultsConsumer } from '../modules/submissions/results.consumer';
import { ResultsProcessor } from '../modules/submissions/results.processor';
import { QueueService } from '../modules/submissions/queue.service';
import { type AclRedis, dockerAvailable, startAclRedis } from '../test/acl-redis';
import { createTestDatabase, postgresReachable } from '../test/db';

const ready = dockerAvailable() && (await postgresReachable());
const log = pino({ level: 'silent' });
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const denied = async (p: Promise<unknown>) => {
  try {
    await p;
    return false;
  } catch (e) {
    return /NOPERM|no permissions/i.test(String((e as Error).message));
  }
};

describe.skipIf(!ready)(
  'Q-04: the api Redis user (a throwaway Redis from infra/redis/users.acl.tmpl)',
  () => {
    let acl: AclRedis;
    let admin: Redis;
    let api: Redis;
    let judge: Redis;
    let db: Db;
    let drop: () => Promise<void>;
    let userId: string;
    let versionId: string;

    beforeAll(async () => {
      acl = await startAclRedis();
      admin = acl.as('admin');
      api = acl.as('api');
      judge = acl.as('judge');
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      const [u] = await db
        .insert(users)
        .values({ email: `q04-${randomBytes(3).toString('hex')}@example.com` })
        .returning();
      userId = u!.id;
      const [p] = await db
        .insert(problems)
        .values({ slug: `q04-${randomBytes(3).toString('hex')}`, title: 'Q04', difficulty: 800 })
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
      acl?.stop();
      await drop?.();
    });

    it('Q-04: the default user is off: no connection works without credentials', async () => {
      const { Redis: R } = await import('ioredis');
      const anon = new R({
        ...acl.addr,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      anon.on('error', () => {});
      await expect(anon.connect().then(() => anon.ping())).rejects.toThrow();
      anon.disconnect();
    });

    it('Q-04: the api user can do everything the API does: enqueue jobs and consume verdicts', async () => {
      // enqueue as the API (an EVAL script over seq:* and jobs:*)
      const queue = new QueueService(api, '');
      const enq = await queue.enqueue({
        submissionId: 'sub-acl',
        runVersion: 1,
        lane: 'practice',
        language: 'cpp17',
        source: 'int main(){}',
        problem: {
          versionId: 'pv',
          testsetHash: HASH,
          testsetUri: `s3://codearena/testsets/${HASH}.tar`,
          checker: { kind: 'tokens' },
          limits: { timeMs: 1000, memMb: 256, outputKb: 64 },
        },
        mode: 'submit',
        stopOnFirstFailure: true,
      });
      expect(enq.seq).toBe(1);
      expect(await admin.xlen('jobs:practice')).toBe(1);

      // a worker (the judge user) posts a result; the API consumer (the api user) stores it
      const [s] = await db
        .insert(submissions)
        .values({
          userId,
          problemVersionId: versionId,
          language: 'cpp17',
          source: 'x',
          sourceBytes: 1,
          lane: 'practice',
        })
        .returning();
      const result: JudgeResult = {
        submissionId: s!.id,
        runVersion: 1,
        verdict: 'AC',
        timeMs: 5,
        memKb: 100,
        tests: [{ no: 1, verdict: 'AC', timeMs: 5, memKb: 100 }],
        workerId: 'w1',
        finishedAt: 1_790_000_001_000,
      };
      await judge.xadd('results', '*', 'result', JSON.stringify(result));
      await judge.xadd('results', '*', 'result', 'garbage'); // poison: must be parked in results:dlq by the api user

      const processor = new ResultsProcessor(db, api, '', log);
      const consumer = new ResultsConsumer(api, '', processor, log, config, {
        blockMs: 100,
        reclaimEveryMs: 100,
        reclaimIdleMs: 200,
        trimEveryMs: 100,
        retryBackoffMs: [10],
      });
      consumer.start();
      try {
        const end = Date.now() + 10_000;
        for (;;) {
          const [row] = await db.select().from(submissions).where(eq(submissions.id, s!.id));
          const parked = await admin.xlen('results:dlq');
          // before the consumer has created its group there is nothing pending to count
          const pending = await (
            admin.xpending('results', RESULTS_GROUP) as Promise<[number]>
          ).then(
            (r) => r[0],
            () => Number.POSITIVE_INFINITY,
          );
          if (row?.verdict === 'AC' && parked === 1 && pending === 0) break;
          if (Date.now() > end)
            throw new Error(
              `consumer under the api ACL did not finish: verdict=${row?.verdict} dlq=${parked} pending=${pending}`,
            );
          await sleep(50);
        }
        await consumer.reclaim(); // XAUTOCLAIM
        await consumer.trim(); // XINFO GROUPS, XPENDING, XTRIM
      } finally {
        await consumer.stop();
      }
      expect(await admin.xlen(`evt:sub:${s!.id}`)).toBe(1); // XADD + EXPIRE on evt:*
      expect(await api.get('anything')).toBeNull(); // plain key access
      await api.set('tkt:probe', '1', 'EX', 60);
      expect(await api.getdel('tkt:probe')).toBe('1'); // tickets use GETDEL
    });

    it('Q-04: the api user cannot wipe, reconfigure or enumerate the server', async () => {
      await admin.set('keepme', 'v');
      const attempts: Record<string, () => Promise<unknown>> = {
        FLUSHALL: () => api.flushall(),
        FLUSHDB: () => api.flushdb(),
        'KEYS *': () => api.keys('*'),
        'CONFIG SET': () => api.config('SET', 'appendonly', 'no'),
        'CONFIG GET': () => api.config('GET', '*'),
        'ACL SETUSER': () => api.call('ACL', 'SETUSER', 'api', 'allcommands'),
        'ACL DELUSER': () => api.call('ACL', 'DELUSER', 'judge'),
        SHUTDOWN: () => api.call('SHUTDOWN', 'NOSAVE'),
        MONITOR: () => api.call('MONITOR'),
        REPLICAOF: () => api.call('REPLICAOF', 'evil.example', '6379'),
      };
      for (const [name, run] of Object.entries(attempts)) {
        expect(await denied(run()), `${name} must be refused for the api user`).toBe(true);
      }
      expect(await admin.get('keepme')).toBe('v');
    });
  },
);
