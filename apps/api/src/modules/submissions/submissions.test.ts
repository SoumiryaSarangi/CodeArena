import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { type JudgeJob, JudgeJob as JudgeJobSchema, type JudgeResult } from '@codearena/contracts';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { customRuns, problems, problemVersions, submissions, users } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { ProblemImporter } from '../problems/problems.import';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { publishEvent } from '../realtime/events';
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

const prefix = `t${randomBytes(4).toString('hex')}:`;
const log = pino({ level: 'silent' });
const csrf = randomBytes(32).toString('base64url');
const root = new URL('../../../../../problems/', import.meta.url).pathname;

describe.skipIf(!ready)('S-01: submissions API (needs the Compose Postgres, Redis and S3)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let redis: Redis;
  let tokens: AccessTokens;
  let processor: ResultsProcessor;

  const makeUser = async (role: 'user' | 'admin' = 'user', handle = true) => {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      email: `${id}@example.test`,
      role,
      handle: handle ? `u${id.slice(0, 8)}` : null,
    });
    const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
    return { id, token };
  };
  const call = (method: 'get' | 'post', path: string, token?: string) => {
    const r = request(app.getHttpServer())[method](`/api${path}`);
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r.set('Cookie', `ca_csrf=${csrf}`).set('X-CSRF-Token', csrf);
  };
  const SRC = '#include <cstdio>\nint main(){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);}\n';
  const submit = (token: string, extra: object = {}) =>
    call('post', '/submissions', token).send({
      problemSlug: 'sum-two-numbers',
      language: 'cpp17',
      source: SRC,
      ...extra,
    });
  const jobs = async (lane = 'practice') =>
    (await redis.xrange(`${prefix}jobs:${lane}`, '-', '+')).map(([id, f]) => ({
      id,
      job: JudgeJobSchema.parse(JSON.parse(f[1]!)),
    }));

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DEFAULT_PER_MIN: '100000',
      DATABASE_URL: t.url,
      QUEUE_KEY_PREFIX: prefix,
    });
    redis = new Redis(config.REDIS_URL);
    app = await createApp(config);
    await app.init();
    tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    processor = app.get(ResultsProcessor);
    const importer = app.get(ProblemImporter);
    for (const slug of ['sum-two-numbers', 'hall-of-fame']) {
      const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
      if (!r.ok) throw new Error(slug);
      await importer.import(r.pkg, { visibility: 'public' });
    }
  });

  afterAll(async () => {
    const keys = await redis?.keys(`${prefix}*`);
    if (keys?.length) await redis.del(...keys);
    redis?.disconnect();
    await app?.close();
    await drop?.();
  });

  /** Plays the worker: reads the job from the stream and posts a result the consumer would store. */
  const judge = async (job: JudgeJob, verdict: JudgeResult['verdict'], tests = 3) => {
    const result: JudgeResult = {
      submissionId: job.submissionId,
      runVersion: job.runVersion,
      verdict,
      timeMs: 120,
      memKb: 3000,
      tests: Array.from({ length: tests }, (_, i) => ({
        no: i + 1,
        verdict: verdict !== 'AC' && i === tests - 1 ? verdict : 'AC',
        timeMs: 40 + i,
        memKb: 3000,
        ...(i === tests - 1 && verdict !== 'AC' ? { checkerMsg: 'expected 42 found 41' } : {}),
      })),
      workerId: 'w-test',
      finishedAt: Date.now(),
    };
    return processor.handle(JSON.stringify(result));
  };

  it('FR-SUB-01/02/03: submit stores the source, queues a job and answers with position and ETA', async () => {
    const u = await makeUser();
    const res = await submit(u.token).expect(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      lane: 'practice',
      position: expect.any(Number),
      etaSeconds: expect.any(Number),
    });
    expect(res.body.position).toBeGreaterThanOrEqual(1);
    const [sub] = await db.select().from(submissions).where(eq(submissions.id, res.body.id));
    expect(sub).toMatchObject({
      userId: u.id,
      language: 'cpp17',
      source: SRC,
      sourceBytes: Buffer.byteLength(SRC),
      lane: 'practice',
      status: 'queued',
      currentRunVersion: 1,
    });
    const queued = (await jobs()).find((j) => j.job.submissionId === res.body.id)!;
    expect(queued.job).toMatchObject({
      mode: 'submit',
      runVersion: 1,
      lane: 'practice',
      language: 'cpp17',
      source: SRC,
      stopOnFirstFailure: false,
    });
    expect(queued.job.problem.versionId).toBe(sub!.problemVersionId);
    expect(queued.job.problem.testsetUri).toMatch(/^s3:\/\/[^/]+\/testsets\/[0-9a-f]{64}\.tar$/);
  });

  it('FR-SUB-01: submit → verdict persisted → detail shows per-test results (acceptance)', async () => {
    const u = await makeUser();
    const { body } = await submit(u.token).expect(201);
    const { job } = (await jobs()).find((j) => j.job.submissionId === body.id)!;
    expect(await judge(job, 'WA', 4)).toMatchObject({ kind: 'applied' });

    const d = (await call('get', `/submissions/${body.id}`, u.token).expect(200)).body;
    expect(d).toMatchObject({
      id: body.id,
      problemSlug: 'sum-two-numbers',
      status: 'done',
      verdict: 'WA',
      failedTest: 4,
      language: 'cpp17',
      source: SRC,
      runVersion: 1,
      compileLog: null,
    });
    expect(d.tests).toHaveLength(4);
    expect(d.tests.map((t: { verdict: string }) => t.verdict)).toEqual(['AC', 'AC', 'AC', 'WA']);
    expect(d.journey.workerId).toBe('w-test');
    expect(d.journey.judgedAt).not.toBeNull();
  });

  it('FR-SUB-06: a checker message is shown for sample tests only, never for hidden ones', async () => {
    const u = await makeUser();
    const { body } = await submit(u.token).expect(201);
    const { job } = (await jobs()).find((j) => j.job.submissionId === body.id)!;
    await judge(job, 'WA', 5); // the failing test (no. 5) is past the 2 samples
    const d = (await call('get', `/submissions/${body.id}`, u.token).expect(200)).body;
    expect(d.tests[4].checkerMsg).toBeNull();
    expect(JSON.stringify(d)).not.toContain('expected 42');
  });

  it('FR-SUB-06: the compile log shows for CE and for nothing else', async () => {
    const u = await makeUser();
    const { body } = await submit(u.token).expect(201);
    const { job } = (await jobs()).find((j) => j.job.submissionId === body.id)!;
    await processor.handle(
      JSON.stringify({
        submissionId: job.submissionId,
        runVersion: 1,
        verdict: 'CE',
        timeMs: 0,
        memKb: 0,
        compileLog: 'main.cpp:1: error: expected ;',
        tests: [],
        workerId: 'w-test',
        finishedAt: Date.now(),
      }),
    );
    const d = (await call('get', `/submissions/${body.id}`, u.token).expect(200)).body;
    expect(d.verdict).toBe('CE');
    expect(d.compileLog).toBe('main.cpp:1: error: expected ;');
  });

  it('FR-SUB-01: rejects an unknown language (422), a big source (413), an unknown problem (404), bad bodies (400)', async () => {
    const u = await makeUser();
    expect((await submit(u.token, { language: 'brainfuck' }).expect(422)).body.code).toBe(
      'unsupported-language',
    );
    const big = await submit(u.token, { source: 'x'.repeat(64 * 1024 + 1) }).expect(413);
    expect(big.body.code).toBe('payload-too-large');
    await submit(u.token, { source: 'x'.repeat(64 * 1024) }).expect(201);
    expect((await submit(u.token, { problemSlug: 'nope' }).expect(404)).body.code).toBe(
      'not-found',
    );
    await submit(u.token, { source: '' }).expect(400);
    await submit(u.token, { extra: 1 }).expect(400);
    // 2-byte characters count as bytes, not characters
    await submit((await makeUser()).token, { source: 'é'.repeat(33_000) }).expect(413);
  });

  it('FR-SUB-01: a private problem cannot be submitted to', async () => {
    const u = await makeUser();
    await db
      .update(problems)
      .set({ visibility: 'private' })
      .where(eq(problems.slug, 'hall-of-fame'));
    await submit(u.token, { problemSlug: 'hall-of-fame' }).expect(404);
    await db
      .update(problems)
      .set({ visibility: 'public' })
      .where(eq(problems.slug, 'hall-of-fame'));
  });

  it('auth: signed-out is 401, no handle is 403, and nothing is stored or queued', async () => {
    const before = (await jobs()).length;
    const rows = (await db.select().from(submissions)).length;
    await call('post', '/submissions')
      .send({ problemSlug: 'sum-two-numbers', language: 'cpp17', source: SRC })
      .expect(401);
    const nohandle = await makeUser('user', false);
    expect((await submit(nohandle.token).expect(403)).body.code).toBe('forbidden');
    expect((await jobs()).length).toBe(before);
    expect((await db.select().from(submissions)).length).toBe(rows);
  });

  it('FR-SUB-04: the 7th submit within a minute is 429 with Retry-After; runs allow 12', async () => {
    const u = await makeUser();
    for (let i = 0; i < 6; i++) await submit(u.token).expect(201);
    const res = await submit(u.token).expect(429);
    expect(res.body.code).toBe('rate-limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const r = await makeUser();
    for (let i = 0; i < 12; i++)
      await call('post', '/runs', r.token)
        .send({ problemSlug: 'sum-two-numbers', language: 'cpp17', source: SRC, input: '1 2\n' })
        .expect(201);
    await call('post', '/runs', r.token)
      .send({ problemSlug: 'sum-two-numbers', language: 'cpp17', source: SRC, input: '1 2\n' })
      .expect(429);
  });

  it('FR-SUB-09: the same Idempotency-Key returns the original response and queues once', async () => {
    const u = await makeUser();
    const key = randomUUID();
    const send = () => submit(u.token).set('Idempotency-Key', key);
    const [a, b, c] = await Promise.all([send(), send(), send()]);
    for (const r of [a, b, c]) expect(r.status).toBe(201);
    expect(new Set([a, b, c].map((r) => r.body.id)).size).toBe(1);
    const later = await send().expect(201);
    expect(later.body.id).toBe(a.body.id);
    expect(await db.select().from(submissions).where(eq(submissions.userId, u.id))).toHaveLength(1);
    expect((await jobs()).filter((j) => j.job.submissionId === a.body.id)).toHaveLength(1);
    // another user with the same key is a different request
    const other = await makeUser();
    const o = await submit(other.token).set('Idempotency-Key', key).expect(201);
    expect(o.body.id).not.toBe(a.body.id);
    expect((await submit(u.token).set('Idempotency-Key', 'not-a-uuid').expect(400)).body.code).toBe(
      'validation',
    );
  });

  it('FR-SUB-07: lists own submissions newest first, filters, pages; another user is 403 unless admin', async () => {
    const u = await makeUser();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await submit(u.token).expect(201)).body.id);
    const { job } = (await jobs()).find((j) => j.job.submissionId === ids[3])!;
    await judge(job, 'AC');
    const all = (await call('get', '/submissions?limit=100', u.token).expect(200)).body;
    expect(all.items.map((s: { id: string }) => s.id)).toEqual([...ids].reverse());
    expect(all.items[0]).toMatchObject({
      problemSlug: 'sum-two-numbers',
      verdict: 'AC',
      status: 'done',
    });
    expect(all.items[0]).not.toHaveProperty('source');
    expect(
      (await call('get', '/submissions?verdict=AC', u.token).expect(200)).body.items,
    ).toHaveLength(1);
    expect(
      (await call('get', '/submissions?language=python3', u.token).expect(200)).body.items,
    ).toHaveLength(0);
    expect(
      (await call('get', '/submissions?problem=hall-of-fame', u.token).expect(200)).body.items,
    ).toHaveLength(0);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: { body: { items: { id: string }[]; nextCursor: string | null } } = await call(
        'get',
        `/submissions?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        u.token,
      ).expect(200);
      seen.push(...p.body.items.map((s) => s.id));
      cursor = p.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());

    const other = await makeUser();
    expect(
      (await call('get', `/submissions?user=${u.id}`, other.token).expect(403)).body.code,
    ).toBe('forbidden');
    const admin = await makeUser('admin');
    expect(
      (await call('get', `/submissions?user=${u.id}`, admin.token).expect(200)).body.items,
    ).toHaveLength(4);
    // nobody sees someone else's rows by default
    expect((await call('get', '/submissions', other.token).expect(200)).body.items).toHaveLength(0);
  });

  it('FR-SUB-06: detail and position belong to the owner (404 otherwise, hiding existence); an admin may read any', async () => {
    const u = await makeUser();
    const other = await makeUser();
    const admin = await makeUser('admin');
    const { body } = await submit(u.token).expect(201);
    for (const path of [`/submissions/${body.id}`, `/submissions/${body.id}/position`]) {
      expect((await call('get', path, other.token).expect(404)).body.code).toBe('not-found');
      await call('get', path, admin.token).expect(200);
      await call('get', path, u.token).expect(200);
      await call('get', path).expect(401);
    }
    await call('get', `/submissions/${randomUUID()}`, u.token).expect(404);
  });

  it('US-3.3: the journey (when each phase began, on which judge) is kept with the verdict and shown on the detail', async () => {
    const u = await makeUser();
    const admin = await makeUser('admin');
    const { body } = await submit(u.token).expect(201);
    const { job } = (await jobs()).find((j) => j.job.submissionId === body.id)!;
    const t0 = Date.now() - 5000;
    const at = (n: number) => t0 + n;
    for (const [phase, ts] of [
      ['claimed', at(0)],
      ['compiling', at(300)],
      ['running', at(1900)],
      ['running', at(2500)], // a later test: the phase began at 1900
      ['done', at(4000)],
    ] as const) {
      await publishEvent(redis, prefix, log, `sub:${body.id}`, 'submission.progress', {
        submissionId: body.id,
        runVersion: 1,
        phase,
        workerId: 'judge-2',
        ts,
      });
    }
    // another run version's events must not leak into this one
    await publishEvent(redis, prefix, log, `sub:${body.id}`, 'submission.progress', {
      submissionId: body.id,
      runVersion: 2,
      phase: 'claimed',
      workerId: 'judge-9',
      ts: at(-100),
    });
    await judge(job, 'AC');

    const d = (await call('get', `/submissions/${body.id}`, u.token).expect(200)).body;
    expect(d.journey.steps).toEqual([
      { phase: 'claimed', at: new Date(at(0)).toISOString() },
      { phase: 'compiling', at: new Date(at(300)).toISOString() },
      { phase: 'running', at: new Date(at(1900)).toISOString() },
      { phase: 'done', at: new Date(at(4000)).toISOString() },
    ]);
    expect(d.journey.workerId).toBe('w-test');
    expect(d).not.toHaveProperty('runs'); // admins only
    const a = (await call('get', `/submissions/${body.id}`, admin.token).expect(200)).body;
    expect(a.runs).toEqual([
      expect.objectContaining({
        runVersion: 1,
        reason: 'initial',
        workerId: 'w-test',
        verdict: 'AC',
      }),
    ]);
  });

  it('US-3.3: with no progress events the detail still works, with an empty list of steps', async () => {
    const u = await makeUser();
    const { body } = await submit(u.token).expect(201);
    expect(
      (await call('get', `/submissions/${body.id}`, u.token).expect(200)).body.journey.steps,
    ).toEqual([]);
    const { job } = (await jobs()).find((j) => j.job.submissionId === body.id)!;
    await judge(job, 'AC');
    const d = (await call('get', `/submissions/${body.id}`, u.token).expect(200)).body;
    expect(d.journey.steps).toEqual([]);
    expect(d.verdict).toBe('AC');
  });

  it('FR-SUB-02: queue position counts jobs ahead in the lane and higher lanes; 0 once judged', async () => {
    const group = `${prefix}jobs:practice`;
    await redis.xgroup('CREATE', group, 'judges', '$', 'MKSTREAM').catch(() => {});
    await redis
      .xgroup('CREATE', `${prefix}jobs:contest`, 'judges', '$', 'MKSTREAM')
      .catch(() => {});
    const u = await makeUser();
    const a = (await submit(u.token).expect(201)).body.id;
    const b = (await submit(u.token).expect(201)).body.id;
    const c = (await submit(u.token).expect(201)).body.id;
    const pos = async (id: string) =>
      (await call('get', `/submissions/${id}/position`, u.token).expect(200)).body;
    const [pa, pb, pc] = [await pos(a), await pos(b), await pos(c)];
    expect(pb.position - pa.position).toBe(1);
    expect(pc.position - pb.position).toBe(1);
    expect(pa).toMatchObject({ lane: 'practice', capped: false });
    expect(pc.etaSeconds).toBeGreaterThanOrEqual(pa.etaSeconds);

    // A judge takes the first job: the others move up by one.
    await redis.xreadgroup('GROUP', 'judges', 'w1', 'COUNT', 1, 'STREAMS', group, '>');
    const after = await pos(c);
    expect(after.position).toBe(pc.position - 1);
    // Jobs waiting in a higher lane go first.
    await redis.xadd(`${prefix}jobs:contest`, '*', 'job', '{}');
    await redis.xadd(`${prefix}jobs:contest`, '*', 'job', '{}');
    expect((await pos(c)).position).toBe(after.position + 2);
    // Taken by a judge → 0 (the one that was read above is `a`'s job or earlier ones)
    await redis.xreadgroup('GROUP', 'judges', 'w1', 'COUNT', 100, 'STREAMS', group, '>');
    expect((await pos(c)).position).toBe(0);
    // Done → 0 and the lane is still reported
    const { job } = (await jobs()).find((j) => j.job.submissionId === c)!;
    await judge(job, 'AC');
    expect(await pos(c)).toEqual({ lane: 'practice', position: 0, etaSeconds: 0, capped: false });
  });

  it('FR-SUB-05: a custom run with input is queued as mode run and its result is readable by its owner only', async () => {
    const u = await makeUser();
    const res = await call('post', '/runs', u.token)
      .send({ problemSlug: 'sum-two-numbers', language: 'cpp17', source: SRC, input: '3 4\n' })
      .expect(201);
    expect(res.body.runIds).toEqual([res.body.runId]);
    const queued = (await jobs()).find((j) => j.job.submissionId === res.body.runId)!;
    expect(queued.job).toMatchObject({
      mode: 'run',
      customInput: '3 4\n',
      stopOnFirstFailure: false,
    });
    expect((await call('get', `/runs/${res.body.runId}`, u.token).expect(200)).body).toMatchObject({
      status: 'queued',
      verdict: null,
      output: null,
    });
    await processor.handle(
      JSON.stringify({
        submissionId: res.body.runId,
        runVersion: 1,
        verdict: 'AC',
        timeMs: 5,
        memKb: 1000,
        tests: [],
        output: '7\n',
        stderr: 'warn\n',
        workerId: 'w-test',
        finishedAt: Date.now(),
      }),
    );
    const done = (await call('get', `/runs/${res.body.runId}`, u.token).expect(200)).body;
    expect(done).toMatchObject({
      status: 'done',
      verdict: 'AC',
      output: '7\n',
      stderr: 'warn\n',
      timeMs: 5,
    });
    expect(done.matches).toBeNull(); // not a sample input
    const other = await makeUser();
    expect((await call('get', `/runs/${res.body.runId}`, other.token).expect(404)).body.code).toBe(
      'not-found',
    );
    await call('get', `/runs/${randomUUID()}`, u.token).expect(404);
    // it never touches scores or the submission list
    expect((await call('get', '/submissions', u.token).expect(200)).body.items).toHaveLength(0);
  });

  it('FR-SUB-05: sampleIds runs each sample and reports expected output and a match', async () => {
    const u = await makeUser();
    const res = await call('post', '/runs', u.token)
      .send({
        problemSlug: 'sum-two-numbers',
        language: 'cpp17',
        source: SRC,
        sampleIds: [1, 2, 2],
      })
      .expect(201);
    expect(res.body.runIds).toHaveLength(2);
    const [s1] = (
      await db.select().from(problemVersions).where(eq(problemVersions.version, 1))
    ).filter((v) => (v.samples as unknown[]).length >= 2);
    const samples = s1!.samples as { in: string; out: string }[];
    const runs = await db.select().from(customRuns).where(eq(customRuns.userId, u.id));
    expect(runs.map((r) => r.input).sort()).toEqual([samples[0]!.in, samples[1]!.in].sort());
    const first = runs.find((r) => r.input === samples[0]!.in)!;
    await processor.handle(
      JSON.stringify({
        submissionId: first.id,
        runVersion: 1,
        verdict: 'AC',
        timeMs: 1,
        memKb: 1,
        tests: [],
        output: samples[0]!.out.trimEnd() + '  \n\n',
        workerId: 'w',
        finishedAt: Date.now(),
      }),
    );
    const ok = (await call('get', `/runs/${first.id}`, u.token).expect(200)).body;
    expect(ok.expected).toBe(samples[0]!.out);
    expect(ok.matches).toBe(true);
    const second = runs.find((r) => r.id !== first.id)!;
    await processor.handle(
      JSON.stringify({
        submissionId: second.id,
        runVersion: 1,
        verdict: 'AC',
        timeMs: 1,
        memKb: 1,
        tests: [],
        output: 'wrong answer\n',
        workerId: 'w',
        finishedAt: Date.now(),
      }),
    );
    expect((await call('get', `/runs/${second.id}`, u.token).expect(200)).body.matches).toBe(false);
  });

  it('FR-SUB-05: run input over 1 MB is 413; both or neither of input/sampleIds, or a missing sample, is 400', async () => {
    const u = await makeUser();
    const base = { problemSlug: 'sum-two-numbers', language: 'cpp17', source: SRC };
    expect(
      (
        await call('post', '/runs', u.token)
          .send({ ...base, input: 'x'.repeat(1024 * 1024 + 1) })
          .expect(413)
      ).body.code,
    ).toBe('payload-too-large');
    await call('post', '/runs', u.token)
      .send({ ...base, input: '' })
      .expect(201);
    await call('post', '/runs', u.token)
      .send({ ...base })
      .expect(400);
    await call('post', '/runs', u.token)
      .send({ ...base, input: '1', sampleIds: [1] })
      .expect(400);
    await call('post', '/runs', u.token)
      .send({ ...base, sampleIds: [19] })
      .expect(400);
    await call('post', '/runs', u.token)
      .send({ ...base, language: 'cobol', input: '1' })
      .expect(422);
  });

  it('a queue failure marks the submission failed instead of leaving it queued forever', async () => {
    const u = await makeUser();
    // A lane key that is not a stream makes the enqueue script fail.
    await redis.del(`${prefix}jobs:practice`);
    await redis.set(`${prefix}jobs:practice`, 'not a stream');
    const res = await submit(u.token);
    expect(res.status).toBe(500);
    const rows = await db.select().from(submissions).where(eq(submissions.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    await redis.del(`${prefix}jobs:practice`);
  });
});
