import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { loadConfig } from '../config/config';
import type { Db } from '../db/client';
import { contests, problemVersions, problems, users } from '../db/schema';
import { ResultsProcessor } from '../modules/submissions/results.processor';
import { createTestDatabase, postgresReachable } from '../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../modules/auth/keys';
import { parsePackage, readPackageDirectory } from '../modules/problems/package';
import { ProblemImporter } from '../modules/problems/problems.import';

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
const root = fileURLToPath(new URL('../../../../problems/', import.meta.url));
const [P1, P2] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .slice(0, 2) as [string, string];
const MIN = 60_000;

describe.skipIf(!ready)(
  'O-01: one submission, one trace (needs the Compose Postgres, Redis and S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let redis: Redis;
    let tokens: AccessTokens;
    let admin: { id: string; token: string };
    let c: { id: string; slug: string };
    let sdk: NodeSDK;
    const exporter = new InMemorySpanExporter();

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
    const times = (startIn: number, endIn: number) =>
      db
        .update(contests)
        .set({ startsAt: new Date(Date.now() + startIn), endsAt: new Date(Date.now() + endIn) })
        .where(eq(contests.id, c.id));
    beforeAll(async () => {
      // Real tracing for this file: context propagation needs the SDK's context manager.
      sdk = new NodeSDK({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      sdk.start();
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
              (
                await db.select({ id: problems.id }).from(problems).where(eq(problems.slug, slug))
              )[0]!.id,
            ),
          );
      }
      admin = await makeUser('admin');
      const slug = `t-${prefix.slice(0, -1)}`;
      const made = await call('post', '/admin/contests', admin.token, {
        slug,
        title: 'Trace',
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
      await sdk?.shutdown();
      const keys = redis ? await redis.keys(`${prefix}*`) : [];
      if (keys.length) await redis.del(...keys);
      redis?.disconnect();
      await drop?.();
    });

    it('NFR-OBS-01: a submission is one trace from the HTTP request to the board and the event', async () => {
      await times(-10 * MIN, 120 * MIN);
      const u = await makeUser();
      expect((await call('post', `/contests/${c.slug}/register`, u.token)).status).toBe(201);
      exporter.reset();
      const sub = await call('post', '/submissions', u.token, {
        contestSlug: c.slug,
        label: 'A',
        language: 'cpp17',
        source: 'int main(){}',
      });
      expect(sub.status, JSON.stringify(sub.body)).toBe(201);

      const spans = () => exporter.getFinishedSpans();
      const http = spans().find((s) => s.name === 'http POST /api/submissions')!;
      expect(
        http,
        spans()
          .map((s) => s.name)
          .join(', '),
      ).toBeDefined();
      const traceId = http.spanContext().traceId;
      const enqueue = spans().find((s) => s.name === 'queue.enqueue')!;
      expect(enqueue.spanContext().traceId).toBe(traceId);
      // Every ancestor of the enqueue span up to the root is in this trace, and the root is the request.
      const byId = new Map(spans().map((s) => [s.spanContext().spanId, s]));
      let top = enqueue;
      while (top.parentSpanContext && byId.has(top.parentSpanContext.spanId)) {
        top = byId.get(top.parentSpanContext.spanId)!;
      }
      expect(top.spanContext().spanId).toBe(http.spanContext().spanId);

      // The job carries the trace on to the worker.
      const [job] = (await redis.xrange(`${prefix}jobs:contest`, '-', '+')).map(
        ([, f]) =>
          JSON.parse(f[f.indexOf('job') + 1]!) as { traceparent: string; submissionId: string },
      );
      expect(job!.submissionId).toBe(sub.body.id);
      expect(job!.traceparent.split('-')[1]).toBe(traceId);
      expect(job!.traceparent.split('-')[2]).toBe(enqueue.spanContext().spanId);

      // The worker's result has no trace id; handling it rejoins the same trace.
      exporter.reset();
      const outcome = await app.get(ResultsProcessor).handle(
        JSON.stringify({
          submissionId: sub.body.id,
          runVersion: 1,
          verdict: 'AC',
          timeMs: 10,
          memKb: 1000,
          tests: [],
          workerId: 'w-test',
          finishedAt: Date.now(),
        }),
      );
      expect(outcome.kind).toBe('applied');
      const result = spans().find((s) => s.name === 'queue.result')!;
      expect(result.spanContext().traceId).toBe(traceId);
      expect(result.parentSpanContext?.spanId).toBe(enqueue.spanContext().spanId);
      const names = spans().map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(['board.update', 'sse.publish']));
      for (const s of spans()) expect(s.spanContext().traceId, s.name).toBe(traceId);
    });

    it('a result whose trace is unknown still gets handled, in a trace of its own', async () => {
      exporter.reset();
      const out = await app.get(ResultsProcessor).handle(
        JSON.stringify({
          submissionId: randomUUID(),
          runVersion: 1,
          verdict: 'AC',
          timeMs: 1,
          memKb: 1,
          tests: [],
          workerId: 'w',
          finishedAt: Date.now(),
        }),
      );
      expect(out.kind).toBe('parked');
      expect(exporter.getFinishedSpans().some((s) => s.name === 'queue.result')).toBe(true);
    });
  },
);
