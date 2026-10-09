import { randomBytes, randomUUID } from 'node:crypto';
import { PLAYBACK_CHECKPOINT_EVERY, RoomTimeline } from '@codearena/contracts';
import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { loadConfig } from '../../config/config';
import type { Db } from '../../db/client';
import { customRuns, roomMembers, users } from '../../db/schema';
import { createTestDatabase, postgresReachable } from '../../test/db';
import { ACCESS_TOKENS, type AccessTokens } from '../auth/keys';
import { sql } from 'drizzle-orm';
import { CHUNK_MAX, EVENTS_MAX, KIND_CHECKPOINT, KIND_UPDATE } from './room-playback.service';
import { LOG_RETENTION_DAYS, RoomsRetention } from './rooms-retention.service';

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
const BASE = Date.UTC(2026, 9, 10, 14, 0, 0);

interface Rec {
  kind: number;
  seq: number;
  ts: number;
  text: string;
}
/** Reads the binary answer: `[u8 kind][u32 seq][f64 ts][u32 length][bytes]`. */
function parse(buf: Buffer): Rec[] {
  const out: Rec[] = [];
  let at = 0;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at + 13);
    out.push({
      kind: buf.readUInt8(at),
      seq: buf.readUInt32BE(at + 1),
      ts: buf.readDoubleBE(at + 5),
      text: buf.subarray(at + 17, at + 17 + len).toString(),
    });
    at += 17 + len;
  }
  return out;
}

