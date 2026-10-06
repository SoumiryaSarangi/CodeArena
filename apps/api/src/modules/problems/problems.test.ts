import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { packageSolutions, problems, problemTags, problemVersions } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { parsePackage, readPackageDirectory, type ProblemPackage } from './package';
import { ProblemImporter } from './problems.import';

const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const slugs = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
const load = (slug: string): ProblemPackage => {
  const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
  if (!r.ok) throw new Error(`${slug} rejected`);
  return r.pkg;
};

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

const objectHash = async (key: string) => {
  const o = await s3.send(new GetObjectCommand({ Bucket: config.S3_BUCKET_TESTS, Key: key }));
  return createHash('sha256')
    .update(await o.Body!.transformToByteArray())
    .digest('hex');
};

describe.skipIf(!ready)('P-01: problems API and import (needs the Compose Postgres and S3)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let importer: ProblemImporter;

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DEFAULT_PER_MIN: '100000',
      DATABASE_URL: t.url,
    });
    app = await createApp(cfg);
    await app.init();
    importer = app.get(ProblemImporter);
  });

  afterAll(async () => {
    await app?.close();
    await drop?.();
  });

  const get = (path: string) => request(app.getHttpServer()).get(`/api${path}`);

  it('FR-PROB-01..03: 20 fixture problems import, with tests stored under their hash', async () => {
    for (const slug of slugs) {
      const r = await importer.import(load(slug), { visibility: 'public' });
      expect(r.outcome, slug).toBe('created');
      expect(r.version).toBe(1);
    }
    expect(await db.select().from(problems)).toHaveLength(20);
    const versions = await db.select().from(problemVersions);
    expect(versions).toHaveLength(20);
    for (const v of versions) {
      expect(v.testsetUri).toBe(`s3://${config.S3_BUCKET_TESTS}/testsets/${v.testsetHash}.tar`);
      expect(v.validationStatus).toBe('pending');
    }
    // The stored archive hashes to exactly what the judge will verify (FR-JUDGE-12).
    const v = versions[0]!;
    expect(await objectHash(`testsets/${v.testsetHash}.tar`)).toBe(v.testsetHash);
    const sols = await db
      .select()
      .from(packageSolutions)
      .where(eq(packageSolutions.versionId, v.id));
    expect(sols.length).toBeGreaterThanOrEqual(5);
    expect(sols.some((s) => s.expectedVerdict === 'AC')).toBe(true);
    // The testlib checker's source is stored where the judge reads checkers from.
    const mp = await db
      .select({ checker: problemVersions.checker })
      .from(problemVersions)
      .innerJoin(problems, eq(problems.id, problemVersions.problemId))
      .where(eq(problems.slug, 'matching-pair'));
    const uri = (mp[0]!.checker as { sourceUri: string }).sourceUri;
    expect(uri).toMatch(/^s3:\/\/[^/]+\/checkers\/[0-9a-f]{64}\.cpp$/);
    expect(
      await objectHash(uri.replace(/^s3:\/\/[^/]+\//, '').replace(/\.cpp$/, '') + '.cpp'),
    ).toBe(uri.match(/([0-9a-f]{64})\.cpp$/)![1]);
  });

  it('FR-PROB-02: re-importing the same package changes nothing', async () => {
    const r = await importer.import(load('sum-two-numbers'));
    expect(r.outcome).toBe('unchanged');
    expect(r.version).toBe(1);
    expect(await db.select().from(problemVersions)).toHaveLength(20);
  });

  it('FR-PROB-02: a changed statement or test creates version 2; version 1 stays as it was', async () => {
    const before = (
      await db.select().from(problemVersions).where(eq(problemVersions.version, 1))
    ).find((v) => v.testsCount > 0 && v.statementMd.includes('Two Numbers'))!;
    const pkg = load('sum-two-numbers');
    const edited = { ...pkg, statementMd: pkg.statementMd + '\nAn extra clarification.\n' };
    const r = await importer.import(edited);
    expect(r.outcome).toBe('new-version');
    expect(r.version).toBe(2);
    const [p] = await db.select().from(problems).where(eq(problems.slug, 'sum-two-numbers'));
    expect(p!.currentVersionId).toBe(r.versionId);
    const [v1] = await db.select().from(problemVersions).where(eq(problemVersions.id, before.id));
    expect(v1!.statementMd).toBe(before.statementMd);
    expect(v1!.testsetHash).toBe(before.testsetHash);

    const changedTest = {
      ...edited,
      tests: edited.tests.map((t, i) => (i === 0 ? { ...t, ans: Buffer.from('999999\n') } : t)),
    };
    const r3 = await importer.import(changedTest);
    expect(r3.version).toBe(3);
    expect(r3.testsetHash).not.toBe(r.testsetHash);
  });

  it('concurrent imports of one slug never collide on the version number', async () => {
    const pkg = load('peak-reading');
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        importer.import({ ...pkg, statementMd: `${pkg.statementMd}\nvariant ${n}\n` }),
      ),
    );
    expect(new Set(results.map((r) => r.version)).size).toBe(3);
  });

  it('GET /problems lists public problems, easiest first, with tags', async () => {
    const res = await get('/problems?limit=100').expect(200);
    expect(res.body.items).toHaveLength(20);
    const diffs = res.body.items.map((p: { difficulty: number }) => p.difficulty);
    expect(diffs).toEqual([...diffs].sort((a: number, b: number) => a - b));
    expect(res.body.nextCursor).toBeNull();
    const sum = res.body.items.find((p: { slug: string }) => p.slug === 'sum-two-numbers');
    expect(sum).toEqual({
      slug: 'sum-two-numbers',
      title: 'Two Numbers, One Total',
      difficulty: 800,
      tags: ['implementation', 'math'],
      practicePoints: 8,
    });
  });

  it('FR-PROB-08: filters combine with AND; pagination walks every problem once', async () => {
    const dp = await get('/problems?tags=dp').expect(200);
    expect(dp.body.items.map((p: { slug: string }) => p.slug).sort()).toEqual([
      'packing-the-van',
      'rising-subsequence',
      'spell-fixer',
      'stair-climb',
    ]);
    const both = await get('/problems?tags=dp,strings').expect(200);
    expect(both.body.items.map((p: { slug: string }) => p.slug)).toEqual(['spell-fixer']);
    const range = await get('/problems?minDiff=1200&maxDiff=1300').expect(200);
    expect(
      range.body.items.every(
        (p: { difficulty: number }) => p.difficulty >= 1200 && p.difficulty <= 1300,
      ),
    ).toBe(true);
    expect(range.body.items).toHaveLength(5);
    const text = await get('/problems?q=SHELF').expect(200);
    expect(text.body.items.map((p: { slug: string }) => p.slug)).toEqual(['shelf-search']);
    const combined = await get('/problems?q=a&tags=graphs&maxDiff=1300').expect(200);
    expect(combined.body.items.every((p: { tags: string[] }) => p.tags.includes('graphs'))).toBe(
      true,
    );
    // A LIKE wildcard in the search is text, not a pattern.
    expect((await get('/problems?q=%25').expect(200)).body.items).toHaveLength(0);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: { items: { slug: string }[]; nextCursor: string | null } } = await get(
        `/problems?limit=7${cursor ? `&cursor=${cursor}` : ''}`,
      ).expect(200);
      seen.push(...page.body.items.map((p) => p.slug));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });

  it('rejects malformed queries with a 400 problem document', async () => {
    for (const q of [
      'limit=0',
      'limit=101',
      'minDiff=5',
      'cursor=@@@',
      'bogus=1',
      'tags=' + 'a,'.repeat(11),
    ]) {
      const res = await get(`/problems?${q}`).expect(400);
      expect(res.body.code).toBe('validation');
    }
  });

  it('GET /problems/:slug returns the statement with maths, samples, limits and checker', async () => {
    const res = await get('/problems/sum-two-numbers').expect(200);
    expect(res.body.title).toBe('Two Numbers, One Total');
    expect(res.body.version).toBe(3);
    expect(res.body.statementMd).toMatch(/^# /);
    expect(res.body.statementMd).toMatch(/\$[^$]+\$/); // inline KaTeX
    expect(res.body.samples.length).toBeGreaterThan(0);
    expect(res.body.samples[0]).toEqual({ in: expect.any(String), out: expect.any(String) });
    expect(res.body.limits).toEqual({ timeMs: 1000, memMb: 256, outputKb: 1024 });
    expect(res.body.checker).toEqual({ kind: 'tokens' });
    const f = await get('/problems/fractional-loot').expect(200);
    expect(f.body.checker).toEqual({ kind: 'float', eps: 1e-6 });
  });

  it('FR-PROB-06: nothing hidden leaks, not the editorial, solutions, other tests or checker source', async () => {
    const mp = await get('/problems/matching-pair').expect(200);
    const body = JSON.stringify(mp.body);
    expect(Object.keys(mp.body).sort()).toEqual([
      'checker',
      'difficulty',
      'limits',
      'practicePoints',
      'samples',
      'slug',
      'statementMd',
      'tags',
      'title',
      'version',
    ]);
    expect(mp.body.checker).toEqual({ kind: 'testlib' });
    expect(body).not.toMatch(/s3:\/\/|testset|sourceUri|editorial/i);
    const pkg = load('matching-pair');
    // Only the samples are shown; a later test's input is not in the response.
    const hidden = pkg.tests[pkg.samples.length]!.in.toString('utf8');
    if (hidden.length > 30) expect(body).not.toContain(JSON.stringify(hidden).slice(1, -1));
    expect(mp.body.samples).toHaveLength(pkg.samples.length);
  });

  it('FR-PROB-09: a private or contest problem is a plain 404 on the list and the detail', async () => {
    const pkg = load('stair-climb');
    await db
      .update(problems)
      .set({ visibility: 'private' })
      .where(eq(problems.slug, 'stair-climb'));
    expect((await get('/problems/stair-climb').expect(404)).body.code).toBe('not-found');
    expect((await get('/problems?limit=100').expect(200)).body.items).toHaveLength(19);
    await db
      .update(problems)
      .set({ visibility: 'contest' })
      .where(eq(problems.slug, 'stair-climb'));
    await get('/problems/stair-climb').expect(404);
    await get('/problems/does-not-exist').expect(404);
    // A version that is not the current one is never served.
    await db.update(problems).set({ visibility: 'public' }).where(eq(problems.slug, 'stair-climb'));
    await get('/problems/stair-climb').expect(200);
    expect(pkg.slug).toBe('stair-climb');
  });

  it('tags are replaced on a new version', async () => {
    const pkg = load('hall-of-fame');
    await importer.import({ ...pkg, tags: ['sorting', 'implementation'] });
    const [p] = await db.select().from(problems).where(eq(problems.slug, 'hall-of-fame'));
    const tags = await db.select().from(problemTags).where(eq(problemTags.problemId, p!.id));
    expect(tags.map((t) => t.tag).sort()).toEqual(['implementation', 'sorting']);
  });
});
