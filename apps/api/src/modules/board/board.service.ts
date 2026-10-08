import { randomBytes } from 'node:crypto';
import {
  ContestRules,
  type BoardCell,
  type BoardDiffData,
  type BoardRow,
  type BoardSnapshot,
  type Role,
} from '@codearena/contracts';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { contestProblems, contests, participants, submissions, users } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { publishEvent } from '../realtime/events';
import {
  EMPTY_CELL,
  computeCell,
  computeRow,
  pack,
  unpack,
  type BoardSub,
  type Cell,
} from './scoring';

const tracer = trace.getTracer('api');
const meter = metrics.getMeter('api');
const updates = meter.createCounter('ca_board_updates_total', {
  description: 'Board cell updates, by outcome',
});
const rebuilds = meter.createCounter('ca_board_rebuilds_total', {
  description: 'Boards rebuilt from Postgres, by reason',
});
const diffs = meter.createCounter('ca_board_diffs_total', {
  description: 'board.diff events published',
});

/** SD-§7: boards live 30 days after their last change. */
const TTL_MS = 30 * 24 * 3600 * 1000;
/** ≤ 2 diffs per second per contest (FR-BOARD-04), across API instances. */
const FLUSH_MS = 500;
const RETRY_MS = [1000, 3000, 10000];

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ContestRow = typeof contests.$inferSelect;

/**
 * Stores one cell in both views and recomputes that user's two row scores from all their cells,
 * atomically, so a concurrent update of another cell of the same user cannot leave a stale score.
 * Same formula as `pack(computeRow(...))` (checked by the tests).
 * KEYS: live zset, frozen zset, live cells, frozen cells, version, dirty set.
 * ARGV: uid, label (empty: only rescore), live cell JSON, frozen cell JSON, penaltyMinutes, ttl ms, labels...
 */
const APPLY = `
local uid, label, pen = ARGV[1], ARGV[2], tonumber(ARGV[5])
if label ~= '' then
  redis.call('HSET', KEYS[3], uid .. ':' .. label, ARGV[3])
  redis.call('HSET', KEYS[4], uid .. ':' .. label, ARGV[4])
end
local function score(hkey)
  local solved, penalty, last = 0, 0, 0
  for i = 7, #ARGV do
    local raw = redis.call('HGET', hkey, uid .. ':' .. ARGV[i])
    if raw then
      local c = cjson.decode(raw)
      if type(c.m) == 'number' then
        solved = solved + 1
        penalty = penalty + c.m + pen * c.a
        if c.m > last then last = c.m end
      end
    end
  end
  if penalty > 131071 then penalty = 131071 end
  if last > 1023 then last = 1023 end
  return solved * 134217728 + (131071 - penalty) * 1024 + (1023 - last)
end
redis.call('ZADD', KEYS[1], score(KEYS[3]), uid)
redis.call('ZADD', KEYS[2], score(KEYS[4]), uid)
local v = redis.call('INCR', KEYS[5])
redis.call('SADD', KEYS[6], uid)
for i = 1, 6 do redis.call('PEXPIRE', KEYS[i], ARGV[6]) end
return v
`;

export interface BoardViewer {
  id: string;
  role: Role;
}

/**
 * The contest leaderboard (C-02, SD-§5.5/§9). Every update recomputes one (user, problem) cell
 * from Postgres with the pure functions in `scoring.ts`, so the outcome does not depend on the
 * order verdicts arrive in, a rejudge or disqualification is just another update, and a rebuild
 * equals the live board by construction (FR-BOARD-03).
 */
@Injectable()
export class BoardService implements OnModuleDestroy {
  private readonly prefix: string;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Tests only: a random pause between reading a cell and writing it, to expose races. */
  testDelayMs = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {
    this.prefix = config.QUEUE_KEY_PREFIX;
  }

  keys(cid: string) {
    const b = `${this.prefix}board:${cid}`;
    return {
      live: b,
      frozen: `${b}:frozen`,
      cells: `${b}:cells`,
      frozenCells: `${b}:frozen:cells`,
      version: `${b}:ver`,
      dirty: `${b}:dirty`,
      flush: `${b}:flush`,
    };
  }

