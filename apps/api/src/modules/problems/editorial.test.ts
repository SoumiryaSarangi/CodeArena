import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { ContestRules } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contestProblems,
  contests,
  problemVersions,
  problems,
  reviews,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from './package';
import { ProblemImporter } from './problems.import';

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

const csrf = randomBytes(32).toString('base64url');
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const [P1, P2, P3] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .slice(0, 3) as [string, string, string];
const HOUR = 3_600_000;

describe.skipIf(!ready)(
  'AI-03 follow-up: editorials and the home reviews card (needs the Compose Postgres and S3)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;

    const makeUser = async (role: 'user' | 'setter' | 'admin' = 'user') => {
      const id = randomUUID();
      await db
        .insert(users)
        .values({ id, email: `${id}@example.test`, role, handle: `h${id.slice(0, 8)}` });
      const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
      return { id, token };
    };
    const get = (path: string, token?: string) => {
      const agent = request(app.getHttpServer());
      const r = agent.get(`/api${path}`);
      if (token) r.set('Authorization', `Bearer ${token}`);
      return r.set('Cookie', `ca_csrf=${csrf}`);
    };
    const versionOf = async (slug: string) =>
      (
        await db
          .select({
            id: problemVersions.id,
            problemId: problems.id,
            editorialMd: problemVersions.editorialMd,
          })
          .from(problems)
          .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
          .where(eq(problems.slug, slug))
      )[0]!;
    const makeContest = async (
      state: 'finalized' | 'ended' | 'running' | 'scheduled',
      owner: string,
      slugs: string[],
      title = 'Editorial contest',
    ) => {
      const [c] = await db
        .insert(contests)
        .values({
          slug: `ed-${randomBytes(4).toString('hex')}`,
          title,
          startsAt: new Date(Date.now() + (state === 'scheduled' ? HOUR : -3 * HOUR)),
          endsAt: new Date(
            Date.now() + (state === 'scheduled' ? 3 * HOUR : state === 'running' ? HOUR : -HOUR),
          ),
          rules: ContestRules.parse({}),
          status: state === 'finalized' ? 'finalized' : 'scheduled',
          createdBy: owner,
        })
        .returning({ id: contests.id, slug: contests.slug });
      for (const [i, slug] of slugs.entries()) {
        const v = await versionOf(slug);
        await db.insert(contestProblems).values({
          contestId: c!.id,
          label: 'ABC'[i]!,
          problemId: v.problemId,
          versionId: v.id,
          position: i,
        });
      }
      return c!;
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
      });
      app = await createApp(cfg);
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
      const importer = app.get(ProblemImporter);
      for (const slug of [P1, P2, P3]) {
        const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
        if (!r.ok) throw new Error(`${slug} rejected`);
        await importer.import(r.pkg, { visibility: 'public' });
      }
    });

    afterAll(async () => {
      await app?.close();
      await drop?.();
    });

    it('the editorial is hidden (404) until a contest that used the problem is finalised, and setters and admins always read it', async () => {
      const owner = await makeUser('admin');
      const user = await makeUser();
      const setter = await makeUser('setter');
      const v = await versionOf(P1);
      expect(v.editorialMd).toBeTruthy();
      for (const token of [undefined, user.token]) {
        expect((await get(`/problems/${P1}/editorial`, token)).status).toBe(404);
        expect((await get(`/problems/${P1}`, token)).body.hasEditorial).toBe(false);
      }
      for (const staff of [owner, setter]) {
        const r = await get(`/problems/${P1}/editorial`, staff.token);
        expect(r.status).toBe(200);
        expect(r.body.editorialMd).toBe(v.editorialMd);
        expect((await get(`/problems/${P1}`, staff.token)).body.hasEditorial).toBe(true);
      }
      // a contest that is only scheduled, running, or ended (not finalised) publishes nothing
      for (const state of ['scheduled', 'running', 'ended'] as const) {
        const c = await makeContest(state, owner.id, [P1]);
        expect((await get(`/problems/${P1}/editorial`, user.token)).status, state).toBe(404);
        await db.delete(contestProblems).where(eq(contestProblems.contestId, c.id));
        await db.delete(contests).where(eq(contests.id, c.id));
      }
    });

    it("once a contest is finalised its problems' editorials are public, to guests too; the answer has only the editorial", async () => {
      const owner = await makeUser('admin');
      const user = await makeUser();
      await makeContest('finalized', owner.id, [P1]);
      const v = await versionOf(P1);
      for (const token of [undefined, user.token]) {
        const r = await get(`/problems/${P1}/editorial`, token);
        expect(r.status).toBe(200);
        expect(Object.keys(r.body).sort()).toEqual(['editorialMd', 'slug', 'title', 'version']);
        expect(r.body.editorialMd).toBe(v.editorialMd);
        expect((await get(`/problems/${P1}`, token)).body.hasEditorial).toBe(true);
      }
      // another problem that no finalised contest used stays private
      expect((await get(`/problems/${P2}/editorial`, user.token)).status).toBe(404);
      expect((await get(`/problems/${P2}`, user.token)).body.hasEditorial).toBe(false);
    });

    it("a problem without an editorial has none for anyone, and a private problem's editorial stays private", async () => {
      const owner = await makeUser('admin');
      const user = await makeUser();
      await makeContest('finalized', owner.id, [P2, P3]);
      const v2 = await versionOf(P2);
      await db
        .update(problemVersions)
        .set({ editorialMd: null })
        .where(eq(problemVersions.id, v2.id));
      expect((await get(`/problems/${P2}/editorial`, owner.token)).status).toBe(404);
      expect((await get(`/problems/${P2}/editorial`, user.token)).status).toBe(404);
      expect((await get(`/problems/${P2}`, owner.token)).body.hasEditorial).toBe(false);
      await db
        .update(problems)
        .set({ visibility: 'private' })
        .where(eq(problems.id, (await versionOf(P3)).problemId));
      expect((await get(`/problems/${P3}/editorial`, user.token)).status).toBe(404);
      expect((await get(`/problems/${P3}/editorial`, owner.token)).status).toBe(200); // staff still read it
      expect((await get('/problems/no-such/editorial', user.token)).status).toBe(404);
    });

    it('home: my AI reviews card counts the written ones for the latest finalised contest I took part in', async () => {
      const owner = await makeUser('admin');
      const u = await makeUser();
      expect((await get('/me/home', u.token)).body.reviews).toBeNull();
      const older = await makeContest('finalized', owner.id, [P1], 'Older');
      await db
        .update(contests)
        .set({ endsAt: new Date(Date.now() - 48 * HOUR) })
        .where(eq(contests.id, older.id));
      const latest = await makeContest('finalized', owner.id, [P1, P2], 'Latest one');
      const v1 = await versionOf(P1);
      const v2 = await versionOf(P2);
      const sub = async (contestId: string, v: { id: string }) =>
        (
          await db
            .insert(submissions)
            .values({
              userId: u.id,
              problemVersionId: v.id,
              contestId,
              language: 'cpp17',
              source: 'x',
              sourceBytes: 1,
              lane: 'contest',
              status: 'done',
              verdict: 'WA',
            })
            .returning({ id: submissions.id })
        )[0]!.id;
      await db.insert(reviews).values({
        userId: u.id,
        contestId: older.id,
        problemId: v1.problemId,
        submissionId: await sub(older.id, v1),
        status: 'ready',
      });
      await db.insert(reviews).values({
        userId: u.id,
        contestId: latest.id,
        problemId: v1.problemId,
        submissionId: await sub(latest.id, v1),
        status: 'ready',
      });
      await db.insert(reviews).values({
        userId: u.id,
        contestId: latest.id,
        problemId: v2.problemId,
        submissionId: await sub(latest.id, v2),
        status: 'pending',
      });
      const home = await get('/me/home', u.token);
      expect(home.body.reviews).toEqual({
        contestSlug: latest.slug,
        contestTitle: 'Latest one',
        ready: 1,
        total: 2,
      });
      // someone else sees nothing of mine
      expect((await get('/me/home', (await makeUser()).token)).body.reviews).toBeNull();
    });
  },
);
