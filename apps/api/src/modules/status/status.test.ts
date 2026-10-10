import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { problemVersions, problems, submissions, users } from '../../db/schema';
import { StatusService } from '../status/status.service';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
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

describe.skipIf(!ready)('O-02: public status (needs the Compose Postgres, Redis and S3)', () => {
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
            (await db.select({ id: problems.id }).from(problems).where(eq(problems.slug, slug)))[0]!
              .id,
          ),
        );
    }
    admin = await makeUser('admin');
    const slug = `s-${prefix.slice(0, -1)}`;
    const made = await call('post', '/admin/contests', admin.token, {
      slug,
      title: 'Status',
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
        .select({ id: problemVersions.id })
        .from(problemVersions)
        .innerJoin(problems, eq(problems.id, problemVersions.problemId))
        .where(eq(problems.slug, slug))
    )[0]!.id;
  let tick = 0;
  /** The service answers from a 5 s cache; each call here is "a minute later", so it recomputes. */
  const fresh = () => app.get(StatusService).get(Date.now() + 60_000 * ++tick);
  const find = (s: { components: { id: string }[] }, id: string) =>
    s.components.find((c) => c.id === id) as unknown as { state: string; detail: string };

  it('O-02: the interview pad is up when the collab servers answer, degraded when some do not, down when none do, planned when none is configured', async () => {
    const server = createServer((_req, res) => res.writeHead(200).end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const live = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dead = 'http://127.0.0.1:9';
    const service = (url?: string) =>
      new StatusService(db, redis, prefix, { ...config, COLLAB_URL: url } as typeof config);
    try {
      expect(find(await service().get(), 'pad')).toMatchObject({ state: 'planned' });
      expect(find(await service(live).get(), 'pad')).toMatchObject({ state: 'ok' });
      expect(find(await service(`${live} ${dead}`).get(), 'pad')).toMatchObject({
        state: 'degraded',
        detail: '1 of 2 servers answering',
      });
      const down = await service(dead).get();
      expect(find(down, 'pad')).toMatchObject({ state: 'down' });
      // judging is the core: a dead pad degrades an otherwise healthy platform, never takes it down
      const withPad = (await service(live).get()).overall;
      expect(down.overall).toBe(withPad === 'ok' ? 'degraded' : withPad);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('O-02: anyone can read it, it is cached for 5 s, and it says what each part is doing', async () => {
    const r = await call('get', '/status'); // no token
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=5');
    expect(r.body.components.map((c: { id: string }) => c.id)).toEqual([
      'api',
      'database',
      'queue',
      'judges',
      'realtime',
      'pad',
    ]);
    expect(find(r.body, 'api').state).toBe('ok');
    expect(find(r.body, 'database').state).toBe('ok');
    expect(find(r.body, 'realtime').state).toBe('ok');
    expect(find(r.body, 'pad')).toMatchObject({ state: 'planned' });
    expect(r.body.queue.map((q: { lane: string }) => q.lane)).toEqual([
      'contest',
      'interactive',
      'practice',
      'rejudge',
    ]);
    // Nothing private: only these keys.
    expect(Object.keys(r.body).sort()).toEqual([
      'components',
      'overall',
      'p50Ms',
      'p95Ms',
      'queue',
      'serverNow',
      'totals',
    ]);
    // Two reads inside 5 s are one computation.
    const svc = app.get(StatusService);
    const t = Date.now() + 30_000;
    const a = await svc.get(t);
    expect(await svc.get(t + 4_000)).toBe(a);
    expect(await svc.get(t + 6_000)).not.toBe(a);
  });

  it('O-02: no judge reporting is "down"; a heartbeat makes judges and the whole platform ok', async () => {
    const none = await fresh();
    expect(find(none, 'judges')).toMatchObject({ state: 'down' });
    expect(none.overall).toBe('down');
    await redis.set(
      `${prefix}hb:w1`,
      JSON.stringify({
        workerId: 'w1',
        lanes: ['contest'],
        ts: Date.now() - 1000,
        busy: 0,
        concurrency: 2,
      }),
      'EX',
      30,
    );
    await redis.set(
      `${prefix}hb:old`,
      JSON.stringify({
        workerId: 'old',
        lanes: ['contest'],
        ts: Date.now() - 10 * 60_000,
        busy: 0,
        concurrency: 2,
      }),
      'EX',
      30,
    );
    const ok = await fresh();
    expect(find(ok, 'judges')).toEqual(
      expect.objectContaining({ state: 'ok', detail: '1 judge reporting' }),
    );
    expect(ok.overall).toBe('ok');
  });

  it('O-02: a deep contest queue is "degraded"; the pad row does not count against the platform', async () => {
    for (let i = 0; i < 25; i++) await redis.xadd(`${prefix}jobs:contest`, '*', 'job', '{}');
    const s = await fresh();
    expect(s.queue.find((q) => q.lane === 'contest')?.depth).toBe(25);
    expect(find(s, 'queue')).toMatchObject({
      state: 'degraded',
      detail: '25 contest jobs waiting',
    });
    expect(s.overall).toBe('degraded');
    await redis.del(`${prefix}jobs:contest`);
    expect((await fresh()).overall).toBe('ok');
  });

  it('O-02: speed and totals come from the database', async () => {
    const before = await fresh();
    expect(before.p95Ms).toBeNull();
    const u = await makeUser();
    const v = await versionOf(P1);
    const t = new Date();
    for (const ms of [1000, 3000]) {
      await db.insert(submissions).values({
        userId: u.id,
        problemVersionId: v,
        language: 'cpp17',
        source: 'x',
        sourceBytes: 1,
        lane: 'practice',
        status: 'done',
        verdict: 'AC',
        createdAt: new Date(t.getTime() - ms),
        judgedAt: t,
      });
    }
    const s = await fresh();
    expect(s.p50Ms).toBeGreaterThanOrEqual(1900);
    expect(s.p50Ms).toBeLessThanOrEqual(2100);
    expect(s.p95Ms!).toBeGreaterThan(s.p50Ms!);
    expect(s.totals.submissionsJudged).toBe(before.totals.submissionsJudged + 2);
    expect(s.totals.contestsHosted).toBeGreaterThanOrEqual(1);
  });
});
