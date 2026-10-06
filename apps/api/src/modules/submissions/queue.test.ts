import { randomBytes } from 'node:crypto';
import { JudgeJob, type Lane } from '@codearena/contracts';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemError } from '../../common/problem';
import { loadConfig } from '../../config/config';
import { type EnqueueInput, QueueService } from './queue.service';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const probe = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
});
probe.on('error', () => {});
const reachable = await probe
  .connect()
  .then(() => true)
  .catch(() => false);
probe.disconnect();

const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

const input = (lane: Lane, over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  submissionId: `sub-${randomBytes(3).toString('hex')}`,
  runVersion: 1,
  lane,
  language: 'cpp17',
  source: 'int main(){}',
  problem: {
    versionId: 'pv-1',
    testsetHash: HASH,
    testsetUri: `s3://codearena/testsets/${HASH}.tar`,
    checker: { kind: 'tokens' },
    limits: { timeMs: 1000, memMb: 256, outputKb: 64 },
  },
  mode: 'submit',
  stopOnFirstFailure: true,
  ...over,
});

describe.skipIf(!reachable)('Q-01: enqueue service (needs the Compose Redis)', () => {
  let redis: Redis;
  let queue: QueueService;
  const prefix = `t_${randomBytes(4).toString('hex')}:`;

  beforeAll(() => {
    redis = new Redis(config.REDIS_URL);
    queue = new QueueService(redis, prefix);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
  });

  it('FR-QUEUE-01: a job becomes one entry in its lane stream, in the wire format the worker reads', async () => {
    const r = await queue.enqueue(input('practice'));
    const entries = await redis.xrange(queue.jobsKey('practice'), '-', '+');
    expect(entries).toHaveLength(1);
    const [id, fields] = entries[0]!;
    expect(id).toBe(r.entryId);
    expect(fields[0]).toBe('job');
    const raw = fields[1]!;
    expect(raw.startsWith('{"seq":1,')).toBe(true);
    const job = JudgeJob.parse(JSON.parse(raw));
    expect(job.jobId).toBe(r.jobId);
    expect(job.lane).toBe('practice');
    expect(job.seq).toBe(1);
    expect(job.enqueuedAt).toBeGreaterThan(Date.now() - 5_000);
    expect(job.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('Q-01: seq is a per-lane counter that starts at 1 and counts each lane separately', async () => {
    const a1 = await queue.enqueue(input('contest'));
    const a2 = await queue.enqueue(input('contest'));
    const b1 = await queue.enqueue(input('rejudge'));
    expect([a1.seq, a2.seq, b1.seq]).toEqual([1, 2, 1]);
    expect(await redis.get(queue.seqKey('contest'))).toBe('2');
  });

  it('Q-01: with 60 concurrent enqueues every seq is unique and the stream order matches the seq order', async () => {
    const lane: Lane = 'interactive';
    const results = await Promise.all(Array.from({ length: 60 }, () => queue.enqueue(input(lane))));
    expect(new Set(results.map((r) => r.seq)).size).toBe(60);
    const entries = await redis.xrange(queue.jobsKey(lane), '-', '+');
    const seqs = entries.map(([, f]) => (JSON.parse(f[1]!) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('Q-01: a job the worker would reject is refused before it takes a queue slot or a seq', async () => {
    const before = Number((await redis.get(queue.seqKey('practice'))) ?? 0);
    const bad = input('practice');
    bad.problem = { ...bad.problem, testsetHash: 'sha256:abc123' };
    await expect(queue.enqueue(bad)).rejects.toBeInstanceOf(ProblemError);
    await expect(queue.enqueue(bad)).rejects.toMatchObject({ code: 'validation' });
    expect(Number((await redis.get(queue.seqKey('practice'))) ?? 0)).toBe(before);
    expect(await redis.xlen(queue.jobsKey('practice'))).toBe(1);
  });

  it('Q-01: source text that looks like the seq marker cannot corrupt the stamped counter', async () => {
    const tricky = input('rejudge', { source: '{"seq":0,"x":1} "seq":0,' });
    const r = await queue.enqueue(tricky);
    const entry = (await redis.xrange(queue.jobsKey('rejudge'), r.entryId, r.entryId))[0]!;
    const job = JudgeJob.parse(JSON.parse(entry[1][1]!));
    expect(job.seq).toBe(r.seq);
    expect(job.source).toBe('{"seq":0,"x":1} "seq":0,');
  });

  it('FR-SUB-01: an oversized source is rejected as a validation problem', async () => {
    await expect(
      queue.enqueue(input('practice', { source: 'x'.repeat(65 * 1024) })),
    ).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('an explicit traceparent is kept so the worker span joins the API trace', async () => {
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const r = await queue.enqueue(input('contest', { traceparent: tp }));
    const entry = (await redis.xrange(queue.jobsKey('contest'), r.entryId, r.entryId))[0]!;
    expect(JudgeJob.parse(JSON.parse(entry[1][1]!)).traceparent).toBe(tp);
  });
});
