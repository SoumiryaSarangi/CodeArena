import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { JudgeProgress, JudgeResult } from '@codearena/contracts';
import { Redis } from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { customRuns, problems, problemVersions, submissions, users } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { QueuePositionService } from '../submissions/queue-position.service';
import { ResultsProcessor } from '../submissions/results.processor';
import { publishEvent } from './events';
import { ProgressBridge } from './progress.bridge';
import { Connection, MAX_WRITE_BUFFER, SseHub } from './sse.hub';
import { TicketsService } from './tickets.service';

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

const prefix = `t${randomBytes(4).toString('hex')}:`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Frame {
  id?: string;
  event?: string;
  data?: { topic: string; type: string; ts: number; data: Record<string, unknown> };
  comment?: string;
  retry?: string;
}

/** A minimal EventSource: raw HTTP, frames parsed as they arrive. */
function sse(port: number, query: string, headers: Record<string, string> = {}) {
  const frames: Frame[] = [];
  let status = 0;
  let body = '';
  let ended = false;
  let buf = '';
  const req = http.get({ port, path: `/api/sse?${query}`, headers }, (res) => {
    status = res.statusCode ?? 0;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      if (status !== 200) {
        body += chunk;
        return;
      }
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Frame = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) f.comment = line.slice(1).trim();
          else if (line.startsWith('id: ')) f.id = line.slice(4);
          else if (line.startsWith('event: ')) f.event = line.slice(7);
          else if (line.startsWith('retry: ')) f.retry = line.slice(7);
          else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
        }
        frames.push(f);
      }
    });
    res.on('end', () => (ended = true));
    res.on('close', () => (ended = true));
  });
  req.on('error', () => (ended = true));
  return {
    frames,
    events: () => frames.filter((f) => f.event),
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    get ended() {
      return ended;
    },
    close: () => req.destroy(),
  };
}