describe.skipIf(!ready)(
  'CP-06: the timeline and the playback slices (needs Compose Postgres + Redis)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: INestApplication;
    let tokens: AccessTokens;

    type Who = { id: string; token: string; handle: string };
    const makeUser = async (): Promise<Who> => {
      const id = randomUUID();
      const handle = `u${id.slice(0, 8)}`;
      await db.insert(users).values({ id, email: `${id}@example.test`, role: 'user', handle });
      const { token } = await tokens.sign({ sub: id, role: 'user', sid: randomUUID() });
      return { id, token, handle };
    };
    const get = (path: string, who?: { token: string }) => {
      const agent = request(app.getHttpServer());
      const r = agent
        .get(`/api${path}`)
        .set('Cookie', `ca_csrf=${csrf}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      if (who) r.set('Authorization', `Bearer ${who.token}`);
      return r;
    };
    const makeRoom = async () => {
      const [iv, cand, obs, stranger] = [
        await makeUser(),
        await makeUser(),
        await makeUser(),
        await makeUser(),
      ];
      const created = await request(app.getHttpServer())
        .post('/api/rooms')
        .set('Cookie', `ca_csrf=${csrf}`)
        .set('Authorization', `Bearer ${iv.token}`)
        .set('X-CSRF-Token', csrf)
        .send({ language: 'python3', durationMin: 45 });
      const roomId = created.body.id as string;
      await db.insert(roomMembers).values([
        { roomId, userId: cand.id, role: 'candidate' },
        { roomId, userId: obs.id, role: 'observer' },
      ]);
      return { roomId, iv, cand, obs, stranger };
    };
    /** n updates one second apart from BASE, checkpoints every `every`; the bytes say which they are. */
    const seed = async (roomId: string, n: number, every = 10) => {
      await db.execute(sql`insert into room_updates (room_id, seq, ts, user_id, update)
      select ${roomId}::uuid, g, to_timestamp(${BASE / 1000}::float8 + g), null, convert_to('u' || g, 'UTF8') from generate_series(1, ${n}::int) g`);
      await db.execute(sql`insert into room_checkpoints (room_id, seq, state)
      select ${roomId}::uuid, g, convert_to('c' || g, 'UTF8') from generate_series(${every}::int, ${n}::int, ${every}::int) g`);
    };

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
          DATABASE_URL: t.url,
        }),
      );
      await app.init();
      tokens = app.get<AccessTokens>(ACCESS_TOKENS);
    });
    afterAll(async () => {
      await app?.close();
      await drop?.();
    });

    it('FR-PAD-10: only the interviewer replays: a candidate and an observer get 403, a stranger 404, a guest 401', async () => {
      const { roomId, iv, cand, obs, stranger } = await makeRoom();
      await seed(roomId, 12);
      for (const path of [`/rooms/${roomId}/timeline`, `/rooms/${roomId}/playback?toSeq=5`]) {
        expect((await get(path, iv)).status, path).toBe(200);
        expect((await get(path, cand)).status, path).toBe(403);
        expect((await get(path, obs)).status, path).toBe(403);
        expect((await get(path, stranger)).status, path).toBe(404);
        expect((await get(path)).status, path).toBe(401);
      }
      const r = await get(`/rooms/${roomId}/playback?toSeq=5`, iv);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['content-type']).toContain('application/octet-stream');
    });

    it('FR-PAD-10: a seek is the last checkpoint at or before the point plus the updates after it, nothing more', async () => {
      const { roomId, iv } = await makeRoom();
      await seed(roomId, 45, 10);
      const slice = async (qs: string) => {
        const r = await get(`/rooms/${roomId}/playback?${qs}`, iv);
        expect(r.status, qs).toBe(200);
        return {
          recs: parse(r.body),
          from: Number(r.headers['x-playback-from-seq']),
          to: Number(r.headers['x-playback-to-seq']),
        };
      };
      // toSeq = 25: checkpoint 20, then 21..25
      let s = await slice('toSeq=25');
      expect(s.recs.map((r) => [r.kind === KIND_CHECKPOINT ? 'C' : 'U', r.seq, r.text])).toEqual([
        ['C', 20, 'c20'],
        ['U', 21, 'u21'],
        ['U', 22, 'u22'],
        ['U', 23, 'u23'],
        ['U', 24, 'u24'],
        ['U', 25, 'u25'],
      ]);
      expect([s.from, s.to]).toEqual([20, 25]);
      expect(s.recs[1]!.ts).toBe(BASE + 21_000); // each update carries its time
      expect(s.recs[0]!.ts).toBe(BASE + 20_000); // and so does the checkpoint
      // exactly on a checkpoint: that checkpoint and no updates
      s = await slice('toSeq=30');
      expect(s.recs.map((r) => [r.kind, r.seq])).toEqual([[KIND_CHECKPOINT, 30]]);
      // before the first checkpoint: updates only
      s = await slice('toSeq=4');
      expect(s.recs.map((r) => [r.kind, r.seq])).toEqual([1, 2, 3, 4].map((n) => [KIND_UPDATE, n]));
      expect([s.from, s.to]).toEqual([0, 4]);
      // by time: the seek point is the last update at or before that moment (seq 37 is at BASE + 37 s)
      s = await slice(`toTs=${encodeURIComponent(new Date(BASE + 37_500).toISOString())}`);
      expect(s.recs[0]).toMatchObject({ kind: KIND_CHECKPOINT, seq: 30 });
      expect(s.recs.at(-1)).toMatchObject({ kind: KIND_UPDATE, seq: 37 });
      s = await slice(`toTs=${encodeURIComponent(new Date(BASE - 5000).toISOString())}`); // before everything
      expect(s.recs).toEqual([]);
      s = await slice(`toTs=${encodeURIComponent(new Date(BASE + 9e9).toISOString())}`); // after everything: the end of the log
      expect(s.recs[0]).toMatchObject({ kind: KIND_CHECKPOINT, seq: 40 });
      expect(s.recs.at(-1)).toMatchObject({ seq: 45 });
      // a chunk for playing on: updates after fromSeq, no checkpoint
      s = await slice('fromSeq=30&toSeq=33');
      expect(s.recs.map((r) => [r.kind, r.seq])).toEqual([
        [1, 31],
        [1, 32],
        [1, 33],
      ]);
      expect([s.from, s.to]).toEqual([30, 33]);
      s = await slice('fromSeq=44');
      expect(s.recs.map((r) => r.seq)).toEqual([45]);
      s = await slice('fromSeq=45');
      expect(s.recs).toEqual([]);
      expect(s.to).toBe(45);
    });

    it('refuses a request that names no point, two, or a nonsense one; a room without a log answers empty', async () => {
      const { roomId, iv } = await makeRoom();
      for (const bad of [
        '',
        'toSeq=5&toTs=2026-10-10T14:00:00Z',
        'fromSeq=3&toTs=2026-10-10T14:00:00Z',
        'toTs=yesterday',
        'toSeq=-1',
        'toSeq=abc',
        'extra=1&toSeq=1',
      ]) {
        expect((await get(`/rooms/${roomId}/playback?${bad}`, iv)).status, bad).toBe(400);
      }
      const empty = await get(`/rooms/${roomId}/playback?toSeq=10`, iv);
      expect(empty.status).toBe(200);
      expect(empty.body.length).toBe(0);
      expect(empty.headers['x-playback-to-seq']).toBe('0');
      const t = RoomTimeline.parse(
        (await get(`/rooms/${roomId}/timeline`, iv)).body.toString().length
          ? JSON.parse((await get(`/rooms/${roomId}/timeline`, iv)).body.toString())
          : {},
      );
      expect(t).toMatchObject({
        updates: 0,
        lastSeq: 0,
        events: [],
        eventsCut: false,
        checkpointEvery: PLAYBACK_CHECKPOINT_EVERY,
      });
    });

    it("FR-PAD-10: the timeline has the session's span, counts, and the markers: joins, language changes and runs with their verdicts", async () => {
      const { roomId, iv, cand } = await makeRoom();
      await seed(roomId, 30);
      const ev = (seq: number, at: number, kind: string, user: string | null, payload: object) =>
        db.execute(
          sql`insert into room_events (room_id, seq, ts, user_id, kind, payload) values (${roomId}::uuid, ${seq}, to_timestamp(${(BASE + at) / 1000}::float8), ${user}::uuid, ${kind}::room_event_kind, ${JSON.stringify(payload)}::jsonb)`,
        );
      const runId = randomUUID();
      await db.insert(customRuns).values({
        id: runId,
        userId: cand.id,
        roomId,
        language: 'python3',
        source: 'x',
        input: '',
        status: 'done',
        result: { verdict: 'AC', timeMs: 5 },
      });
      const pending = randomUUID();
      await db.insert(customRuns).values({
        id: pending,
        userId: iv.id,
        roomId,
        language: 'python3',
        source: 'x',
        input: null,
        status: 'queued',
      });
      await ev(1, -4000, 'join', iv.id, {});
      await ev(2, 2000, 'join', cand.id, {});
      await ev(3, 9000, 'language', iv.id, { language: 'python3' });
      await ev(4, 15000, 'run', cand.id, { runId, mode: 'run' });
      await ev(5, 20000, 'run', iv.id, { runId: pending, mode: 'submit' });
      await ev(6, 40000, 'leave', cand.id, {});
      const r = await get(`/rooms/${roomId}/timeline`, iv);
      expect(r.status).toBe(200);
      const t = RoomTimeline.parse(JSON.parse(r.body.toString()));
      expect(t.updates).toBe(30);
      expect(t.lastSeq).toBe(30);
      expect(t.startedAt <= new Date(BASE - 4000).toISOString()).toBe(true); // the first join is before the first edit
      expect(new Date(t.endedAt).getTime()).toBe(BASE + 40_000); // the last thing that happened
      expect(t.durationMs).toBe(new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime());
      expect(t.events.map((e) => [e.seq, e.kind, e.by])).toEqual([
        [1, 'join', iv.handle],
        [2, 'join', cand.handle],
        [3, 'language', iv.handle],
        [4, 'run', cand.handle],
        [5, 'run', iv.handle],
        [6, 'leave', cand.handle],
      ]);
      expect(t.events[2]).toMatchObject({ language: 'python3' });
      expect(t.events[3]).toMatchObject({ mode: 'run', verdict: 'AC', runId });
      expect(t.events[4]).toMatchObject({ mode: 'submit', verdict: null, runId: pending }); // not judged (yet)
    });

    it('the timeline sends the first 2000 markers and says it cut the rest', async () => {
      const { roomId, iv } = await makeRoom();
      await db.execute(sql`insert into room_events (room_id, seq, ts, kind, payload)
      select ${roomId}::uuid, g, to_timestamp(${BASE / 1000}::float8 + g), 'join', '{}'::jsonb from generate_series(1, ${EVENTS_MAX + 50}::int) g`);
      const t = RoomTimeline.parse(
        JSON.parse((await get(`/rooms/${roomId}/timeline`, iv)).body.toString()),
      );
      expect(t.events).toHaveLength(EVENTS_MAX);
      expect(t.eventsCut).toBe(true);
    }, 20_000);

    it('FR-PAD-10: a 60-minute session of 36,000 updates seeks in under a second, and the answer does not grow with the session', async () => {
      const { roomId, iv } = await makeRoom();
      const N = 36_000;
      // ten updates a second for an hour
      await db.execute(sql`insert into room_updates (room_id, seq, ts, user_id, update)
      select ${roomId}::uuid, g, to_timestamp(${BASE / 1000}::float8 + g / 10.0), null, convert_to('u' || g, 'UTF8') from generate_series(1, ${N}::int) g`);
      await db.execute(sql`insert into room_checkpoints (room_id, seq, state)
      select ${roomId}::uuid, g, convert_to(repeat('c', 4000), 'UTF8') from generate_series(${PLAYBACK_CHECKPOINT_EVERY}::int, ${N}::int, ${PLAYBACK_CHECKPOINT_EVERY}::int) g`);
      await db.execute(sql`analyze room_updates`);
      const points = [0.05, 0.3, 0.5, 0.77, 0.99].map((f) =>
        new Date(BASE + Math.floor(N * f) * 100).toISOString(),
      );
      const timings: number[] = [];
      for (const p of points) {
        const t0 = performance.now();
        const r = await get(`/rooms/${roomId}/playback?toTs=${encodeURIComponent(p)}`, iv);
        timings.push(performance.now() - t0);
        expect(r.status).toBe(200);
        const recs = parse(r.body);
        expect(recs[0]!.kind).toBe(KIND_CHECKPOINT);
        expect(recs.length).toBeLessThanOrEqual(1 + PLAYBACK_CHECKPOINT_EVERY); // one checkpoint and at most one interval of updates
      }
      console.info(
        `seek timings over 36,000 updates (ms): ${timings.map((t) => Math.round(t)).join(', ')}`,
      );
      expect(
        Math.max(...timings),
        `seeks took ${timings.map((t) => Math.round(t)).join(', ')} ms`,
      ).toBeLessThan(1000);
      const tl = await get(`/rooms/${roomId}/timeline`, iv);
      expect(JSON.parse(tl.body.toString()).updates).toBe(N);
      // a chunk to play on is bounded too
      const chunk = parse((await get(`/rooms/${roomId}/playback?fromSeq=100`, iv)).body);
      expect(chunk).toHaveLength(CHUNK_MAX);
    }, 60_000);

    it('SD §6.4: 90 days after a room closed its log and checkpoints go; the final document, events and anything newer stay', async () => {
      const retention = app.get(RoomsRetention);
      const mk = async (ageDays: number | null, closed: boolean) => {
        const { roomId } = await makeRoom();
        await seed(roomId, 25);
        await db.execute(
          sql`insert into room_docs (room_id, state) values (${roomId}::uuid, 'final'::bytea)`,
        );
        await db.execute(
          sql`insert into room_events (room_id, seq, kind) values (${roomId}::uuid, 1, 'join')`,
        );
        const at =
          ageDays === null ? sql`now()` : sql`now() - (${ageDays}::int * interval '1 day')`;
        await db.execute(
          sql`update rooms set created_at = ${at} - interval '1 hour', closed_at = ${closed ? at : null}, status = ${closed ? 'closed' : 'open'}::room_status where id = ${roomId}::uuid`,
        );
        return roomId;
      };
      const old = await mk(LOG_RETENTION_DAYS + 1, true);
      const unclosed = await mk(LOG_RETENTION_DAYS + 5, false); // nobody pressed End: counts from the end of its session
      const recent = await mk(LOG_RETENTION_DAYS - 1, true);
      const live = await mk(null, false);
      const out = await retention.purge();
      expect(out.updates).toBeGreaterThanOrEqual(50);
      const count = async (t: string, id: string) =>
        Number(
          (
            (
              await db.execute(
                sql.raw(`select count(*)::int as n from ${t} where room_id = '${id}'`),
              )
            ).rows[0] as { n: number }
          ).n,
        );
      for (const id of [old, unclosed]) {
        expect(await count('room_updates', id)).toBe(0);
        expect(await count('room_checkpoints', id)).toBe(0);
        expect(await count('room_docs', id), 'the final document stays').toBe(1);
        expect(await count('room_events', id), 'the events stay').toBe(1);
      }
      for (const id of [recent, live]) {
        expect(await count('room_updates', id)).toBe(25);
        expect(await count('room_checkpoints', id)).toBe(2);
      }
      expect((await retention.purge()).updates).toBe(0); // again: nothing left to do
    });
  },
);
