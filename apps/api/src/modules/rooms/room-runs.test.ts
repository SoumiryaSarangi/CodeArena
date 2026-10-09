import { randomBytes, randomUUID } from 'node:crypto';
import { ROOM_RUN_OUTPUT_CAP, RoomRunView } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import {
  customRuns,
  problemVersions,
  problems,
  roomEvents,
  roomMembers,
  users,
} from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { REDIS } from '../../redis/redis.module';
import { ResultsProcessor } from '../submissions/results.processor';

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
const csrf = randomBytes(32).toString('base64url');
const prefix = `t${randomBytes(4).toString('hex')}:`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ready)(
  'CP-04: run and submit from the pad (needs Compose Postgres + Redis)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;
    let redis: Redis;
    let processor: ResultsProcessor;
    let versionId: string;

    const makeUser = async () => {
      const id = randomUUID();
      const handle = `u${id.slice(0, 8)}`;
      await db.insert(users).values({ id, email: `${id}@example.test`, role: 'user', handle });
      const { token } = await tokens.sign({ sub: id, role: 'user', sid: randomUUID() });
      return { id, token, handle };
    };
    const call = (
      method: 'get' | 'post',
      path: string,
      who?: { token: string },
      body?: unknown,
    ) => {
      const agent = request(app.getHttpServer());
      const r = agent[method](`/api${path}`).set('Cookie', `ca_csrf=${csrf}`);
      if (who) r.set('Authorization', `Bearer ${who.token}`).set('X-CSRF-Token', csrf);
      return body === undefined ? r : r.send(body as object);
    };
    /** A room with an interviewer, a candidate and an observer; with the problem attached or blank. */
    const makeRoom = async (withProblem = false) => {
      const [iv, cand, obs] = [await makeUser(), await makeUser(), await makeUser()];
      const created = await call('post', '/rooms', iv, {
        language: 'python3',
        durationMin: 45,
        ...(withProblem ? { problemSlug: 'run-prob' } : {}),
      });
      expect(created.status).toBe(201);
      const roomId = created.body.id as string;
      await db.insert(roomMembers).values([
        { roomId, userId: cand.id, role: 'candidate' },
        { roomId, userId: obs.id, role: 'observer' },
      ]);
      return { roomId, iv, cand, obs };
    };
    const body = (over: object = {}) => ({
      runId: randomUUID(),
      mode: 'run',
      language: 'python3',
      source: 'print(int(input()) * 2)',
      input: '21\n',
      ...over,
    });
    /** A submission request: no input. */
    const submitBody = (over: object = {}) => {
      const b = body({ mode: 'submit', ...over }) as Record<string, unknown> & { runId: string };
      delete b.input;
      return b;
    };
    const jobsOf = async (runId: string) => {
      const entries = await redis.xrange(`${prefix}jobs:interactive`, '-', '+');
      return entries
        .map(([, f]) => JSON.parse(f[f.indexOf('job') + 1]!) as Record<string, unknown>)
        .filter((j) => j.submissionId === runId);
    };
    const finish = (runId: string, over: object = {}) =>
      processor.handle(
        JSON.stringify({
          submissionId: runId,
          runVersion: 1,
          verdict: 'AC',
          timeMs: 14,
          memKb: 2048,
          tests: [{ no: 1, verdict: 'AC', timeMs: 14, memKb: 2048 }],
          workerId: 'w1',
          finishedAt: 1_790_000_001_000,
          output: '42\n',
          stderr: '',
          ...over,
        }),
      );
    const roomEvents$ = async (roomId: string) =>
      (await redis.xrange(`${prefix}evt:room:${roomId}`, '-', '+')).map(([, f]) =>
        JSON.parse(f[f.indexOf('event') + 1]!),
      );

    beforeAll(async () => {
      const t = await createTestDatabase();
      db = t.db;
      drop = t.drop;
      app = await createApp(
        loadConfig({
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          RATE_LIMIT_DEFAULT_PER_MIN: '100000',
          RATE_LIMIT_ANON_PER_MIN: '100000',
          QUEUE_KEY_PREFIX: prefix,
          DATABASE_URL: t.url,
        }),
      );
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
      redis = app.get<Redis>(REDIS);
      processor = app.get(ResultsProcessor);
      const [p] = await db
        .insert(problems)
        .values({ slug: 'run-prob', title: 'Run Problem', difficulty: 800, visibility: 'public' })
        .returning({ id: problems.id });
      const [v] = await db
        .insert(problemVersions)
        .values({
          problemId: p!.id,
          version: 1,
          statementMd: '# x',
          limits: { timeMs: 1000, memMb: 256, outputKb: 64 },
          checker: { kind: 'exact' },
          testsetHash: '1'.repeat(64),
          testsetUri: 's3://bucket/testsets/run-prob',
          testsCount: 3,
        })
        .returning({ id: problemVersions.id });
      versionId = v!.id;
      await db.update(problems).set({ currentVersionId: versionId }).where(eq(problems.id, p!.id));
    });
    afterAll(async () => {
      await app?.close();
      await drop?.();
    });

    it('FR-PAD-08: the interviewer and the candidate may run; an observer, a stranger and a guest may not; an ended room refuses', async () => {
      const { roomId, iv, cand, obs } = await makeRoom();
      expect((await call('post', `/rooms/${roomId}/runs`, iv, body())).status).toBe(202);
      await sleep(2100);
      expect((await call('post', `/rooms/${roomId}/runs`, cand, body())).status).toBe(202);
      await sleep(2100);
      expect((await call('post', `/rooms/${roomId}/runs`, obs, body())).status).toBe(403);
      expect((await call('post', `/rooms/${roomId}/runs`, await makeUser(), body())).status).toBe(
        404,
      );
      expect((await call('post', `/rooms/${roomId}/runs`, undefined, body())).status).toBe(401);
      await call('post', `/rooms/${roomId}/close`, iv);
      expect((await call('post', `/rooms/${roomId}/runs`, iv, body())).status).toBe(400);
    }, 20_000);

    it('refuses bad requests: extra fields, bad ids, languages, empty or huge source, a submission with input or without a problem', async () => {
      const { roomId, iv } = await makeRoom();
      const bad = [
        { extra: 1 },
        { runId: 'nope' },
        { language: 'cobol' },
        { mode: 'debug' },
        { source: '' },
        { mode: 'submit' }, // has input: a submission takes none
      ];
      for (const b of bad) {
        expect(
          (await call('post', `/rooms/${roomId}/runs`, iv, body(b))).status,
          JSON.stringify(b),
        ).toBe(400);
      }
      expect(
        (await call('post', `/rooms/${roomId}/runs`, iv, body({ source: 'é'.repeat(40_000) })))
          .status,
      ).toBe(413); // 80 KB in bytes
      const noInput = submitBody();
      expect((await call('post', `/rooms/${roomId}/runs`, iv, noInput)).status).toBe(400); // no problem attached
      expect(await db.select().from(customRuns).where(eq(customRuns.roomId, roomId))).toEqual([]);
    });

    it('FR-PAD-08: a run goes to the interactive lane with the room, the input and the scratch limits; it is a room event', async () => {
      const { roomId, iv } = await makeRoom();
      const b = body();
      const r = await call('post', `/rooms/${roomId}/runs`, iv, b);
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ runId: b.runId });
      const [job] = await jobsOf(b.runId);
      expect(job).toMatchObject({
        lane: 'interactive',
        mode: 'run',
        language: 'python3',
        customInput: '21\n',
        stopOnFirstFailure: false,
        problem: { versionId: 'scratch', checker: { kind: 'exact' } },
      });
      const [row] = await db.select().from(customRuns).where(eq(customRuns.id, b.runId));
      expect(row).toMatchObject({
        roomId,
        userId: iv.id,
        status: 'queued',
        input: '21\n',
        problemVersionId: null,
      });
      const events = await db.select().from(roomEvents).where(eq(roomEvents.roomId, roomId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'run',
        userId: iv.id,
        seq: 1,
        payload: { runId: b.runId, mode: 'run' },
      });
    });

    it("FR-PAD-08: a submission judges the attached problem's version in the interactive lane, without input, and is not a submission", async () => {
      const { roomId, cand } = await makeRoom(true);
      const b = submitBody();
      expect((await call('post', `/rooms/${roomId}/runs`, cand, b)).status).toBe(202);
      const [job] = await jobsOf(b.runId);
      expect(job).toMatchObject({
        lane: 'interactive',
        mode: 'submit',
        problem: {
          versionId,
          testsetHash: '1'.repeat(64),
          testsetUri: 's3://bucket/testsets/run-prob',
        },
      });
      expect(job).not.toHaveProperty('customInput');
      const [row] = await db.select().from(customRuns).where(eq(customRuns.id, b.runId));
      expect(row).toMatchObject({ input: null, problemVersionId: versionId });
      // a run in a room with a problem also uses the problem's limits
      await sleep(2100);
      const b2 = body();
      await call('post', `/rooms/${roomId}/runs`, cand, b2);
      expect((await jobsOf(b2.runId))[0]).toMatchObject({
        problem: { versionId },
        customInput: '21\n',
      });
    }, 15_000);

    it('FR-PAD-08: at most one run every 2 seconds per room, whoever presses; other rooms are not affected; a retry of the same run id is free', async () => {
      const a = await makeRoom();
      const b = await makeRoom();
      const first = body();
      expect((await call('post', `/rooms/${a.roomId}/runs`, a.iv, first)).status).toBe(202);
      // the same run id again (a retry): same answer, nothing queued twice, no token used
      expect((await call('post', `/rooms/${a.roomId}/runs`, a.iv, first)).status).toBe(202);
      expect(await jobsOf(first.runId)).toHaveLength(1);
      // someone else, a moment later: refused with when to try again
      const tooSoon = await call('post', `/rooms/${a.roomId}/runs`, a.cand, body());
      expect(tooSoon.status).toBe(429);
      expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(tooSoon.headers['retry-after'])).toBeLessThanOrEqual(2);
      // another room is independent
      expect((await call('post', `/rooms/${b.roomId}/runs`, b.iv, body())).status).toBe(202);
      // that run id belongs to the first person in the first room only
      expect((await call('post', `/rooms/${b.roomId}/runs`, b.iv, first)).status).toBe(400);
      await sleep(2100);
      expect((await call('post', `/rooms/${a.roomId}/runs`, a.cand, body())).status).toBe(202);
      const seqs = (await db.select().from(roomEvents).where(eq(roomEvents.roomId, a.roomId)))
        .map((e) => e.seq)
        .sort();
      expect(seqs).toEqual([1, 2]);
    }, 15_000);

    it('FR-PAD-08: everyone in the room is told the same thing when the run starts and when it ends, and the history says it too', async () => {
      const { roomId, iv, cand, obs } = await makeRoom(true);
      const b = body();
      await call('post', `/rooms/${roomId}/runs`, iv, b);
      let events = await roomEvents$(roomId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        topic: `room:${roomId}`,
        type: 'room.run',
        data: { runId: b.runId, status: 'queued', mode: 'run', by: iv.handle },
      });

      expect((await finish(b.runId)).kind).toBe('applied');
      expect((await finish(b.runId)).kind).toBe('duplicate'); // a replay says nothing more
      events = await roomEvents$(roomId);
      expect(events).toHaveLength(2);
      const done = RoomRunView.parse(events[1].data);
      expect(done).toMatchObject({
        status: 'done',
        verdict: 'AC',
        output: '42\n',
        timeMs: 14,
        by: iv.handle,
        truncated: false,
      });

      // each member reads the same row, the observer too
      for (const who of [iv, cand, obs]) {
        const list = await call('get', `/rooms/${roomId}/runs`, who);
        expect(list.status).toBe(200);
        expect(list.body.items).toHaveLength(1);
        expect(list.body.items[0]).toEqual(done);
      }
      expect((await call('get', `/rooms/${roomId}/runs`, await makeUser())).status).toBe(404);
      expect((await call('get', `/rooms/${roomId}/runs`)).status).toBe(401);
    });

    it('a submission shows per-test verdicts and times only, long output is cut, a compile error and a system error are reported', async () => {
      const { roomId, cand } = await makeRoom(true);
      const sub = submitBody();
      await call('post', `/rooms/${roomId}/runs`, cand, sub);
      await finish(sub.runId, {
        verdict: 'WA',
        tests: [
          { no: 1, verdict: 'AC', timeMs: 3, memKb: 1000 },
          { no: 2, verdict: 'WA', timeMs: 5, memKb: 1000, checkerMsg: 'expected 7 found 8' },
        ],
        output: undefined,
      });
      const first = (await call('get', `/rooms/${roomId}/runs`, cand)).body.items[0];
      expect(first).toMatchObject({
        mode: 'submit',
        verdict: 'WA',
        tests: [
          { no: 1, verdict: 'AC', timeMs: 3 },
          { no: 2, verdict: 'WA', timeMs: 5 },
        ],
      });
      expect(JSON.stringify(first)).not.toContain('expected 7'); // the checker's message may quote a hidden test
      await sleep(2100);

      const long = body();
      await call('post', `/rooms/${roomId}/runs`, cand, long);
      await finish(long.runId, { output: 'x'.repeat(ROOM_RUN_OUTPUT_CAP + 500) });
      const cut = (await call('get', `/rooms/${roomId}/runs`, cand)).body.items.find(
        (i: { runId: string }) => i.runId === long.runId,
      );
      expect(cut.output).toHaveLength(ROOM_RUN_OUTPUT_CAP);
      expect(cut.truncated).toBe(true);
      await sleep(2100);

      const ce = body({ source: 'int main(' });
      await call('post', `/rooms/${roomId}/runs`, cand, ce);
      await finish(ce.runId, {
        verdict: 'CE',
        tests: [],
        compileLog: 'error: expected )',
        output: undefined,
      });
      expect(
        (await call('get', `/rooms/${roomId}/runs`, cand)).body.items.find(
          (i: { runId: string }) => i.runId === ce.runId,
        ),
      ).toMatchObject({ verdict: 'CE', compileLog: 'error: expected )' });
    }, 20_000);

    it('only members get the room topic: a ticket for it is refused to everyone else', async () => {
      const { roomId, obs } = await makeRoom();
      const ticket = (who?: { token: string }) =>
        call('post', '/realtime/ticket', who, { topics: [`room:${roomId}`] });
      expect((await ticket(obs)).status).toBe(200);
      expect((await ticket(await makeUser())).status).toBe(403);
      expect((await ticket()).status).toBe(403);
    });

    it('FR-PAD-08 (priority): with contest and practice queues full, a pad run waits only behind the contest lane', async () => {
      const { roomId, iv } = await makeRoom();
      // synthetic load: 40 contest jobs and 40 practice jobs already waiting
      const stream = (lane: string) => `${prefix}jobs:${lane}`;
      for (const lane of ['contest', 'practice']) {
        for (let i = 0; i < 40; i++)
          await redis.xadd(
            stream(lane),
            '*',
            'job',
            JSON.stringify({ submissionId: randomUUID(), lane }),
          );
      }
      const b = body();
      expect((await call('post', `/rooms/${roomId}/runs`, iv, b)).status).toBe(202);
      const lengths = {
        contest: await redis.xlen(stream('contest')),
        interactive: await redis.xlen(stream('interactive')),
        practice: await redis.xlen(stream('practice')),
      };
      expect(lengths.interactive).toBeGreaterThanOrEqual(1);
      // The run sits in its own lane. Under the strict priority rule (ADR-005, `lanes.go`: contest, interactive, practice,
      // rejudge) what is served before it is the contest lane only, never the 40 waiting practice jobs: the worker's lane
      // tests (`lanes_test.go`) prove the order, this proves the room's job is in the lane they order.
      const inPractice = (await redis.xrange(stream('practice'), '-', '+')).some(([, f]) =>
        f.join('').includes(b.runId),
      );
      expect(inPractice).toBe(false);
      expect(await jobsOf(b.runId)).toHaveLength(1);
      expect(lengths.practice).toBe(40);
      expect(lengths.contest).toBe(40);
    });
  },
);