  private applyKeys(cid: string) {
    const k = this.keys(cid);
    return [k.live, k.frozen, k.cells, k.frozenCells, k.version, k.dirty];
  }

  private async contest(cid: string): Promise<ContestRow | undefined> {
    const [c] = await this.db.select().from(contests).where(eq(contests.id, cid)).limit(1);
    return c;
  }

  private async problemsOf(cid: string) {
    return this.db
      .select({ label: contestProblems.label, versionId: contestProblems.versionId })
      .from(contestProblems)
      .where(eq(contestProblems.contestId, cid))
      .orderBy(asc(contestProblems.position));
  }

  private subsQuery(tx: Tx | Db) {
    return tx
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
      .from(submissions);
  }

  private static toSub(r: {
    id: string;
    createdAt: Date;
    minute: number | null;
    status: BoardSub['status'];
    verdict: string | null;
    disqualified: boolean;
    afterFreeze: boolean;
  }): BoardSub {
    return {
      id: r.id,
      createdAt: r.createdAt.getTime(),
      minute: r.minute ?? 0,
      status: r.status,
      verdict: r.verdict,
      disqualified: r.disqualified,
      afterFreeze: r.afterFreeze,
    };
  }

  /**
   * Recomputes the cell of `userId` on the problem judged at `versionId` (a contest submission was
   * created, judged, rejudged or disqualified). Never throws: the verdict or submission that
   * triggered it must not fail because of the board. A failure is retried in the background; the
   * update is idempotent.
   */
  async update(contestId: string, userId: string, versionId: string): Promise<void> {
    await this.attempt(contestId, userId, versionId, 0);
  }

  private async attempt(cid: string, uid: string, versionId: string, n: number): Promise<void> {
    try {
      await this.updateCell(cid, uid, versionId);
      updates.add(1, { outcome: 'ok' });
    } catch (err) {
      updates.add(1, { outcome: 'error' });
      this.log.warn(
        { err: { message: (err as Error).message }, contestId: cid, userId: uid, attempt: n + 1 },
        'board update failed',
      );
      const wait = RETRY_MS[n];
      if (wait !== undefined) {
        setTimeout(() => void this.attempt(cid, uid, versionId, n + 1), wait).unref();
      }
    }
  }

