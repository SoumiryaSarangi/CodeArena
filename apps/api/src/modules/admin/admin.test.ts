import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import {
  JudgeJob as JudgeJobSchema,
  type JudgeResult,
  type ValidationRun,
} from '@codearena/contracts';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  packageSolutions,
  problemVersions,
  problems,
  users,
  validationItems,
  validationRuns,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory, type PackageFiles } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';
import { buildTestset } from '../problems/testset';
import { ResultsProcessor } from '../submissions/results.processor';

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
const SLUG = 'hop-distances';
const SOLUTIONS = 7;

describe.skipIf(!ready)(
  'UI-04: setter/admin problem API (needs the Compose Postgres, Redis and S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let redis: Redis;
    let tokens: AccessTokens;
    let processor: ResultsProcessor;
    let importer: ProblemImporter;
    let pkgFiles: PackageFiles;

    const makeUser = async (role: 'user' | 'setter' | 'admin') => {
      const id = randomUUID();
      await db.insert(users).values({
        id,
        email: `${id}@example.test`,
        role,
        handle: `u${id.slice(0, 8)}`,
      });
      const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
      return { id, token };
    };
    const call = (method: 'get' | 'post' | 'patch', path: string, token?: string) => {
      const r = request(app.getHttpServer())[method](`/api${path}`);
      if (token) r.set('Authorization', `Bearer ${token}`);
      return r.set('Cookie', `ca_csrf=${csrf}`).set('X-CSRF-Token', csrf);
    };
    /** Uploads a package folder the way the web app does: one part per file, named by its path. */
    const upload = (token: string | undefined, files: PackageFiles, slug = SLUG, fold = false) => {
      const r = request(app.getHttpServer()).post('/api/admin/problems/packages');
      if (token) r.set('Authorization', `Bearer ${token}`);
      r.field('slug', slug);
      for (const [path, body] of files)
        r.attach(fold ? `${slug}/${path}` : path, body, path.split('/').pop()!);
      return r;
    };
    const without = (...paths: string[]) =>
      new Map([...pkgFiles].filter(([p]) => !paths.includes(p)));

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
      processor = app.get(ResultsProcessor);
      importer = app.get(ProblemImporter);
      pkgFiles = readPackageDirectory(`${root}${SLUG}`);
    });

    afterAll(async () => {
      await app?.close();
      redis?.disconnect();
      await drop?.();
    });

    it('FR-AUTH-09: guests get 401, users 403, setters and admins pass', async () => {
      const user = await makeUser('user');
      const setter = await makeUser('setter');
      const admin = await makeUser('admin');
      expect((await call('get', '/admin/problems')).status).toBe(401);
      expect((await call('get', '/admin/problems', user.token)).status).toBe(403);
      expect((await call('get', '/admin/problems', setter.token)).status).toBe(200);
      expect((await call('get', '/admin/problems', admin.token)).status).toBe(200);
      expect((await upload(user.token, pkgFiles)).status).toBe(403);
      expect((await upload(undefined, pkgFiles)).status).toBe(401);
    });

    describe('upload, versions, ownership', () => {
      let setter: { id: string; token: string };
      let other: { id: string; token: string };
      let admin: { id: string; token: string };
      let versionId = '';

      beforeAll(async () => {
        setter = await makeUser('setter');
        other = await makeUser('setter');
        admin = await makeUser('admin');
      });

      it('FR-PROB-01: a package folder becomes a private problem owned by the uploader; repeating it changes nothing', async () => {
        const res = await upload(setter.token, pkgFiles);
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ outcome: 'created', slug: SLUG, version: 1 });
        versionId = res.body.versionId;
        const [row] = await db.select().from(problems).where(eq(problems.slug, SLUG));
        expect(row).toMatchObject({ authorId: setter.id, visibility: 'private' });
        const again = await upload(setter.token, pkgFiles);
        expect(again.body).toMatchObject({ outcome: 'unchanged', version: 1 });
        // A dragged folder arrives as `<slug>/problem.yaml`: the same package.
        expect((await upload(setter.token, pkgFiles, SLUG, true)).body.outcome).toBe('unchanged');
      });

      it('FR-PROB-04: the validator is stored with the version', async () => {
        const [v] = await db
          .select()
          .from(problemVersions)
          .where(eq(problemVersions.id, versionId));
        expect(v!.validatorUri).toMatch(
          new RegExp(`^s3://${config.S3_BUCKET_TESTS}/validators/[0-9a-f]{64}\\.cpp$`),
        );
      });

      it('FR-PROB-01: a broken package is refused with every problem listed by path', async () => {
        const res = await upload(
          setter.token,
          without('validator.cpp', 'tests/03.ans'),
          'broken-one',
        );
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid-package');
        const paths = res.body.errors.map((e: { path: string }) => e.path);
        expect(paths).toEqual(expect.arrayContaining(['validator.cpp', 'tests/03.in']));
      });

      it('FR-PROB-01: slugs and paths are checked; nothing escapes the package', async () => {
        const badSlug = await upload(setter.token, pkgFiles, 'Not A Slug');
        expect(badSlug.status).toBe(422);
        expect(badSlug.body.errors[0].path).toBe('slug');
        const evil = new Map(pkgFiles);
        evil.set('../outside.txt', Buffer.from('x'));
        const res = await upload(setter.token, evil, 'hop-evil');
        expect(res.status).toBe(422);
        expect(res.body.errors[0].message).toMatch(/valid package-relative path/);
        expect((await db.select().from(problems).where(eq(problems.slug, 'hop-evil'))).length).toBe(
          0,
        );
      });

      it('FR-PROB-01: a single file over 50 MB is refused with 413', async () => {
        const big = new Map(pkgFiles);
        big.set('tests/50.in', Buffer.alloc(51 * 1024 * 1024, 49));
        const res = await upload(setter.token, big, 'hop-big');
        expect(res.status).toBe(413);
      });

      it('a setter lists only their own problems; an admin sees all', async () => {
        const mine = await call('get', '/admin/problems', setter.token);
        expect(mine.body.items.map((p: { slug: string }) => p.slug)).toEqual([SLUG]);
        expect(mine.body.items[0]).toMatchObject({
          mine: true,
          version: 1,
          validationStatus: 'pending',
        });
        expect((await call('get', '/admin/problems', other.token)).body.items).toEqual([]);
        const all = await call('get', '/admin/problems', admin.token);
        expect(all.body.items.map((p: { slug: string }) => p.slug)).toContain(SLUG);
      });

      it('FR-AUTH-09: another setter cannot read, change, test or validate it; an admin can', async () => {
        expect((await call('get', `/admin/problems/${SLUG}`, other.token)).status).toBe(403);
        expect((await upload(other.token, pkgFiles)).status).toBe(403);
        expect(
          (
            await call('patch', `/admin/problems/${SLUG}/statement`, other.token).send({
              statementMd: '# T\n## Input\n## Output\n## Notes\n',
              editorialMd: '',
            })
          ).status,
        ).toBe(403);
        expect(
          (await call('get', `/admin/problem-versions/${versionId}/tests`, other.token)).status,
        ).toBe(403);
        expect(
          (await call('post', `/admin/problem-versions/${versionId}/validate`, other.token)).status,
        ).toBe(403);
        expect((await call('get', `/admin/problems/${SLUG}`, admin.token)).status).toBe(200);
      });

      it('a problem imported from the CLI (no author) is for admins only', async () => {
        const parsed = parsePackage(
          'sum-two-numbers',
          readPackageDirectory(`${root}sum-two-numbers`),
        );
        if (!parsed.ok) throw new Error('fixture rejected');
        await importer.import(parsed.pkg);
        expect((await call('get', '/admin/problems/sum-two-numbers', setter.token)).status).toBe(
          403,
        );
        expect((await call('get', '/admin/problems/sum-two-numbers', admin.token)).status).toBe(
          200,
        );
      });

      it('the detail has the statement, limits, solutions and whether a validator is stored', async () => {
        const res = await call('get', `/admin/problems/${SLUG}`, setter.token);
        expect(res.status).toBe(200);
        expect(res.body.current).toMatchObject({
          version: 1,
          validatorStored: true,
          limits: { timeMs: 500 },
          checker: { kind: 'tokens' },
        });
        expect(res.body.current.statementMd).toMatch(/^# /);
        expect(res.body.current.solutions).toHaveLength(SOLUTIONS);
        expect(res.body.versions).toHaveLength(1);
      });

      it('FR-PROB-02: an edited statement is a new version with the same tests, solutions and validation state', async () => {
        const detail = (await call('get', `/admin/problems/${SLUG}`, setter.token)).body;
        const before = (
          await db.select().from(problemVersions).where(eq(problemVersions.id, versionId))
        )[0]!;
        await db
          .update(problemVersions)
          .set({ validationStatus: 'passed', validatedAt: new Date() })
          .where(eq(problemVersions.id, versionId));
        const md = `${detail.current.statementMd}\n\nAn added remark.\n`;
        const res = await call('patch', `/admin/problems/${SLUG}/statement`, setter.token).send({
          statementMd: md,
          editorialMd: 'New editorial.',
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ outcome: 'new-version', version: 2 });
        const [v2] = await db
          .select()
          .from(problemVersions)
          .where(eq(problemVersions.id, res.body.versionId));
        expect(v2).toMatchObject({
          version: 2,
          testsetHash: before.testsetHash,
          testsetUri: before.testsetUri,
          validatorUri: before.validatorUri,
          validationStatus: 'passed',
          statementMd: md,
          editorialMd: 'New editorial.',
        });
        expect(
          await db.select().from(packageSolutions).where(eq(packageSolutions.versionId, v2!.id)),
        ).toHaveLength(SOLUTIONS);
        const [p] = await db.select().from(problems).where(eq(problems.slug, SLUG));
        expect(p!.currentVersionId).toBe(v2!.id);
        // Saving the same text again is not a new version.
        const same = await call('patch', `/admin/problems/${SLUG}/statement`, setter.token).send({
          statementMd: md,
          editorialMd: 'New editorial.',
        });
        expect(same.body).toMatchObject({ outcome: 'unchanged', version: 2 });
      });

      it('FR-PROB-07: a statement without its sections, or with a script, is refused', async () => {
        const bad = await call('patch', `/admin/problems/${SLUG}/statement`, setter.token).send({
          statementMd: 'no heading',
          editorialMd: '',
        });
        expect(bad.status).toBe(400);
        expect(bad.body.errors.length).toBeGreaterThanOrEqual(2);
        const xss = await call('patch', `/admin/problems/${SLUG}/statement`, setter.token).send({
          statementMd: '# T\n## Input\n## Output\n## Notes\n<script>alert(1)</script>\n',
          editorialMd: '',
        });
        expect(xss.status).toBe(400);
        expect(JSON.stringify(xss.body.errors)).toMatch(/raw HTML or script/);
      });

      it('FR-PROB-06: tests are listed and downloaded only by the setter or an admin, never cached', async () => {
        const [cur] = await db.select().from(problems).where(eq(problems.slug, SLUG));
        const vid = cur!.currentVersionId!;
        const list = await call('get', `/admin/problem-versions/${vid}/tests`, setter.token);
        expect(list.status).toBe(200);
        expect(list.body.items).toHaveLength(10);
        expect(list.body.items[0]).toMatchObject({ no: 1, sample: true });
        expect(list.body.items[9]).toMatchObject({ no: 10, sample: false });
        const want = pkgFiles.get('tests/01.in')!;
        expect(list.body.items[0].inBytes).toBe(want.length);

        const file = await call('get', `/admin/problem-versions/${vid}/tests/01.in`, setter.token)
          .buffer(true)
          .parse(binary);
        expect(file.status).toBe(200);
        expect(file.headers['cache-control']).toBe('no-store');
        expect(Buffer.compare(file.body as Buffer, want)).toBe(0);

        const tar = await call('get', `/admin/problem-versions/${vid}/tests.tar`, admin.token)
          .buffer(true)
          .parse(binary);
        expect(tar.status).toBe(200);
        expect(tar.headers['cache-control']).toBe('no-store');
        const tests = parsePackageTests(pkgFiles);
        expect(
          createHash('sha256')
            .update(tar.body as Buffer)
            .digest('hex'),
        ).toBe(buildTestset(tests).hash);

        expect(
          (await call('get', `/admin/problem-versions/${vid}/tests`, other.token)).status,
        ).toBe(403);
        expect(
          (await call('get', `/admin/problem-versions/${vid}/tests/01.in`, other.token)).status,
        ).toBe(403);
        expect(
          (await call('get', `/admin/problem-versions/${vid}/tests.tar`, other.token)).status,
        ).toBe(403);
        expect(
          (await call('get', `/admin/problem-versions/${vid}/tests/..%2F01.in`, setter.token))
            .status,
        ).toBe(404);
        expect(
          (await call('get', `/admin/problem-versions/${vid}/tests/77.in`, setter.token)).status,
        ).toBe(404);
        expect(
          (await call('get', '/admin/problem-versions/not-a-uuid/tests', setter.token)).status,
        ).toBe(404);
      });

      it('visibility is an admin decision', async () => {
        const denied = await call('patch', `/admin/problems/${SLUG}/visibility`, setter.token).send(
          { visibility: 'public' },
        );
        expect(denied.status).toBe(403);
        const ok = await call('patch', `/admin/problems/${SLUG}/visibility`, admin.token).send({
          visibility: 'public',
        });
        expect(ok.status).toBe(200);
        const listed = await call('get', '/problems');
        expect(listed.body.items.map((p: { slug: string }) => p.slug)).toContain(SLUG);
        await call('patch', `/admin/problems/${SLUG}/visibility`, admin.token).send({
          visibility: 'private',
        });
        expect(
          (await call('get', '/problems')).body.items.map((p: { slug: string }) => p.slug),
        ).not.toContain(SLUG);
        expect(
          (
            await call('patch', `/admin/problems/${SLUG}/visibility`, admin.token).send({
              visibility: 'secret',
            })
          ).status,
        ).toBe(400);
      });
    });

    describe('validation runs', () => {
      let setter: { id: string; token: string };
      let admin: { id: string; token: string };
      let vid = '';
      let runId = '';
      let items: { id: string; kind: string; name: string; expected: string | null }[] = [];

      const itemsOf = async (run: string) =>
        (await db.select().from(validationItems).where(eq(validationItems.runId, run))).map(
          (i) => ({
            id: i.id,
            kind: i.kind,
            name: i.name,
            expected: i.expectedVerdict,
          }),
        );
      const answer = (
        id: string,
        verdict: string,
        extra: Partial<JudgeResult> = {},
      ): JudgeResult => ({
        submissionId: id,
        runVersion: 1,
        verdict: verdict as JudgeResult['verdict'],
        timeMs: 12,
        memKb: 2048,
        tests: [{ no: 1, verdict: verdict as JudgeResult['verdict'], timeMs: 12, memKb: 2048 }],
        workerId: 'w1',
        finishedAt: Date.now(),
        ...extra,
      });
      const feed = (r: JudgeResult) => processor.handle(JSON.stringify(r));

      beforeAll(async () => {
        setter = await makeUser('setter');
        admin = await makeUser('admin');
        const res = await upload(setter.token, pkgFiles, 'hop-validate');
        // The slug of the folder differs from the package's directory name only in this test.
        expect(res.status).toBe(201);
        vid = res.body.versionId;
      });

      it('FR-PROB-04: Validate sends one job per solution plus one for the validator, on the rejudge lane', async () => {
        const res = await call('post', `/admin/problem-versions/${vid}/validate`, setter.token);
        expect(res.status).toBe(201);
        const run = res.body as ValidationRun;
        runId = run.id;
        expect(run.status).toBe('running');
        expect(run.items).toHaveLength(SOLUTIONS + 1);
        expect(run.items.at(-1)).toMatchObject({
          kind: 'validator',
          name: 'validator.cpp',
          expected: 'AC',
          status: 'queued',
        });

        items = await itemsOf(runId);
        const entries = (await redis.xrange(`${prefix}jobs:rejudge`, '-', '+')).map(([, f]) =>
          JudgeJobSchema.parse(JSON.parse(f[1]!)),
        );
        expect(entries).toHaveLength(SOLUTIONS + 1);
        const ids = new Set(items.map((i) => i.id));
        for (const j of entries) {
          expect(ids.has(j.submissionId)).toBe(true);
          expect(j.lane).toBe('rejudge');
          expect(j.stopOnFirstFailure).toBe(false);
          expect(j.problem.testsetUri).toMatch(/^s3:\/\/.+\/testsets\/[0-9a-f]{64}\.tar$/);
        }
        const validatorJob = entries.find((j) => j.mode === 'validate')!;
        expect(validatorJob.language).toBe('cpp17');
        expect(validatorJob.source).toBe(pkgFiles.get('validator.cpp')!.toString('utf8'));
        expect(entries.filter((j) => j.mode === 'submit')).toHaveLength(SOLUTIONS);
        const alt = entries.find((j) => j.language === 'python3')!;
        expect(alt.source).toBe(pkgFiles.get('solutions/alt.py')!.toString('utf8'));
        const [v] = await db.select().from(problemVersions).where(eq(problemVersions.id, vid));
        expect(v!.validationStatus).toBe('running');
      });

      it('only one run per version at a time', async () => {
        const res = await call('post', `/admin/problem-versions/${vid}/validate`, setter.token);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation');
      });

      it('FR-PROB-04: every verdict as expected marks the run ok and the version passed; a replay changes nothing', async () => {
        for (const i of items) {
          const first = await feed(answer(i.id, i.expected ?? 'AC'));
          expect(first.kind).toBe('validation');
        }
        const run = (await call('get', `/admin/validation-runs/${runId}`, setter.token))
          .body as ValidationRun;
        expect(run).toMatchObject({ status: 'done', ok: true });
        expect(run.items.every((i) => i.ok === true && i.actual === i.expected)).toBe(true);
        const [v] = await db.select().from(problemVersions).where(eq(problemVersions.id, vid));
        expect(v!.validationStatus).toBe('passed');
        expect(v!.validatedAt).not.toBeNull();
        const replay = await feed(answer(items[0]!.id, 'WA'));
        expect(replay.kind).toBe('duplicate');
        const after = (await call('get', `/admin/validation-runs/${runId}`, admin.token))
          .body as ValidationRun;
        expect(after.items[0]!.actual).toBe(run.items[0]!.actual);
      });

      it('FR-PROB-04: a wrong verdict or a validator that rejects an input fails the run and the version', async () => {
        await db
          .update(validationRuns)
          .set({ createdAt: new Date(Date.now() - 3600_000) })
          .where(eq(validationRuns.id, runId));
        const res = await call('post', `/admin/problem-versions/${vid}/validate`, setter.token);
        expect(res.status).toBe(201);
        const second = await itemsOf(res.body.id);
        for (const i of second) {
          if (i.kind === 'validator') {
            await feed(
              answer(i.id, 'WA', {
                tests: [
                  { no: 1, verdict: 'AC', timeMs: 0, memKb: 0 },
                  {
                    no: 4,
                    verdict: 'WA',
                    timeMs: 0,
                    memKb: 0,
                    checkerMsg: 'n = 0 violates the range [1, 50000]',
                  },
                ],
              }),
            );
          } else if (i.name === 'main.cpp') {
            await feed(answer(i.id, 'WA')); // expected AC
          } else {
            await feed(answer(i.id, i.expected ?? 'AC'));
          }
        }
        const run = (await call('get', `/admin/validation-runs/${res.body.id}`, setter.token))
          .body as ValidationRun;
        expect(run).toMatchObject({ status: 'done', ok: false });
        const main = run.items.find((i) => i.name === 'main.cpp')!;
        expect(main).toMatchObject({ expected: 'AC', actual: 'WA', ok: false });
        const validator = run.items.find((i) => i.kind === 'validator')!;
        expect(validator).toMatchObject({ actual: 'WA', ok: false });
        expect(validator.failedTests).toEqual([
          { no: 4, verdict: 'WA', message: 'n = 0 violates the range [1, 50000]' },
        ]);
        const [v] = await db.select().from(problemVersions).where(eq(problemVersions.id, vid));
        expect(v!.validationStatus).toBe('failed');
      });

      it('FR-PROB-04: a compile error is shown with its log', async () => {
        const [r] = await db
          .select()
          .from(validationRuns)
          .orderBy(validationRuns.createdAt)
          .limit(1);
        await db
          .update(validationRuns)
          .set({ createdAt: new Date(Date.now() - 3600_000) })
          .where(eq(validationRuns.versionId, r!.versionId));
        const res = await call('post', `/admin/problem-versions/${vid}/validate`, setter.token);
        const third = await itemsOf(res.body.id);
        for (const i of third) {
          await feed(
            i.kind === 'validator'
              ? answer(i.id, 'CE', {
                  tests: [],
                  compileLog: "validator.cpp:1: error: expected ';'",
                })
              : answer(i.id, i.expected ?? 'AC'),
          );
        }
        const run = (await call('get', `/admin/validation-runs/${res.body.id}`, setter.token))
          .body as ValidationRun;
        expect(run.items.find((i) => i.kind === 'validator')).toMatchObject({
          actual: 'CE',
          ok: false,
          message: "validator.cpp:1: error: expected ';'",
        });
      });

      it('a judge that never answers: the run is failed when read, the version is not marked failed', async () => {
        const [r0] = await db
          .select()
          .from(validationRuns)
          .where(eq(validationRuns.versionId, vid))
          .orderBy(validationRuns.createdAt);
        await db
          .update(validationRuns)
          .set({ createdAt: new Date(Date.now() - 3600_000) })
          .where(eq(validationRuns.versionId, r0!.versionId));
        const res = await call('post', `/admin/problem-versions/${vid}/validate`, setter.token);
        expect(res.status).toBe(201);
        await db
          .update(validationRuns)
          .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
          .where(eq(validationRuns.id, res.body.id));
        await db
          .update(validationItems)
          .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
          .where(eq(validationItems.runId, res.body.id));
        const run = (await call('get', `/admin/validation-runs/${res.body.id}`, setter.token))
          .body as ValidationRun;
        expect(run.status).toBe('failed');
        expect(run.ok).toBe(false);
        expect(
          run.items.every((i) => i.status === 'failed' && /did not answer/.test(i.message ?? '')),
        ).toBe(true);
        const [v] = await db.select().from(problemVersions).where(eq(problemVersions.id, vid));
        expect(v!.validationStatus).toBe('pending');
      });

      it('FR-AUTH-09: runs are visible to their problem owner and admins only', async () => {
        const stranger = await makeUser('setter');
        expect((await call('get', `/admin/validation-runs/${runId}`, stranger.token)).status).toBe(
          403,
        );
        expect((await call('get', '/admin/validation-runs/not-a-uuid', setter.token)).status).toBe(
          404,
        );
        expect(
          (await call('get', `/admin/validation-runs/${randomUUID()}`, setter.token)).status,
        ).toBe(404);
      });

      it('a version imported before validators were stored cannot be validated until it is uploaded again', async () => {
        await db
          .update(problemVersions)
          .set({ validatorUri: null })
          .where(eq(problemVersions.id, vid));
        await db
          .update(validationRuns)
          .set({ createdAt: new Date(Date.now() - 3600_000) })
          .where(eq(validationRuns.versionId, vid));
        const res = await call('post', `/admin/problem-versions/${vid}/validate`, setter.token);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid-package');
        expect(res.body.detail).toMatch(/Upload the package again/);
        // Uploading identical content backfills the validator without a new version.
        const again = await upload(setter.token, pkgFiles, 'hop-validate');
        expect(again.body).toMatchObject({ outcome: 'unchanged', version: 1 });
        const [v] = await db.select().from(problemVersions).where(eq(problemVersions.id, vid));
        expect(v!.validatorUri).not.toBeNull();
      });
    });
  },
);

const binaryParser = (
  res: NodeJS.ReadableStream,
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** supertest's parser type is the union of two shapes; this is the (stream, callback) one. */
const binary = binaryParser as unknown as Parameters<request.Test['parse']>[0];

/** The tests of a package folder in the shape `buildTestset` takes. */
function parsePackageTests(files: PackageFiles) {
  const tests: { no: number; in: Buffer; ans: Buffer }[] = [];
  for (let n = 1; files.has(`tests/${String(n).padStart(2, '0')}.in`); n++) {
    const p = String(n).padStart(2, '0');
    tests.push({ no: n, in: files.get(`tests/${p}.in`)!, ans: files.get(`tests/${p}.ans`)! });
  }
  return tests;
}
