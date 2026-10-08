import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { JudgeResult } from '@codearena/contracts';
import { eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  contestProblems,
  contests,
  participants,
  problemVersions,
  problems,
  submissions,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { ResultsProcessor } from '../submissions/results.processor';
import { BoardService } from './board.service';
import { computeCell, unpack } from './scoring';

const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
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
const ready = redisUp && (await postgresReachable());

const prefix = `t${randomBytes(4).toString('hex')}:`;
const csrf = randomBytes(32).toString('base64url');
const MIN = 60_000;
const LABELS = 'ABCDEF';

interface Ref {
  solved: number;
  penalty: number;
  lastAc: number | null;
}

/**
 * The slow reference (PLAN C-02 Accept): PRD §9.1 written out plainly from the Postgres rows,
 * sharing nothing with `scoring.ts`. `frozen` drops every attempt made after the freeze.
 */
function reference(
  rows: {
    userId: string;
    versionId: string;
    createdAt: Date;
    id: string;
    minute: number | null;
    status: string;
    verdict: string | null;
    disqualified: boolean;
    afterFreeze: boolean;
  }[],
  userIds: string[],
  versionIds: string[],
  rules: { penaltyMinutes: number; ceCountsAsAttempt: boolean },
  frozen: boolean,
): Map<string, Ref & { rank: number }> {
  const totals = new Map<string, Ref>();
  for (const u of userIds) {
    let solved = 0;
    let penalty = 0;
    let lastAc: number | null = null;
    for (const v of versionIds) {
      const mine = rows
        .filter((r) => r.userId === u && r.versionId === v && !r.disqualified)
        .filter((r) => !(frozen && r.afterFreeze))
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      let wrong = 0;
      for (const r of mine) {
        if (r.status === 'queued' || r.status === 'judging') continue;
        if (r.status === 'failed' || r.verdict === 'SE' || r.verdict === null) continue;
        if (r.verdict === 'CE' && !rules.ceCountsAsAttempt) continue;
        if (r.verdict === 'AC') {
          solved += 1;
          penalty += r.minute! + rules.penaltyMinutes * Math.min(wrong, 99);
          lastAc = Math.max(lastAc ?? 0, r.minute!);
          break;
        }
        wrong += 1;
      }
    }
    totals.set(u, { solved, penalty, lastAc });
  }
  const better = (a: Ref, b: Ref) =>
    a.solved > b.solved ||
    (a.solved === b.solved &&
      (a.penalty < b.penalty || (a.penalty === b.penalty && (a.lastAc ?? 0) < (b.lastAc ?? 0))));
  const out = new Map<string, Ref & { rank: number }>();
  for (const [u, t] of totals) {
    const rank = 1 + [...totals.values()].filter((o) => better(o, t)).length;
    out.set(u, { ...t, rank });
  }
  return out;
}

describe.skipIf(!ready)('C-02: leaderboard engine (needs the Compose Postgres and Redis)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: INestApplication;
  let redis: Redis;
  let board: BoardService;
  let processor: ResultsProcessor;
  let tokens: AccessTokens;
  const versionIds: string[] = [];
  const pool: { id: string; token: string }[] = [];
  let admin: { id: string; token: string };

  const makeUser = async (role: 'user' | 'admin' = 'user') => {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      email: `${id}@example.test`,
      role,
      handle: `b${id.slice(0, 8)}`,
    });
    const { token } = await tokens.sign({ sub: id, role, sid: randomUUID() });
    return { id, token };
  };
  const call = (method: 'get' | 'post', path: string, token?: string) => {
    const r = request(app.getHttpServer())[method](`/api${path}`);
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r.set('Cookie', `ca_csrf=${csrf}`).set('X-CSRF-Token', csrf);
  };

  let n = 0;
  /** A published contest that started `ago` minutes ago, with the first `count` problems. */
  const makeContest = async (opts: {
    count?: number;
    ago?: number;
    freezeAfter?: number | null;
    penaltyMinutes?: number;
    ceCountsAsAttempt?: boolean;
    status?: 'draft' | 'scheduled';
  }) => {
    const ago = opts.ago ?? 300;
    const start = new Date(Date.now() - ago * MIN);
    const [c] = await db
      .insert(contests)
      .values({
        slug: `b-${prefix.slice(0, -1)}-${n++}`,
        title: 'Board',
        startsAt: start,
        endsAt: new Date(start.getTime() + 600 * MIN),
        freezeAt:
          opts.freezeAfter === null || opts.freezeAfter === undefined
            ? null
            : new Date(start.getTime() + opts.freezeAfter * MIN),
        rules: {
          penaltyMinutes: opts.penaltyMinutes ?? 20,
          ceCountsAsAttempt: opts.ceCountsAsAttempt ?? false,
          langMultipliers: {},
          rated: false,
          lateRegistration: true,
        },
        status: opts.status ?? 'scheduled',
      })
      .returning();
    const count = opts.count ?? 3;
    for (let i = 0; i < count; i++) {
      const [v] = await db
        .select({ problemId: problemVersions.problemId })
        .from(problemVersions)
        .where(eq(problemVersions.id, versionIds[i]!));
      await db.insert(contestProblems).values({
        contestId: c!.id,
        label: LABELS[i]!,
        problemId: v!.problemId,
        versionId: versionIds[i]!,
        position: i,
      });
    }
    return { c: c!, start };
  };

  const register = async (cid: string, uid: string) => {
    await db.insert(participants).values({ contestId: cid, userId: uid });
    await board.addParticipant(cid, uid);
  };

  /** A contest submission as `submit` stores it, then the board update `submit` makes. */
  const addSub = async (
    cid: string,
    start: Date,
    uid: string,
    p: number,
    minute: number,
    freezeAfter: number | null,
    jitter = 0,
  ) => {
    const [s] = await db
      .insert(submissions)
      .values({
        userId: uid,
        problemVersionId: versionIds[p]!,
        contestId: cid,
        language: 'cpp17',
        source: 'x',
        sourceBytes: 1,
        lane: 'contest',
        contestMinute: minute,
        afterFreeze: freezeAfter !== null && minute >= freezeAfter,
        createdAt: new Date(start.getTime() + minute * MIN + jitter),
      })
      .returning({ id: submissions.id });
    await board.update(cid, uid, versionIds[p]!);
    return s!.id;
  };

  const result = (id: string, verdict: string, runVersion = 1): string =>
    JSON.stringify({
      submissionId: id,
      runVersion,
      verdict,
      timeMs: 10,
      memKb: 1000,
      tests: [],
      workerId: 'w-test',
      finishedAt: Date.now(),
    } satisfies Omit<JudgeResult, 'verdict'> & { verdict: string });

  /** Everything the board stores for a contest, in a comparable form. */
  const dump = async (cid: string) => {
    const k = board.keys(cid);
    const sortObj = (o: Record<string, string>) => Object.entries(o).sort();
    return {
      live: await redis.zrange(k.live, '0', '-1', 'WITHSCORES'),
      frozen: await redis.zrange(k.frozen, '0', '-1', 'WITHSCORES'),
      cells: sortObj(await redis.hgetall(k.cells)),
      frozenCells: sortObj(await redis.hgetall(k.frozenCells)),
    };
  };

  const compare = async (
    cid: string,
    uids: string[],
    vids: string[],
    rules: { penaltyMinutes: number; ceCountsAsAttempt: boolean },
  ) => {
    const rows = await db
      .select({
        id: submissions.id,
        userId: submissions.userId,
        versionId: submissions.problemVersionId,
        createdAt: submissions.createdAt,
        minute: submissions.contestMinute,
        status: submissions.status,
        verdict: submissions.verdict,
        disqualified: submissions.disqualified,
        afterFreeze: submissions.afterFreeze,
      })
      .from(submissions)
      .where(eq(submissions.contestId, cid));
    const k = board.keys(cid);
    for (const [zkey, frozen] of [
      [k.live, false],
      [k.frozen, true],
    ] as const) {
      const ref = reference(rows, uids, vids, rules, frozen);
      const scored = await redis.zrange(zkey, '0', '-1', 'WITHSCORES');
      const scores = new Map<string, number>();
      for (let i = 0; i < scored.length; i += 2) scores.set(scored[i]!, Number(scored[i + 1]));
      expect([...scores.keys()].sort()).toEqual([...uids].sort());
      const all = [...scores.values()];
      for (const u of uids) {
        const s = scores.get(u)!;
        const got = unpack(s);
        const want = ref.get(u)!;
        const rank = 1 + all.filter((x) => x > s).length;
        expect({ ...got, rank }, `${frozen ? 'frozen' : 'live'} ${u}`).toEqual(want);
      }
    }
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
    board = app.get(BoardService);
    processor = app.get(ResultsProcessor);
    tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    for (let i = 0; i < 6; i++) {
      const [p] = await db
        .insert(problems)
        .values({ slug: `bp-${prefix.slice(0, -1)}-${i}`, title: `P${i}`, difficulty: 800 })
        .returning();
      const [v] = await db
        .insert(problemVersions)
        .values({
          problemId: p!.id,
          version: 1,
          statementMd: 's',
          limits: { timeMs: 1000, memMb: 256, outputKb: 64 },
          checker: { kind: 'tokens' },
          testsetHash: 'a'.repeat(64),
          testsetUri: `s3://tests/testsets/${'a'.repeat(64)}.tar`,
          validationStatus: 'passed',
        })
        .returning();
      versionIds.push(v!.id);
    }
    for (let i = 0; i < 8; i++) pool.push(await makeUser());
    admin = await makeUser('admin');
  });

  afterAll(async () => {
    await app?.close();
    const keys = redis ? await redis.keys(`${prefix}*`) : [];
    if (keys.length) await redis.del(...keys);
    redis?.disconnect();
    await drop?.();
  });

  it('FR-BOARD-03 (Accept): random sequences, shuffled and repeated verdicts, rejudges and disqualifications: ZSET ranking equals the slow reference; a rebuild changes nothing', async () => {
    const verdict = fc.constantFrom('AC', 'AC', 'WA', 'WA', 'TLE', 'CE', 'SE', null);
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          users: fc.integer({ min: 2, max: 5 }),
          problems: fc.integer({ min: 1, max: 4 }),
          ce: fc.boolean(),
          penalty: fc.integer({ min: 0, max: 40 }),
          freeze: fc.option(fc.integer({ min: 20, max: 280 }), { nil: null }),
          subs: fc.array(
            fc.record({
              u: fc.nat(7),
              p: fc.nat(5),
              minute: fc.integer({ min: 0, max: 299 }),
              verdict,
            }),
            // Dense on purpose: few users and problems, many submissions, so cells collect
            // several attempts (fast-check's default "small" arrays would rarely do that).
            { minLength: 10, maxLength: 60, size: 'max' },
          ),
          rejudges: fc.array(
            fc.record({ i: fc.nat(), verdict: fc.constantFrom('AC', 'WA', 'CE') }),
            { maxLength: 4 },
          ),
          dq: fc.array(fc.nat(), { maxLength: 3 }),
          dup: fc.array(fc.nat(), { maxLength: 4 }),
          seed: fc.integer(),
        }),
        async (sc) => {
          const { c, start } = await makeContest({
            count: sc.problems,
            freezeAfter: sc.freeze,
            penaltyMinutes: sc.penalty,
            ceCountsAsAttempt: sc.ce,
          });
          const uids = pool.slice(0, sc.users).map((u) => u.id);
          for (const u of uids) await register(c.id, u);
          const judged: { id: string; verdict: string }[] = [];
          for (const [i, s] of sc.subs.entries()) {
            const id = await addSub(
              c.id,
              start,
              uids[s.u % sc.users]!,
              s.p % sc.problems,
              s.minute,
              sc.freeze,
              i,
            );
            if (s.verdict) judged.push({ id, verdict: s.verdict });
          }
          // Verdicts arrive in any order, four at a time, some twice.
          let x = sc.seed >>> 0;
          const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32;
          const deliveries = [
            ...judged,
            ...sc.dup.flatMap((d) => (judged.length ? [judged[d % judged.length]!] : [])),
          ];
          for (let i = deliveries.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [deliveries[i], deliveries[j]] = [deliveries[j]!, deliveries[i]!];
          }
          for (let i = 0; i < deliveries.length; i += 4) {
            await Promise.all(
              deliveries.slice(i, i + 4).map((d) => processor.handle(result(d.id, d.verdict))),
            );
          }
          // Rejudges (SD-§5.4): new run version, queued, then a different verdict.
          for (const r of sc.rejudges) {
            if (judged.length === 0) break;
            const target = judged[r.i % judged.length]!;
            const [s] = await db
              .update(submissions)
              .set({
                currentRunVersion: sql`${submissions.currentRunVersion} + 1`,
                status: 'queued',
              })
              .where(eq(submissions.id, target.id))
              .returning();
            await board.update(c.id, s!.userId, s!.problemVersionId);
            await processor.handle(result(target.id, r.verdict, s!.currentRunVersion));
          }
          // FR-BOARD-09: disqualified submissions vanish from the board.
          for (const d of sc.dq) {
            if (judged.length === 0) break;
            const [s] = await db
              .update(submissions)
              .set({ disqualified: true })
              .where(eq(submissions.id, judged[d % judged.length]!.id))
              .returning();
            await board.update(c.id, s!.userId, s!.problemVersionId);
          }
          const rules = { penaltyMinutes: sc.penalty, ceCountsAsAttempt: sc.ce };
          await compare(c.id, uids, versionIds.slice(0, sc.problems), rules);
          const before = await dump(c.id);
          await board.rebuild(c.id, 'test');
          expect(await dump(c.id)).toEqual(before);
        },
      ),
      { numRuns: 40 },
    );
  }, 240_000);

  it('FR-BOARD-03: 20 verdicts on one cell at once leave the cell right', async () => {
    // A race needs the right interleaving, so the scenario runs several times (without the
    // per-cell lock it fails in about half of the rounds).
    for (let round = 0; round < 8; round++) {
      const { c, start } = await makeContest({ count: 1 });
      const u = pool[0]!.id;
      await register(c.id, u);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push(await addSub(c.id, start, u, 0, 10 + i, null));
      // Widen the gap between reading a cell and writing it, and let verdicts commit at
      // staggered moments, so cell reads and verdict commits interleave.
      board.testDelayMs = 80;
      try {
        // The 13th is the first AC: 12 rejections before it.
        await Promise.all(
          ids.map(async (id, i) => {
            await new Promise((r) => setTimeout(r, Math.random() * 300));
            return processor.handle(result(id, i === 12 || i === 17 ? 'AC' : 'WA'));
          }),
        );
      } finally {
        board.testDelayMs = 0;
      }
      const cell = JSON.parse((await redis.hget(board.keys(c.id).cells, `${u}:A`))!);
      expect(cell, `round ${round}`).toMatchObject({ a: 12, m: 22, p: 0 });
      expect(unpack(Number(await redis.zscore(board.keys(c.id).live, u)))).toEqual({
        solved: 1,
        penalty: 22 + 20 * 12,
        lastAc: 22,
      });
    }
  });

  it('FR-BOARD-05: during the freeze others see pending cells, the owner sees their own, admins see all', async () => {
    const { c, start } = await makeContest({ count: 2, ago: 200, freezeAfter: 100 });
    const [a, b] = [pool[0]!, pool[1]!];
    await register(c.id, a.id);
    await register(c.id, b.id);
    await processor.handle(result(await addSub(c.id, start, b.id, 0, 30, 100), 'AC'));
    await processor.handle(result(await addSub(c.id, start, a.id, 0, 50, 100), 'WA'));
    await processor.handle(result(await addSub(c.id, start, a.id, 0, 120, 100), 'AC'));
    await processor.handle(result(await addSub(c.id, start, a.id, 1, 130, 100), 'AC'));

    const guest = await call('get', `/contests/${c.slug}/board`);
    expect(guest.status).toBe(200);
    expect(guest.body.frozen).toBe(true);
    expect(guest.body.contestId).toBe(c.id);
    const rowA = guest.body.rows.find((r: { userId: string }) => r.userId === a.id);
    expect(rowA).toMatchObject({ solved: 0, rank: 2 });
    expect(rowA.cells.A).toEqual({ attempts: 1, acMinute: null, pending: 1, first: false });
    expect(rowA.cells.B).toEqual({ attempts: 0, acMinute: null, pending: 1, first: false });
    expect(guest.body.problems[0]).toEqual({ label: 'A', solvedCount: 1, firstSolverId: b.id });

    const own = await call('get', `/contests/${c.slug}/board`, a.token);
    const ownRow = own.body.rows.find((r: { userId: string }) => r.userId === a.id);
    expect(own.body.frozen).toBe(true);
    expect(ownRow.cells.A).toMatchObject({ acMinute: 120, pending: 0 });
    expect(ownRow.rank).toBe(2); // the rank stays the frozen one
    const other = (await call('get', `/contests/${c.slug}/board`, b.token)).body.rows.find(
      (r: { userId: string }) => r.userId === a.id,
    );
    expect(other.cells.A.pending).toBe(1);

    const live = await call('get', `/contests/${c.slug}/board`, admin.token);
    expect(live.body.frozen).toBe(false);
    expect(live.body.rows[0]).toMatchObject({ userId: a.id, rank: 1, solved: 2 });
    expect(live.body.rows[0].cells.A).toMatchObject({ attempts: 1, acMinute: 120 });
  });

  it('a draft board is 404 for everyone but admins; before the start rows are empty', async () => {
    const { c } = await makeContest({ status: 'draft' });
    expect((await call('get', `/contests/${c.slug}/board`)).status).toBe(404);
    expect((await call('get', `/contests/${c.slug}/board`, admin.token)).status).toBe(200);
    const { c: early } = await makeContest({ ago: -60 });
    await register(early.id, pool[2]!.id);
    const r = await call('get', `/contests/${early.slug}/board`);
    expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0]).toMatchObject({ rank: 1, solved: 0, penalty: 0, cells: {} });
    expect(r.body.problems.map((p: { label: string }) => p.label)).toEqual(['A', 'B', 'C']);
  });

  it('FR-BOARD-08: admins rebuild on demand; a lost board rebuilds itself on read', async () => {
    const { c, start } = await makeContest({ count: 1 });
    const u = pool[3]!;
    await register(c.id, u.id);
    await processor.handle(result(await addSub(c.id, start, u.id, 0, 7, null), 'AC'));
    expect((await call('post', `/admin/contests/${c.id}/rebuild-board`, u.token)).status).toBe(403);
    const ok = await call('post', `/admin/contests/${c.id}/rebuild-board`, admin.token);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBeGreaterThan(0);
    const k = board.keys(c.id);
    await redis.del(k.live, k.frozen, k.cells, k.frozenCells);
    const r = await call('get', `/contests/${c.slug}/board`);
    expect(r.body.rows[0]).toMatchObject({ userId: u.id, solved: 1, penalty: 7 });
  });

  it('FR-BOARD-04: a burst of updates becomes one diff, carrying every change', async () => {
    const { c, start } = await makeContest({ count: 1 });
    for (const u of pool.slice(0, 5)) await register(c.id, u.id);
    await new Promise((r) => setTimeout(r, 700)); // let the registrations' diff go out
    const sub = new Redis(config.REDIS_URL);
    const got: { envelope: { data: { rows: { userId: string }[]; version: number } } }[] = [];
    await sub.subscribe(`${prefix}rt:contest:${c.id}:board`);
    sub.on('message', (_ch, msg) => got.push(JSON.parse(msg)));
    for (const u of pool.slice(0, 5)) {
      await processor.handle(result(await addSub(c.id, start, u.id, 0, 5, null), 'AC'));
    }
    await new Promise((r) => setTimeout(r, 1200));
    sub.disconnect();
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got.length).toBeLessThanOrEqual(3); // ≤ 2 per second
    const seen = new Set(got.flatMap((g) => g.envelope.data.rows.map((r) => r.userId)));
    for (const u of pool.slice(0, 5)) expect(seen.has(u.id)).toBe(true);
    const last = got.at(-1)!.envelope.data;
    expect(last.version).toBe(Number(await redis.get(board.keys(c.id).version)));
  });

  it('submitting through the API puts a pending attempt on the board at once', async () => {
    const { c } = await makeContest({ count: 1 });
    const u = pool[4]!;
    await register(c.id, u.id);
    const r = await call('post', '/submissions', u.token).send({
      contestSlug: c.slug,
      label: 'A',
      language: 'cpp17',
      source: 'int main(){}',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const cell = JSON.parse((await redis.hget(board.keys(c.id).cells, `${u.id}:A`))!);
    expect(cell).toMatchObject({ p: 1, a: 0, m: null });
    // The same cell, computed the slow way, agrees.
    const rows = await db.select().from(submissions).where(eq(submissions.contestId, c.id));
    expect(
      computeCell(
        rows.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.getTime(),
          minute: s.contestMinute ?? 0,
          status: s.status,
          verdict: s.verdict,
          disqualified: s.disqualified,
          afterFreeze: s.afterFreeze,
        })),
        { ceCountsAsAttempt: false },
      ),
    ).toEqual(cell);
  });
});