  private async updateCell(cid: string, uid: string, versionId: string): Promise<void> {
    await tracer.startActiveSpan('board.update', async (span) => {
      try {
        span.setAttribute('contest.id', cid);
        const k = this.keys(cid);
        // A board that is gone (expired, Redis flushed) is rebuilt whole: writing one cell into an
        // empty board would leave a partial board that looks complete.
        if ((await this.redis.exists(k.live)) === 0) {
          await this.rebuild(cid, 'missing');
          return;
        }
        const c = await this.contest(cid);
        if (!c) return;
        const problems = await this.problemsOf(cid);
        const label = problems.find((p) => p.versionId === versionId)?.label;
        if (!label) return; // not a problem of this contest (any more)
        const rules = ContestRules.parse(c.rules);
        await this.db.transaction(async (tx) => {
          // Shared contest lock (a rebuild takes it exclusively), then this cell's own lock: the
          // read and the write of one cell are serialised, so the last writer has read the latest
          // committed state.
          await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${`board:${cid}`}))`);
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`cell:${cid}:${uid}:${label}`}))`,
          );
          const rows = await this.subsQuery(tx).where(
            and(
              eq(submissions.contestId, cid),
              eq(submissions.userId, uid),
              eq(submissions.problemVersionId, versionId),
            ),
          );
          const subs = rows.map(BoardService.toSub);
          const live = computeCell(subs, rules);
          const frozen = computeCell(subs, rules, true);
          if (this.testDelayMs > 0) {
            await new Promise((r) => setTimeout(r, Math.random() * this.testDelayMs));
          }
          await this.redis.eval(
            APPLY,
            6,
            ...this.applyKeys(cid),
            uid,
            label,
            JSON.stringify(live),
            JSON.stringify(frozen),
            rules.penaltyMinutes,
            TTL_MS,
            ...problems.map((p) => p.label),
          );
        });
        this.schedule(cid);
      } finally {
        span.end();
      }
    });
  }

  /** A registered user appears on the board with nothing solved. */
  async addParticipant(cid: string, uid: string): Promise<void> {
    try {
      const k = this.keys(cid);
      if ((await this.redis.exists(k.live)) === 0) {
        await this.rebuild(cid, 'missing');
        return;
      }
      const zero = pack({ solved: 0, penalty: 0, lastAc: null });
      await this.redis
        .multi()
        .zadd(k.live, 'NX', zero, uid)
        .zadd(k.frozen, 'NX', zero, uid)
        .incr(k.version)
        .sadd(k.dirty, uid)
        .pexpire(k.live, TTL_MS)
        .pexpire(k.frozen, TTL_MS)
        .pexpire(k.version, TTL_MS)
        .pexpire(k.dirty, TTL_MS)
        .exec();
      this.schedule(cid);
    } catch (err) {
      this.log.warn(
        { err: { message: (err as Error).message }, contestId: cid },
        'board add failed',
      );
    }
  }

  /**
   * SD-§9.3 / FR-BOARD-08: the whole board from Postgres, with the same functions as the live
   * path. Built under temporary names and swapped in with RENAME, so readers never see it empty.
   * Returns the new version.
   */
  async rebuild(cid: string, reason: 'admin' | 'missing' | 'test' = 'admin'): Promise<number> {
    return tracer.startActiveSpan('board.rebuild', async (span) => {
      try {
        span.setAttribute('contest.id', cid);
        const c = await this.contest(cid);
        if (!c) return 0;
        const rules = ContestRules.parse(c.rules);
        const problems = await this.problemsOf(cid);
        const labelOf = new Map(problems.map((p) => [p.versionId, p.label]));
        const version = await this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`board:${cid}`}))`);
          const people = await tx
            .select({ uid: participants.userId })
            .from(participants)
            .where(eq(participants.contestId, cid));
          const rows = await this.subsQuery(tx).where(eq(submissions.contestId, cid));
          const byCell = new Map<string, BoardSub[]>();
          const uids = new Set(people.map((p) => p.uid));
          for (const r of rows) {
            const label = labelOf.get(r.versionId);
            if (!label) continue;
            uids.add(r.userId);
            const key = `${r.userId}:${label}`;
            if (!byCell.has(key)) byCell.set(key, []);
            byCell.get(key)!.push(BoardService.toSub(r));
          }
          const live = new Map<string, Cell>();
          const frozen = new Map<string, Cell>();
          for (const [key, subs] of byCell) {
            live.set(key, computeCell(subs, rules));
            frozen.set(key, computeCell(subs, rules, true));
          }
          const scoreOf = (cells: Map<string, Cell>, uid: string) =>
            pack(
              computeRow(
                problems.map((p) => cells.get(`${uid}:${p.label}`) ?? EMPTY_CELL),
                rules,
              ),
            );

          const k = this.keys(cid);
          const tmp = `:tmp:${randomBytes(6).toString('hex')}`;
          const m = this.redis.multi();
          const swap: [string, number][] = [
            [k.live, uids.size],
            [k.frozen, uids.size],
            [k.cells, live.size],
            [k.frozenCells, frozen.size],
          ];
          for (const uid of uids) {
            m.zadd(k.live + tmp, scoreOf(live, uid), uid);
            m.zadd(k.frozen + tmp, scoreOf(frozen, uid), uid);
          }
          for (const [key, cell] of live) m.hset(k.cells + tmp, key, JSON.stringify(cell));
          for (const [key, cell] of frozen) m.hset(k.frozenCells + tmp, key, JSON.stringify(cell));
          for (const [key, size] of swap) {
            if (size === 0) m.del(key);
            else m.rename(key + tmp, key).pexpire(key, TTL_MS);
          }
          m.incr(k.version).pexpire(k.version, TTL_MS);
          if (uids.size > 0) m.sadd(k.dirty, ...uids).pexpire(k.dirty, TTL_MS);
          const res = await m.exec();
          const failed = res?.find(([e]) => e);
          if (!res || failed) throw failed?.[0] ?? new Error('rebuild transaction aborted');
          // The INCR is the one before the last two (or four) commands; read the counter instead.
          return Number(await this.redis.get(k.version));
        });
        rebuilds.add(1, { reason });
        this.schedule(cid);
        return version;
      } finally {
        span.end();
      }
    });
  }

  /** Whether `viewer` gets the frozen (public) view right now (PRD §9.2, FR-BOARD-05). */
  static frozenFor(c: ContestRow, now: Date, viewer?: BoardViewer, forceFrozen = false) {
    // An admin sees the live board, except when asking for the frozen one (the resolver, C-06).
    if (viewer?.role === 'admin') return forceFrozen;
    return c.freezeAt !== null && now >= c.freezeAt && c.status !== 'finalized';
  }

  private parseCell(raw: string | null | undefined): Cell {
    if (!raw) return EMPTY_CELL;
    try {
      return { ...EMPTY_CELL, ...(JSON.parse(raw) as Partial<Cell>) };
    } catch {
      return EMPTY_CELL;
    }
  }

  private toBoardCell(c: Cell, first: boolean): BoardCell {
    return { attempts: c.a, acMinute: c.m, pending: c.p, first };
  }

  /** First solve per label: the earliest AC by submission time (ties: smaller user id). */
  private firsts(cells: Record<string, string>, labels: string[]) {
    const best = new Map<string, { uid: string; t: number }>();
    for (const [field, raw] of Object.entries(cells)) {
      const i = field.lastIndexOf(':');
      const uid = field.slice(0, i);
      const label = field.slice(i + 1);
      if (!labels.includes(label)) continue;
      const c = this.parseCell(raw);
      if (c.m === null || c.t === null) continue;
      const b = best.get(label);
      if (!b || c.t < b.t || (c.t === b.t && uid < b.uid)) best.set(label, { uid, t: c.t });
    }
    return best;
  }

  /** GET /contests/{slug}/board: the whole board for this viewer. */
  async snapshot(c: ContestRow, viewer?: BoardViewer, view?: 'frozen'): Promise<BoardSnapshot> {
    return tracer.startActiveSpan('board.snapshot', async (span) => {
      try {
        const now = new Date();
        const k = this.keys(c.id);
        if ((await this.redis.exists(k.live)) === 0) await this.rebuild(c.id, 'missing');
        const frozen = BoardService.frozenFor(c, now, viewer, view === 'frozen');
        const zkey = frozen ? k.frozen : k.live;
        const hkey = frozen ? k.frozenCells : k.cells;
        const [scored, cells, liveCells, version, problems, people] = await Promise.all([
          this.redis.zrevrange(zkey, 0, -1, 'WITHSCORES'),
          this.redis.hgetall(hkey),
          frozen && viewer && viewer.role !== 'admin'
            ? this.redis.hgetall(k.cells)
            : Promise.resolve(null),
          this.redis.get(k.version),
          this.problemsOf(c.id),
          this.db
            .select({ uid: users.id, handle: users.handle })
            .from(participants)
            .innerJoin(users, eq(users.id, participants.userId))
            .where(eq(participants.contestId, c.id)),
        ]);
        const labels = problems.map((p) => p.label);
        const handles = new Map(people.map((p) => [p.uid, p.handle ?? 'unknown']));
        const first = this.firsts(cells, labels);
        const scores: number[] = [];
        const order: string[] = [];
        for (let i = 0; i < scored.length; i += 2) {
          order.push(scored[i]!);
          scores.push(Number(scored[i + 1]));
        }
        const rows: BoardRow[] = order.map((uid, i) => {
          const t = unpack(scores[i]!);
          const own = frozen && viewer?.id === uid ? liveCells : null;
          const cellsOut: Record<string, BoardCell> = {};
          for (const label of labels) {
            const raw = (own ?? cells)[`${uid}:${label}`];
            if (!raw) continue;
            cellsOut[label] = this.toBoardCell(
              this.parseCell(raw),
              first.get(label)?.uid === uid && !own,
            );
          }
          return {
            rank: 1 + scores.filter((s) => s > scores[i]!).length,
            userId: uid,
            handle: handles.get(uid) ?? 'unknown',
            solved: t.solved,
            penalty: t.penalty,
            lastAcMinute: t.lastAc,
            score: scores[i]!,
            cells: cellsOut,
          };
        });
        return {
          contestId: c.id,
          serverNow: now.toISOString(),
          version: Number(version ?? 0),
          frozen,
          problems: labels.map((label) => ({
            label,
            solvedCount: Object.entries(cells).filter(
              ([f, raw]) => f.endsWith(`:${label}`) && this.parseCell(raw).m !== null,
            ).length,
            firstSolverId: first.get(label)?.uid ?? null,
          })),
          rows,
        };
      } finally {
        span.end();
      }
    });
  }

  // ----- diffs -----

  /** One flush per contest per FLUSH_MS across all API instances (the NX lease decides who). */
  private schedule(cid: string) {
    if (this.timers.has(cid)) return;
    void this.redis
      .set(this.keys(cid).flush, '1', 'PX', FLUSH_MS, 'NX')
      .then((ok) => {
        if (ok !== 'OK' || this.timers.has(cid)) return;
        const t = setTimeout(() => {
          this.timers.delete(cid);
          void this.flush(cid);
        }, FLUSH_MS);
        t.unref();
        this.timers.set(cid, t);
      })
      .catch(() => undefined);
  }

  /** Publishes the rows that changed since the last flush (FR-BOARD-04: coalesced). */
  async flush(cid: string): Promise<void> {
    try {
      const k = this.keys(cid);
      const uids = (await this.redis.spop(k.dirty, 10_000)) as string[];
      if (uids.length === 0) return;
      const c = await this.contest(cid);
      if (!c) return;
      const labels = (await this.problemsOf(cid)).map((p) => p.label);
      const handles = new Map(
        (
          await this.db
            .select({ uid: users.id, handle: users.handle })
            .from(users)
            .where(
              sql`${users.id} in (${sql.join(
                uids.map((u) => sql`${u}`),
                sql`, `,
              )})`,
            )
        ).map((u) => [u.uid, u.handle ?? 'unknown']),
      );
      const version = Number((await this.redis.get(k.version)) ?? 0);
      const view = async (zkey: string, hkey: string) => {
        const scores = await this.redis.zmscore(zkey, ...uids);
        const fields = uids.flatMap((u) => labels.map((l) => `${u}:${l}`));
        const raw = fields.length ? await this.redis.hmget(hkey, ...fields) : [];
        const all = await this.redis.hgetall(hkey);
        const first = this.firsts(all, labels);
        return uids.flatMap((uid, i): BoardDiffData['rows'] => {
          const score = scores[i];
          if (score === null || score === undefined) return [];
          const t = unpack(Number(score));
          const cells: Record<string, BoardCell> = {};
          labels.forEach((label, j) => {
            const r = raw[i * labels.length + j];
            if (r)
              cells[label] = this.toBoardCell(this.parseCell(r), first.get(label)?.uid === uid);
          });
          return [
            {
              userId: uid,
              handle: handles.get(uid) ?? 'unknown',
              solved: t.solved,
              penalty: t.penalty,
              lastAcMinute: t.lastAc,
              score: Number(score),
              cells,
            },
          ];
        });
      };
      const frozen = BoardService.frozenFor(c, new Date());
      const liveRows = await view(k.live, k.cells);
      const publicRows = frozen ? await view(k.frozen, k.frozenCells) : liveRows;
      await publishEvent<BoardDiffData>(
        this.redis,
        this.prefix,
        this.log,
        `contest:${cid}:board`,
        'board.diff',
        { contestId: cid, version, frozen, rows: publicRows },
      );
      await publishEvent<BoardDiffData>(
        this.redis,
        this.prefix,
        this.log,
        `admin:contest:${cid}:board`,
        'board.diff',
        { contestId: cid, version, frozen: false, rows: liveRows },
      );
      diffs.add(1);
    } catch (err) {
      this.log.warn(
        { err: { message: (err as Error).message }, contestId: cid },
        'board flush failed',
      );
    }
  }

  /** On shutdown, send what is pending instead of leaving clients one diff behind. */
  async onModuleDestroy() {
    const pending = [...this.timers.entries()];
    this.timers.clear();
    for (const [cid, t] of pending) {
      clearTimeout(t);
      await this.flush(cid);
    }
  }
}
