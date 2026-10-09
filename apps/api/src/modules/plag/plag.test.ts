import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContestRules } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  auditLog,
  contestProblems,
  contests,
  plagClusters,
  plagPairs,
  editorSignals,
  plagRuns,
  problemVersions,
  reviewDecisions,
  problems,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { parsePackage, readPackageDirectory } from '../problems/package';
import { ProblemImporter } from '../problems/problems.import';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const ready = await postgresReachable();
const csrf = randomBytes(32).toString('base64url');
const TOKEN = randomBytes(24).toString('hex');
const root = fileURLToPath(new URL('../../../../../problems/', import.meta.url));
const [P1, P2] = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .slice(0, 2) as [string, string];
const HOUR = 3_600_000;
const uuid = () => randomUUID();

describe.skipIf(!ready)('PL-05: the plagiarism job API (needs the Compose Postgres and S3)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let tokens: AccessTokens;
  let admin: { id: string; token: string };
  let clusterUnderReview: { id: string; runId: string; subs: string[] } | null = null;

  const makeUser = async (role: 'user' | 'admin' = 'user') => {
    const id = randomUUID();
    await db
      .insert(users)
      .values({ id, email: `${id}@example.test`, role, handle: `u${id.slice(0, 8)}` });
    const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
    return { id, token, email: `${id}@example.test`, handle: `u${id.slice(0, 8)}` };
  };
  const call = (
    method: 'get' | 'post',
    path: string,
    opts: { bearer?: string; service?: string | null; body?: unknown } = {},
  ) => {
    const agent = request(app.getHttpServer());
    const r = agent[method](`/api${path}`);
    if (opts.bearer) r.set('Authorization', `Bearer ${opts.bearer}`);
    if (opts.service !== null) r.set('X-Service-Token', opts.service ?? TOKEN);
    r.set('Cookie', `ca_csrf=${csrf}`);
    if (opts.bearer) r.set('X-CSRF-Token', csrf);
    return opts.body === undefined ? r : r.send(opts.body as object);
  };
  const adminCall = (method: 'get' | 'post', path: string, body?: unknown) =>
    call(method, path, { bearer: admin.token, service: null, body });
  const job = (path: string, body?: unknown, service: string | null = TOKEN) =>
    call('post', path, { service, body: body ?? {} });

  const versionOf = async (slug: string) =>
    (
      await db
        .select({ id: problemVersions.id, problemId: problems.id })
        .from(problems)
        .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
        .where(eq(problems.slug, slug))
    )[0]!;
  const makeContest = async (state: 'ended' | 'running' | 'draft' | 'finalized' = 'ended') => {
    const [c] = await db
      .insert(contests)
      .values({
        slug: `pl-${randomBytes(4).toString('hex')}`,
        title: 'Plag contest',
        startsAt: new Date(Date.now() - 3 * HOUR),
        endsAt: new Date(Date.now() + (state === 'running' ? HOUR : -HOUR)),
        rules: ContestRules.parse({}),
        status: state === 'draft' ? 'draft' : state === 'finalized' ? 'finalized' : 'scheduled',
        createdBy: admin.id,
      })
      .returning({ id: contests.id, slug: contests.slug });
    for (const [i, slug] of [P1, P2].entries()) {
      const v = await versionOf(slug);
      await db.insert(contestProblems).values({
        contestId: c!.id,
        label: 'AB'[i]!,
        problemId: v.problemId,
        versionId: v.id,
        position: i,
      });
    }
    return c!;
  };
  const sub = async (
    contestId: string,
    userId: string,
    slug: string,
    source: string,
    over: Partial<typeof submissions.$inferInsert> = {},
  ) => {
    const v = await versionOf(slug);
    const [s] = await db
      .insert(submissions)
      .values({
        userId,
        problemVersionId: v.id,
        contestId,
        language: 'cpp17',
        source,
        sourceBytes: source.length,
        lane: 'contest',
        status: 'done',
        verdict: 'WA',
        judgedAt: new Date(),
        ...over,
      })
      .returning({ id: submissions.id });
    return s!.id;
  };
  const drain = async () => {
    await db.update(plagRuns).set({ status: 'done' }).where(eq(plagRuns.status, 'queued'));
    await db.update(plagRuns).set({ status: 'done' }).where(eq(plagRuns.status, 'running'));
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    db = t.db;
    drop = t.drop;
    const cfg = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DEFAULT_PER_MIN: '100000',
      RATE_LIMIT_ANON_PER_MIN: '100000',
      PLAG_SERVICE_TOKEN: TOKEN,
      PLAG_STALE_MINUTES: '30',
      DATABASE_URL: t.url,
    });
    app = await createApp(cfg);
    await app.init();
    tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    const importer = app.get(ProblemImporter);
    for (const slug of [P1, P2]) {
      const r = parsePackage(slug, readPackageDirectory(`${root}${slug}`));
      if (!r.ok) throw new Error(`${slug} rejected`);
      await importer.import(r.pkg, { visibility: 'public' });
    }
    admin = await makeUser('admin');
  });
  afterAll(async () => {
    await app?.close();
    await drop?.();
  });

  it('only an admin starts a run, only for a contest that is over, and one at a time (audited)', async () => {
    const user = await makeUser();
    const ended = await makeContest('ended');
    expect(
      (await call('post', '/admin/plag/runs', { service: null, body: { contestId: ended.id } }))
        .status,
    ).toBe(401);
    expect(
      (
        await call('post', '/admin/plag/runs', {
          bearer: user.token,
          service: null,
          body: { contestId: ended.id },
        })
      ).status,
    ).toBe(403);
    for (const state of ['running', 'draft'] as const) {
      const c = await makeContest(state);
      const r = await adminCall('post', '/admin/plag/runs', { contestId: c.id });
      expect(r.status, state).toBe(state === 'draft' ? 404 : 400);
    }
    expect((await adminCall('post', '/admin/plag/runs', { contestId: uuid() })).status).toBe(404);
    expect((await adminCall('post', '/admin/plag/runs', { contestId: 'nope' })).status).toBe(400);
    const made = await adminCall('post', '/admin/plag/runs', {
      contestId: ended.id,
      params: { sweep_cosine: 0.9 },
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      status: 'queued',
      contestId: ended.id,
      params: { sweep_cosine: 0.9 },
      clusters: [],
    });
    const again = await adminCall('post', '/admin/plag/runs', { contestId: ended.id });
    expect(again.status).toBe(400);
    expect(again.body.detail).toMatch(/already queued or running/);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.targetId, made.body.id));
    expect(row).toMatchObject({ action: 'plag.run.start', actorId: admin.id });
    const fin = await makeContest('finalized'); // a finalised contest can be checked too
    expect((await adminCall('post', '/admin/plag/runs', { contestId: fin.id })).status).toBe(201);
    await drain();
  });

  it("the job routes need the service token: none, a wrong one and a user's bearer are all refused, and nothing is claimed", async () => {
    const ended = await makeContest('ended');
    const made = await adminCall('post', '/admin/plag/runs', { contestId: ended.id });
    expect((await job('/admin/plag/runs/claim', {}, null)).status).toBe(401);
    expect((await job('/admin/plag/runs/claim', {}, 'x'.repeat(48))).status).toBe(401);
    expect((await job('/admin/plag/runs/claim', {}, TOKEN.slice(0, -1))).status).toBe(401);
    const asUser = await call('post', '/admin/plag/runs/claim', {
      bearer: admin.token,
      service: null,
      body: {},
    });
    expect(asUser.status).toBe(401); // an admin's session is not the job's credential
    const [row] = await db.select().from(plagRuns).where(eq(plagRuns.id, made.body.id));
    expect(row!.status).toBe('queued');
    await drain();
  });

  it('claim: 204 when there is nothing; otherwise the oldest queued run, marked running, with the final submissions', async () => {
    await drain();
    expect((await job('/admin/plag/runs/claim')).status).toBe(204);
    const c = await makeContest('ended');
    const [a, b, d, e] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
    // a: an AC and a later WA on A -> the AC is final; b: two attempts on A, none AC -> the later one; d: only disqualified
    const aAc = await sub(c.id, a.id, P1, '// a AC', { verdict: 'AC' });
    await sub(c.id, a.id, P1, '// a later WA', {
      verdict: 'WA',
      createdAt: new Date(Date.now() + 1000),
    });
    await sub(c.id, b.id, P1, '// b first', { createdAt: new Date(Date.now() - 5000) });
    const bLast = await sub(c.id, b.id, P1, '// b last');
    await sub(c.id, d.id, P1, '// d disqualified', { disqualified: true });
    await sub(c.id, e.id, P1, '// e still judging', { verdict: null, status: 'queued' });
    const aB = await sub(c.id, a.id, P2, '// a on B');
    const made = await adminCall('post', '/admin/plag/runs', { contestId: c.id, params: { k: 1 } });
    const got = await job('/admin/plag/runs/claim');
    expect(got.status).toBe(200);
    expect(got.body.runId).toBe(made.body.id);
    expect(got.body.params).toEqual({ k: 1 });
    const byProblem = Object.fromEntries(
      got.body.problems.map((p: { slug: string }) => [p.slug, p]),
    );
    const first = byProblem[P1];
    expect(first.submissions.map((s: { id: string }) => s.id).sort()).toEqual([aAc, bLast].sort());
    expect(first.submissions.find((s: { id: string }) => s.id === aAc).source).toBe('// a AC');
    expect(byProblem[P2].submissions.map((s: { id: string }) => s.id)).toEqual([aB]);
    expect(first.templates).toEqual([]);
    // no handle, e-mail or role leaves the API
    const text = JSON.stringify(got.body);
    for (const u of [a, b, d, e]) {
      expect(text).not.toContain(u.email);
      expect(text).not.toContain(u.handle);
    }
    expect(first.submissions[0].user).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await db.select().from(plagRuns).where(eq(plagRuns.id, made.body.id));
    expect(row).toMatchObject({ status: 'running' });
    expect(row!.startedAt).toBeTruthy();
    expect((await job('/admin/plag/runs/claim')).status).toBe(204); // nothing else is queued
    await drain();
  });

  it('two jobs claiming at once get one run each, never the same one', async () => {
    await drain();
    const c1 = await makeContest('ended');
    const c2 = await makeContest('ended');
    const r1 = await adminCall('post', '/admin/plag/runs', { contestId: c1.id });
    const r2 = await adminCall('post', '/admin/plag/runs', { contestId: c2.id });
    const [x, y, z] = await Promise.all([
      job('/admin/plag/runs/claim'),
      job('/admin/plag/runs/claim'),
      job('/admin/plag/runs/claim'),
    ]);
    const statuses = [x, y, z].map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 204]);
    const ids = [x, y, z].filter((r) => r.status === 200).map((r) => r.body.runId);
    expect(new Set(ids)).toEqual(new Set([r1.body.id, r2.body.id]));
    await drain();
  });

  it('a run left "running" by a job that died is taken over after the stale time, not before', async () => {
    await drain();
    const c = await makeContest('ended');
    const made = await adminCall('post', '/admin/plag/runs', { contestId: c.id });
    expect((await job('/admin/plag/runs/claim')).status).toBe(200);
    expect((await job('/admin/plag/runs/claim')).status).toBe(204); // just started: not stale
    await db
      .update(plagRuns)
      .set({ startedAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(plagRuns.id, made.body.id));
    const again = await job('/admin/plag/runs/claim');
    expect(again.status).toBe(200);
    expect(again.body.runId).toBe(made.body.id);
    await drain();
  });

  it('results: pairs and clusters are stored (pairs ordered), the run is done once, and the admin reads them', async () => {
    await drain();
    const c = await makeContest('ended');
    const [u1, u2, u3] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const s1 = await sub(c.id, u1.id, P1, '// 1');
    const s2 = await sub(c.id, u2.id, P1, '// 2');
    const s3 = await sub(c.id, u3.id, P1, '// 3');
    const made = await adminCall('post', '/admin/plag/runs', { contestId: c.id });
    await job('/admin/plag/runs/claim');
    const p1 = (await versionOf(P1)).problemId;
    const [hi, lo] = [s1 < s2 ? [s2, s1] : [s1, s2], [s3, s1]]; // deliberately unordered
    const body = {
      runId: made.body.id,
      params: { combiner: 'fitted' },
      problems: [
        {
          problemId: p1,
          pairs: [
            { subA: hi[0], subB: hi[1], fpScore: 0.9, embScore: 0.97, combined: 0.95 },
            { subA: lo[0], subB: lo[1], fpScore: 0.1, embScore: 0.8, combined: 0.31 },
          ],
          clusters: [{ submissionIds: [s2, s1], maxScore: 0.95 }],
          metrics: { submissions: 3 },
        },
      ],
    };
    const posted = await job(`/admin/plag/runs/${made.body.id}/results`, body);
    expect(posted.status).toBe(200);
    expect(posted.body).toEqual({ pairs: 2, clusters: 1 });
    const pairs = await db.select().from(plagPairs).where(eq(plagPairs.runId, made.body.id));
    expect(pairs).toHaveLength(2);
    for (const p of pairs) expect(p.subA < p.subB).toBe(true);
    const run = await adminCall('get', `/admin/plag/runs/${made.body.id}`);
    expect(run.body).toMatchObject({ status: 'done', metrics: { pairs: 2, clusters: 1 } });
    expect(run.body.finishedAt).toBeTruthy();
    expect(run.body.clusters).toEqual([
      {
        id: expect.any(String),
        problemId: p1,
        problemSlug: P1,
        size: 2,
        maxScore: 0.95,
        status: 'open',
      },
    ]);
    const stored = await db.select().from(plagClusters).where(eq(plagClusters.runId, made.body.id));
    expect(stored[0]!.submissionIds).toEqual([s1, s2].sort());
    // the same results cannot be posted twice
    const twice = await job(`/admin/plag/runs/${made.body.id}/results`, body);
    expect(twice.status).toBe(400);
    expect(twice.body.detail).toMatch(/is done, not running/);
    expect(await db.select().from(plagPairs).where(eq(plagPairs.runId, made.body.id))).toHaveLength(
      2,
    );
    // listing
    const list = await adminCall('get', `/admin/plag/runs?contestId=${c.id}`);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([made.body.id]);
    expect(list.body.items[0]).not.toHaveProperty('clusters');
    expect((await adminCall('get', `/admin/plag/runs/${uuid()}`)).status).toBe(404);
    expect((await call('get', `/admin/plag/runs/${made.body.id}`, { service: null })).status).toBe(
      401,
    );
  });

  it("a bad results payload writes nothing and leaves the run running: unknown submission, another contest's submission, unknown problem, wrong run id, scores out of range", async () => {
    await drain();
    const c = await makeContest('ended');
    const other = await makeContest('ended');
    const [u1, u2] = await Promise.all([makeUser(), makeUser()]);
    const s1 = await sub(c.id, u1.id, P1, '// 1');
    const s2 = await sub(c.id, u2.id, P1, '// 2');
    const foreign = await sub(other.id, u1.id, P1, '// from another contest');
    const made = await adminCall('post', '/admin/plag/runs', { contestId: c.id });
    await job('/admin/plag/runs/claim');
    const p1 = (await versionOf(P1)).problemId;
    const pair = (a: string, b: string) => ({
      subA: a,
      subB: b,
      fpScore: 0.5,
      embScore: 0.9,
      combined: 0.7,
    });
    const send = (problems: unknown[], runId = made.body.id) =>
      job(`/admin/plag/runs/${made.body.id}/results`, { runId, problems });
    expect((await send([{ problemId: p1, pairs: [pair(s1, uuid())], clusters: [] }])).status).toBe(
      400,
    );
    expect((await send([{ problemId: p1, pairs: [pair(s1, foreign)], clusters: [] }])).status).toBe(
      400,
    );
    expect(
      (
        await send([
          { problemId: p1, pairs: [], clusters: [{ submissionIds: [s1, foreign], maxScore: 0.9 }] },
        ])
      ).status,
    ).toBe(400);
    expect((await send([{ problemId: uuid(), pairs: [], clusters: [] }])).status).toBe(400);
    expect(
      (await send([{ problemId: p1, pairs: [pair(s1, s2)], clusters: [] }], uuid())).status,
    ).toBe(400);
    expect(
      (await send([{ problemId: p1, pairs: [{ ...pair(s1, s2), combined: 1.5 }], clusters: [] }]))
        .status,
    ).toBe(400);
    expect(
      (
        await send([
          {
            problemId: p1,
            pairs: [pair(s1, s2)],
            clusters: [{ submissionIds: [s1], maxScore: 0.9 }],
          },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await job(`/admin/plag/runs/${made.body.id}/results`, {
          runId: made.body.id,
          problems: [],
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(await db.select().from(plagPairs).where(eq(plagPairs.runId, made.body.id))).toHaveLength(
      0,
    );
    const [row] = await db.select().from(plagRuns).where(eq(plagRuns.id, made.body.id));
    expect(row!.status).toBe('running');
    // a valid one still goes through afterwards
    expect((await send([{ problemId: p1, pairs: [pair(s1, s2)], clusters: [] }])).status).toBe(200);
  });

  it('fail: a running run becomes failed with the reason; a run that is not running cannot be failed; a new run may then start', async () => {
    await drain();
    const c = await makeContest('ended');
    const made = await adminCall('post', '/admin/plag/runs', { contestId: c.id });
    expect((await job(`/admin/plag/runs/${made.body.id}/fail`, { error: 'x' })).status).toBe(400); // still queued
    await job('/admin/plag/runs/claim');
    expect((await job(`/admin/plag/runs/${made.body.id}/fail`, { error: '' })).status).toBe(400);
    expect(
      (
        await job(
          `/admin/plag/runs/${made.body.id}/fail`,
          { error: 'the model could not be loaded' },
          null,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await job(`/admin/plag/runs/${made.body.id}/fail`, {
          error: 'the model could not be loaded',
        })
      ).status,
    ).toBe(204);
    const run = await adminCall('get', `/admin/plag/runs/${made.body.id}`);
    expect(run.body).toMatchObject({
      status: 'failed',
      metrics: { error: 'the model could not be loaded' },
    });
    expect((await job(`/admin/plag/runs/${made.body.id}/fail`, { error: 'again' })).status).toBe(
      400,
    );
    expect((await adminCall('post', '/admin/plag/runs', { contestId: c.id })).status).toBe(201); // retry
  });

  it('FR-PLAG-04: a cluster shows its members (handles, code, order), only its own pairs and signals, and no decision yet', async () => {
    const c = await makeContest('ended');
    const [a, b, d, other] = [
      await makeUser(),
      await makeUser(),
      await makeUser(),
      await makeUser(),
    ];
    const sa = await sub(c.id, a.id, P1, 'int main(){return 1;}');
    const sb = await sub(c.id, b.id, P1, 'int main(){return 1;} // b');
    const sd = await sub(c.id, d.id, P1, 'int main(){return 1;} // d');
    const so = await sub(c.id, other.id, P1, 'int main(){return 2;}');
    const [run] = await db
      .insert(plagRuns)
      .values({ contestId: c.id, status: 'done', params: {}, metrics: {} })
      .returning({ id: plagRuns.id });
    const v = await versionOf(P1);
    const [cl] = await db
      .insert(plagClusters)
      .values({
        runId: run!.id,
        problemId: v.problemId,
        submissionIds: [sb, sa, sd],
        maxScore: 0.9,
      })
      .returning({ id: plagClusters.id });
    const ord = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];
    for (const [x, y, score] of [
      [sa, sb, 0.9],
      [sa, sd, 0.7],
      [sa, so, 0.4], // a pair with someone outside the cluster is not shown
    ] as const) {
      const [lo, hi] = ord(x, y);
      await db.insert(plagPairs).values({
        runId: run!.id,
        problemId: v.problemId,
        subA: lo,
        subB: hi,
        fpScore: score,
        embScore: score,
        combined: score,
      });
    }
    await db.insert(editorSignals).values([
      { userId: a.id, contestId: c.id, problemId: v.problemId, kind: 'paste', size: 800 },
      { userId: other.id, contestId: c.id, problemId: v.problemId, kind: 'paste', size: 5 },
    ]);

    expect((await call('get', `/admin/plag/clusters/${cl!.id}`, { service: null })).status).toBe(
      401,
    );
    const user = await makeUser();
    expect(
      (await call('get', `/admin/plag/clusters/${cl!.id}`, { bearer: user.token, service: null }))
        .status,
    ).toBe(403);
    expect((await adminCall('get', `/admin/plag/clusters/${uuid()}`)).status).toBe(404);
    expect((await adminCall('get', '/admin/plag/clusters/nope')).status).toBe(400);

    const r = await adminCall('get', `/admin/plag/clusters/${cl!.id}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('open');
    expect(r.body.members.map((m: { handle: string }) => m.handle).sort()).toEqual(
      [a.handle, b.handle, d.handle].sort(),
    );
    expect(r.body.members.find((m: { handle: string }) => m.handle === a.handle)).toMatchObject({
      source: 'int main(){return 1;}',
      language: 'cpp17',
      verdict: 'WA',
    });
    expect(r.body.pairs.map((p: { combined: number }) => p.combined)).toEqual([0.9, 0.7]);
    expect(r.body.signals).toEqual([
      expect.objectContaining({ handle: a.handle, kind: 'paste', size: 800 }),
    ]);
    expect(r.body.decisions).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain('example.test'); // no e-mail address anywhere
    clusterUnderReview = { id: cl!.id, runId: run!.id, subs: [sa, sb, sd] };
  });

  it('FR-PLAG-05: a decision needs a note, is stored with the reviewer and audited, the latest wins, and nothing else changes', async () => {
    const { id, runId, subs } = clusterUnderReview!;
    const before = await db.select().from(submissions).where(eq(submissions.id, subs[0]!));
    const post = (body: unknown, bearer = admin.token) =>
      call('post', `/admin/plag/clusters/${id}/decisions`, { bearer, service: null, body });
    const user = await makeUser();
    expect((await post({ decision: 'clear', note: 'fine' }, user.token)).status).toBe(403);
    for (const bad of [
      { decision: 'clear' },
      { decision: 'clear', note: '' },
      { decision: 'clear', note: '  ' },
      { decision: 'clear', note: 'x'.repeat(2001) },
      { decision: 'ban', note: 'a note' },
      { decision: 'clear', note: 'a note', extra: 1 },
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect(
      await db.select().from(reviewDecisions).where(eq(reviewDecisions.clusterId, id)),
    ).toEqual([]);
    expect(
      (
        await call('post', `/admin/plag/clusters/${uuid()}/decisions`, {
          bearer: admin.token,
          service: null,
          body: { decision: 'clear', note: 'a note' },
        })
      ).status,
    ).toBe(404);

    const first = await post({ decision: 'discuss', note: 'Looks alike, ask the setter' });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('discuss');
    const second = await post({ decision: 'confirm', note: 'Same unusual variable names' });
    expect(second.body.status).toBe('confirm');
    expect(second.body.decisions.map((d: { decision: string }) => d.decision)).toEqual([
      'discuss',
      'confirm',
    ]);
    expect(second.body.decisions[1]).toMatchObject({ note: 'Same unusual variable names' });
    const stored = await db.select().from(reviewDecisions).where(eq(reviewDecisions.clusterId, id));
    expect(stored.map((d) => [d.decision, d.reviewerId])).toEqual([
      ['needs_more', admin.id],
      ['confirmed', admin.id],
    ]);
    const logged = await db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(logged.map((l) => [l.action, l.actorId])).toEqual([
      ['plag.decision', admin.id],
      ['plag.decision', admin.id],
    ]);

    // the run lists the cluster with its latest decision; "confirm" penalises no one
    const run = await adminCall('get', `/admin/plag/runs/${runId}`);
    expect(run.body.clusters[0]).toMatchObject({ id, status: 'confirm' });
    const after = await db.select().from(submissions).where(eq(submissions.id, subs[0]!));
    expect(after).toEqual(before);
  });
});

describe('PL-05: with no service token configured, the job routes refuse everything', () => {
  it('answers 403 "not configured" whatever is sent', async () => {
    const { ServiceTokenGuard } = await import('./service-token.guard');
    const run = (token: string | undefined, header: string | undefined) => {
      const guard = new ServiceTokenGuard({ ...config, PLAG_SERVICE_TOKEN: token });
      const ctx = { switchToHttp: () => ({ getRequest: () => ({ header: () => header }) }) };
      return () => guard.canActivate(ctx as never);
    };
    expect(run(undefined, 'anything')).toThrowError(/not configured/);
    expect(run('not-configured', 'not-configured')).toThrowError(/not configured/);
    expect(run('a'.repeat(40), undefined)).toThrowError(/service token/);
    expect(run('a'.repeat(40), 'a'.repeat(39))).toThrowError(/service token/);
    expect(run('a'.repeat(40), 'a'.repeat(40))()).toBe(true);
  });
});