describe.skipIf(!ready)('Q-05: SSE gateway (needs the Compose Postgres and Redis)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let A: INestApplication;
  let B: INestApplication;
  let portA = 0;
  let portB = 0;
  let redis: Redis;
  let tickets: TicketsService;
  let processor: ResultsProcessor;
  let positions: QueuePositionService;
  let versionId: string;
  const log = pino({ level: 'silent' });
  const open: ReturnType<typeof sse>[] = [];

  const makeApp = async (url: string, over: Record<string, string> = {}) => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_DEFAULT_PER_MIN: '100000',
        DATABASE_URL: url,
        QUEUE_KEY_PREFIX: prefix,
        REALTIME_BRIDGE: 'on',
        BRIDGE_LEASE_MS: '600',
        SSE_PING_MS: '200',
        SSE_QUEUE_TICK_MS: '100',
        ...over,
      }),
    );
    await app.listen(0);
    return app;
  };
  const portOf = (app: INestApplication) =>
    (app.getHttpServer().address() as { port: number }).port;

  const makeUser = async () => {
    const id = randomUUID();
    await db
      .insert(users)
      .values({ id, email: `${id}@example.test`, handle: `u${id.slice(0, 8)}` });
    return { id, role: 'user' as const, sid: randomUUID() };
  };
  const makeSub = async (userId: string, over: Partial<typeof submissions.$inferInsert> = {}) => {
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
  const connect = async (
    port: number,
    user: { id: string; role: 'user'; sid: string } | undefined,
    topics: string[],
    headers: Record<string, string> = {},
  ) => {
    const { ticket } = await tickets.issue(user, { topics });
    const c = sse(port, `ticket=${ticket}&topics=${topics.join(',')}`, headers);
    open.push(c);
    return c;
  };
  const progress = (
    id: string,
    phase: JudgeProgress['phase'],
    extra: Partial<JudgeProgress> = {},
  ) =>
    ({
      submissionId: id,
      runVersion: 1,
      phase,
      workerId: 'w1',
      ts: Date.now(),
      ...extra,
    }) as JudgeProgress;
  const pub = (p: JudgeProgress) =>
    redis.publish(`${prefix}progress:${p.submissionId}`, JSON.stringify(p));
  const result = (id: string): JudgeResult => ({
    submissionId: id,
    runVersion: 1,
    verdict: 'AC',
    timeMs: 10,
    memKb: 1000,
    tests: [1, 2, 3].map((no) => ({ no, verdict: 'AC' as const, timeMs: 3, memKb: 1000 })),
    workerId: 'w1',
    finishedAt: Date.now(),
  });
  const leaders = () =>
    [A.get(ProgressBridge), B.get(ProgressBridge)].filter((b) => b.leader).length;

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    redis = new Redis(loadConfig({ NODE_ENV: 'test' }).REDIS_URL);
    A = await makeApp(t.url);
    B = await makeApp(t.url);
    portA = portOf(A);
    portB = portOf(B);
    tickets = A.get(TicketsService);
    processor = A.get(ResultsProcessor);
    positions = A.get(QueuePositionService);
    const [p] = await db
      .insert(problems)
      .values({ slug: `q05-${randomBytes(3).toString('hex')}`, title: 'Q05', difficulty: 800 })
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
    await until('one bridge leader', () => leaders() === 1);
  });

  afterAll(async () => {
    for (const c of open) c.close();
    const keys = await redis?.keys(`${prefix}*`);
    if (keys?.length) await redis.del(...keys);
    redis?.disconnect();
    await A?.close().catch(() => {});
    await B?.close().catch(() => {});
    await drop?.();
  });

  it('FR-RT-01: a valid ticket opens a stream that starts with retry: 3000', async () => {
    const c = await connect(portA, undefined, ['sys']);
    await until('first frame', () => c.frames.length > 0);
    expect(c.status).toBe(200);
    expect(c.frames[0]).toEqual({ retry: '3000' });
  });

  it('FR-RT-01: a ticket works once; unknown, malformed or over-asked tickets are refused', async () => {
    const u = await makeUser();
    const id = await makeSub(u.id);
    const { ticket } = await tickets.issue(u, { topics: [`sub:${id}`] });
    const first = sse(portA, `ticket=${ticket}&topics=sub:${id}`);
    open.push(first);
    await until('first stream open', () => first.status === 200);
    const again = sse(portA, `ticket=${ticket}&topics=sub:${id}`);
    await until('reuse answered', () => again.status !== 0);
    expect(again.status).toBe(401);
    expect(JSON.parse(again.body).code).toBe('unauthorized');

    const bad = sse(portA, `ticket=${'x'.repeat(43)}&topics=sys`);
    await until('bad answered', () => bad.status !== 0);
    expect(bad.status).toBe(401);
    const malformed = sse(portA, `ticket=short&topics=sys`);
    await until('malformed answered', () => malformed.status !== 0);
    expect(malformed.status).toBe(401);

    const t2 = await tickets.issue(u, { topics: [`sub:${id}`] });
    const over = sse(portA, `ticket=${t2.ticket}&topics=sub:${id},sys`);
    await until('over-ask answered', () => over.status !== 0);
    expect(over.status).toBe(401);
    const noTopics = sse(portA, `ticket=${t2.ticket}&topics=`);
    await until('no topics answered', () => noTopics.status !== 0);
    expect(noTopics.status).toBe(400);
  });

  it('FR-RT-01: a guest can only watch sys, and nobody can watch another user’s submission', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const id = await makeSub(owner.id);
    await expect(tickets.issue(undefined, { topics: [`sub:${id}`] })).rejects.toMatchObject({
      code: 'forbidden-topic',
    });
    await expect(tickets.issue(other, { topics: [`sub:${id}`] })).rejects.toMatchObject({
      code: 'forbidden-topic',
    });
    await tickets.issue(undefined, { topics: ['sys'] });
  });

  it('UI-02: the owner of a custom run may watch it; other users and guests may not', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const [run] = await db
      .insert(customRuns)
      .values({ userId: owner.id, language: 'cpp17', source: 'x', input: '1' })
      .returning();
    await tickets.issue(owner, { topics: [`sub:${run!.id}`] });
    await expect(tickets.issue(other, { topics: [`sub:${run!.id}`] })).rejects.toMatchObject({
      code: 'forbidden-topic',
    });
    await expect(tickets.issue(undefined, { topics: [`sub:${run!.id}`] })).rejects.toMatchObject({
      code: 'forbidden-topic',
    });
    await expect(tickets.issue(owner, { topics: [`sub:${randomUUID()}`] })).rejects.toMatchObject({
      code: 'forbidden-topic',
    });
  });

  it('FR-RT-03: heartbeat comments keep coming', async () => {
    const c = await connect(portA, undefined, ['sys']);
    await until('two pings', () => c.frames.filter((f) => f.comment === 'ping').length >= 2);
  });

  it('Q-05 acceptance: progress arrives in order, once, then the verdict (through either instance)', async () => {
    const u = await makeUser();
    const id = await makeSub(u.id);
    const viaA = await connect(portA, u, [`sub:${id}`]);
    const viaB = await connect(portB, u, [`sub:${id}`]);
    await until('both open', () => viaA.frames.length > 0 && viaB.frames.length > 0);
    await sleep(100); // subscriptions settle

    const phases: JudgeProgress[] = [
      progress(id, 'claimed'),
      progress(id, 'compiling'),
      progress(id, 'running'),
      ...[1, 2, 3].map((no) =>
        progress(id, 'running', { test: { no, verdict: 'AC', timeMs: no, memKb: 1000 } }),
      ),
      progress(id, 'done'),
    ];
    for (const p of phases) {
      await pub(p);
      await sleep(5);
    }
    await processor.handle(JSON.stringify(result(id)));

    for (const c of [viaA, viaB]) {
      await until(
        'all events',
        () => c.events().filter((f) => f.event !== 'submission.queue').length === 8,
      );
      const evs = c.events().filter((f) => f.event !== 'submission.queue');
      expect(evs.map((f) => f.event)).toEqual([
        ...Array(7).fill('submission.progress'),
        'submission.verdict',
      ]);
      const ids = evs.map((f) => f.id!);
      for (let i = 1; i < ids.length; i++)
        expect(ids[i]! > ids[i - 1]! || ids[i]!.length > ids[i - 1]!.length).toBe(true);
      expect(new Set(ids).size).toBe(8);
      const got = evs.slice(0, 7).map((f) => f.data!.data as unknown as JudgeProgress);
      expect(got.map((g) => g.phase)).toEqual(phases.map((p) => p.phase));
      expect(got.map((g) => g.test?.no)).toEqual(phases.map((p) => p.test?.no));
      expect(evs[7]!.data!.data).toMatchObject({ submissionId: id, verdict: 'AC', status: 'done' });
    }
    // exactly one copy in the replay buffer (one leader wrote it)
    expect(await redis.xlen(`${prefix}evt:sub:${id}`)).toBe(8);
  });

  it('FR-RT-02: reconnecting with Last-Event-ID returns exactly what was missed', async () => {
    const u = await makeUser();
    const id = await makeSub(u.id);
    const topic = `sub:${id}`;
    const first = await connect(portA, u, [topic]);
    await until('open', () => first.frames.length > 0);
    await sleep(100);
    for (let i = 1; i <= 3; i++)
      await publishEvent(redis, prefix, log, topic, 'submission.progress', progress(id, 'running'));
    await until('3 events', () => first.events().length === 3);
    const lastSeen = first.events()[2]!.id!;
    first.close();
    await sleep(50);
    const missed: string[] = [];
    for (let i = 4; i <= 7; i++)
      missed.push(
        (await publishEvent(
          redis,
          prefix,
          log,
          topic,
          'submission.progress',
          progress(id, 'running'),
        ))!,
      );

    const second = await connect(portB, u, [topic], { 'Last-Event-ID': lastSeen });
    await until('missed events', () => second.events().length === 4);
    await sleep(150);
    expect(second.events().map((f) => f.id)).toEqual(missed);
    expect(second.events().some((f) => f.id === lastSeen)).toBe(false);
  });

  it('FR-RT-02: events published while the replay is being written are neither lost nor doubled', async () => {
    const u = await makeUser();
    const id = await makeSub(u.id);
    const topic = `sub:${id}`;
    const ids: string[] = [];
    for (let i = 0; i < 30; i++)
      ids.push(
        (await publishEvent(
          redis,
          prefix,
          log,
          topic,
          'submission.progress',
          progress(id, 'running'),
        ))!,
      );
    const c = await connect(portA, u, [topic], { 'Last-Event-ID': ids[4]! });
    const live = (async () => {
      for (let i = 0; i < 40; i++) {
        ids.push(
          (await publishEvent(
            redis,
            prefix,
            log,
            topic,
            'submission.progress',
            progress(id, 'running'),
          ))!,
        );
      }
    })();
    await live;
    await until('all after the cursor', () => c.events().length === ids.length - 5);
    await sleep(150);
    expect(c.events().map((f) => f.id)).toEqual(ids.slice(5));
  });

  it('a client without Last-Event-ID catches up on a submission topic from the buffer', async () => {
    const u = await makeUser();
    const id = await makeSub(u.id);
    const topic = `sub:${id}`;
    await publishEvent(redis, prefix, log, topic, 'submission.progress', progress(id, 'claimed'));
    await publishEvent(redis, prefix, log, topic, 'submission.progress', progress(id, 'compiling'));
    const c = await connect(portA, u, [topic]);
    await until('2 events', () => c.events().length === 2);
    expect(c.events().map((f) => (f.data!.data as { phase: string }).phase)).toEqual([
      'claimed',
      'compiling',
    ]);
  });

  it('FR-RT-02: when the buffer is gone a finished submission is sent as a snapshot (no id)', async () => {
    const u = await makeUser();
    const id = await makeSub(u.id, {
      status: 'done',
      verdict: 'WA',
      timeMs: 50,
      memKb: 2000,
      failedTest: 3,
    });
    for (const headers of [{ 'Last-Event-ID': '1-0' }, {} as Record<string, string>]) {
      const c = await connect(portA, u, [`sub:${id}`], headers);
      await until('snapshot', () => c.events().length === 1);
      const f = c.events()[0]!;
      expect(f.event).toBe('submission.verdict');
      expect(f.id).toBeUndefined(); // must not move the client's Last-Event-ID
      expect(f.data!.data).toMatchObject({
        submissionId: id,
        verdict: 'WA',
        failedTest: 3,
        status: 'done',
      });
    }
    // an unfinished submission has no snapshot to give
    const waiting = await makeSub(u.id);
    const w = await connect(portA, u, [`sub:${waiting}`], { 'Last-Event-ID': '1-0' });
    await until('open', () => w.frames.length > 0);
    await sleep(200);
    expect(w.events()).toHaveLength(0);
  });

  it('FR-QUEUE-08: queued → position and ETA events that follow the queue, then 0, then silence', async () => {
    const u = await makeUser();
    const jobs = `${prefix}jobs:practice`;
    await redis.xgroup('CREATE', jobs, 'judges', '$', 'MKSTREAM').catch(() => {});
    await redis.set(`${prefix}ewma:svc:practice`, '2000');
    await redis.set(`${prefix}hb:w1`, '{}', 'EX', 60);
    await redis.set(`${prefix}hb:w2`, '{}', 'EX', 60);
    const ids = [await makeSub(u.id), await makeSub(u.id), await makeSub(u.id)];
    for (const id of ids) {
      const entry = (await redis.xadd(jobs, '*', 'job', '{}'))!;
      await positions.remember(id, 'practice', entry);
    }
    const c = await connect(portA, u, [`sub:${ids[2]}`]);
    const queue = () =>
      c
        .events()
        .filter((f) => f.event === 'submission.queue')
        .map((f) => f.data!.data);
    await until('first queue event', () => queue().length >= 1);
    expect(queue()[0]).toMatchObject({
      submissionId: ids[2],
      lane: 'practice',
      position: 3,
      etaSeconds: 3,
      capped: false,
    });
    expect(c.events()[0]!.id).toBeUndefined(); // live only

    // a judge takes two jobs: position drops
    await redis.xreadgroup('GROUP', 'judges', 'w1', 'COUNT', 2, 'STREAMS', jobs, '>');
    await until('moved up', () => queue().some((q) => (q as { position: number }).position === 1));
    // and takes the third: position 0
    await redis.xreadgroup('GROUP', 'judges', 'w1', 'COUNT', 1, 'STREAMS', jobs, '>');
    await until('zero', () => queue().some((q) => (q as { position: number }).position === 0));
    const n = queue().length;
    await sleep(400); // unchanged numbers are not repeated
    expect(queue().length).toBe(n);
  });

  it('FR-QUEUE-08: the service-time EWMA follows claimed → done', async () => {
    const u = await makeUser();
    await redis.del(`${prefix}ewma:svc:practice`);
    const run = async (ms: number) => {
      const id = await makeSub(u.id);
      await positions.remember(id, 'practice', '1-1');
      const now = Date.now();
      await pub(progress(id, 'claimed', { ts: now - ms }));
      await pub(progress(id, 'done', { ts: now }));
      return id;
    };
    await run(2000);
    await until(
      'first sample',
      async () => Number(await redis.get(`${prefix}ewma:svc:practice`)) === 2000,
    );
    await run(1000);
    await until(
      'second sample',
      async () => Math.round(Number(await redis.get(`${prefix}ewma:svc:practice`))) === 1800,
    );
  });

  it('SD-§10: a connection that falls 256 KB behind is cut off', () => {
    let ended = false;
    const res = {
      write: () => true,
      end: () => (ended = true),
      writableLength: MAX_WRITE_BUFFER + 1,
    };
    const conn = new Connection(null, ['sys'], res as never, null);
    B.get(SseHub).write(conn, 'x');
    expect(conn.closed).toBe(true);
    expect(ended).toBe(true);
  });

  it('a client that disconnects frees its Redis subscription', async () => {
    const hub = A.get(SseHub);
    const before = hub.connections;
    const topic = `sub:${randomUUID()}`;
    const u = await makeUser();
    const id = await makeSub(u.id);
    const t = `sub:${id}`;
    const c = await connect(portA, u, [t]);
    await until('open', () => hub.connections === before + 1);
    const num = async () => Number((await redis.pubsub('NUMSUB', `${prefix}rt:${t}`))[1]);
    expect(await num()).toBe(1);
    c.close();
    await until('closed', () => hub.connections === before);
    await until('unsubscribed', async () => (await num()) === 0);
    void topic;
  });

  it('at most 5 connections per user: the oldest is closed', async () => {
    const u = await makeUser();
    const id = await makeSub(u.id);
    const cs: ReturnType<typeof sse>[] = [];
    for (let i = 0; i < 6; i++) {
      cs.push(await connect(portB, u, [`sub:${id}`]));
      await until('open', () => cs[i]!.frames.length > 0);
    }
    await until('oldest closed', () => cs[0]!.ended);
    expect(cs.slice(1).every((c) => !c.ended)).toBe(true);
    expect(B.get(SseHub).connections).toBeGreaterThanOrEqual(5);
  });

  it('only one instance bridges; if the leader goes away the other takes over', async () => {
    expect(leaders()).toBe(1);
    const leader = A.get(ProgressBridge).leader ? A : B;
    const follower = leader === A ? B : A;
    await leader.close();
    await until('takeover', () => follower.get(ProgressBridge).leader, 4000);
    const u = await makeUser();
    const id = await makeSub(u.id);
    await pub(progress(id, 'claimed'));
    await until(
      'bridged by the new leader',
      async () => (await redis.xlen(`${prefix}evt:sub:${id}`)) === 1,
    );
    await sleep(150);
    expect(await redis.xlen(`${prefix}evt:sub:${id}`)).toBe(1);
  });
});
