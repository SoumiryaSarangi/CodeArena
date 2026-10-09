import { createHash } from 'node:crypto';
import {
  ROOM_SESSION_MAX_MINUTES,
  type RoomSummaryRequest,
  type RoomSummaryView,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import {
  customRuns,
  interviewerNotes,
  problemVersions,
  problems,
  roomEvents,
  roomMembers,
  roomSnapshots,
  roomSummaries,
  rooms,
  users,
} from '../../db/schema';
import { LOGGER } from '../../telemetry/logger';
import { AiLedger } from '../ai/ledger';
import { AiRouter } from '../ai/router';
import {
  buildSummaryInput,
  type EditStats,
  type EventFact,
  type Role,
  type RunFact,
} from './room-summary-facts';
import {
  hasAllSummarySections,
  NOTES_CHARS,
  ROOM_SUMMARY,
  ROOM_SUMMARY_PROMPT_VERSION,
} from './room-summary-prompts';

const tracer = trace.getTracer('api');
const summariesTotal = metrics.getMeter('api').createCounter('ca_room_summaries_total', {
  description: 'AI interview summaries by outcome (never their text)',
});

/** Summaries written per interviewer per hour, on top of the AI layer's own limits. */
const PER_HOUR = 10;

interface Actor {
  id: string;
}

/**
 * CP-11 (FR-PAD-16, US-10.10): the interviewer-only AI summary of a finished session. The facts come from the database
 * (`room-summary-facts.ts`) and go to a model as delimited data, together with the last run's code, the code before each
 * fix and, only if the interviewer ticks it, their own notes. The answer must have four sections in order (one stricter
 * retry). The same facts again return the stored text without calling a model. Only the interviewer of that room can
 * read or write it: a stranger is told 404, anyone else in the room 403.
 */
@Injectable()
export class RoomSummaryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AiRouter) private readonly router: AiRouter,
    @Inject(AiLedger) private readonly ledger: AiLedger,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  private async interviewerOf(user: Actor, roomId: string) {
    const [m] = await this.db
      .select({ room: rooms, role: roomMembers.role })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1);
    if (!m) throw new ProblemError('not-found', 'No such room');
    if (m.role !== 'interviewer')
      throw new ProblemError('forbidden', 'Only the interviewer can use the summary');
    return m.room;
  }

  private view(row: typeof roomSummaries.$inferSelect | undefined): RoomSummaryView {
    return row
      ? {
          status: 'ready',
          bodyMd: row.contentMd,
          usedNotes: row.usedNotes,
          generatedAt: row.updatedAt.toISOString(),
          model: row.model,
        }
      : { status: 'none', bodyMd: null, usedNotes: null, generatedAt: null, model: null };
  }

  async get(user: Actor, roomId: string): Promise<RoomSummaryView> {
    await this.interviewerOf(user, roomId);
    const [row] = await this.db
      .select()
      .from(roomSummaries)
      .where(eq(roomSummaries.roomId, roomId))
      .limit(1);
    return this.view(row);
  }

  async write(user: Actor, roomId: string, body: RoomSummaryRequest): Promise<RoomSummaryView> {
    return tracer.startActiveSpan('rooms.summary', async (span) => {
      let outcome = 'ready';
      let lock: string | null = null;
      try {
        const room = await this.interviewerOf(user, roomId);
        const endedAt =
          room.closedAt ?? new Date(room.createdAt.getTime() + ROOM_SESSION_MAX_MINUTES * 60_000);
        if (room.status === 'open' && Date.now() < endedAt.getTime()) {
          outcome = 'still-open';
          throw new ProblemError('validation', 'The summary is written after the room has ended');
        }
        await this.router.guardUser('room-summary', user.id, PER_HOUR);

        const data = await this.gather(roomId, room, endedAt);
        if (data.input.edits.total === 0 && data.input.runs.length === 0) {
          outcome = 'empty';
          throw new ProblemError(
            'validation',
            'Nothing was written or run in this room, so there is nothing to summarise',
          );
        }
        const built = buildSummaryInput(data.input);
        const notes =
          body.useNotes && data.notes.trim() !== '' ? data.notes.slice(0, NOTES_CHARS) : null;
        const inputHash = createHash('sha256')
          .update(
            JSON.stringify({
              d: built.digest,
              c: built.codes,
              n: notes,
              s: data.statement,
              v: ROOM_SUMMARY_PROMPT_VERSION,
            }),
          )
          .digest('hex');

        const [stored] = await this.db
          .select()
          .from(roomSummaries)
          .where(eq(roomSummaries.roomId, roomId))
          .limit(1);
        if (stored && stored.inputHash === inputHash) {
          outcome = 'cached';
          return this.view(stored);
        }

        lock = `room-summary:${roomId}`;
        if (!(await this.ledger.tryLock(lock, 120))) {
          lock = null;
          outcome = 'busy-here';
          throw new ProblemError('conflict', 'A summary is already being written for this room');
        }
        let text: string | null = null;
        let model = '';
        let tokens = 0;
        for (let attempt = 0; attempt < 2 && text === null; attempt++) {
          const r = await this.router.complete({
            task: 'room_summary',
            feature: 'room-summary',
            messages: ROOM_SUMMARY.render({
              digest: built.digest,
              statement: data.statement,
              codes: built.codes,
              notes,
              strict: attempt > 0,
            }),
            maxTokens: 800,
          });
          tokens += r.usage.inputTokens + r.usage.outputTokens;
          model = r.model;
          if (hasAllSummarySections(r.text)) text = r.text.trim();
        }
        if (text === null) {
          outcome = 'bad-format';
          throw new ProblemError(
            'internal',
            'The summary could not be written this time; please try again',
          );
        }
        const values = {
          contentMd: text,
          model,
          promptVersion: ROOM_SUMMARY_PROMPT_VERSION,
          tokens,
          usedNotes: notes !== null,
          inputHash,
          updatedAt: new Date(),
        };
        const [row] = await this.db
          .insert(roomSummaries)
          .values({ roomId, ...values })
          .onConflictDoUpdate({ target: roomSummaries.roomId, set: values })
          .returning();
        return this.view(row);
      } catch (err) {
        if (err instanceof ProblemError && (err.code === 'ai-busy' || err.code === 'rate-limited'))
          outcome = err.code;
        else if (outcome === 'ready') outcome = 'error';
        if (outcome === 'error')
          this.log.warn(
            { roomId, err: { message: (err as Error).message } },
            'room summary failed',
          );
        throw err;
      } finally {
        if (lock) await this.ledger.unlock(lock);
        summariesTotal.add(1, { outcome });
        span.setAttribute('room.summary.outcome', outcome);
        span.end();
      }
    });
  }

  /** Reads everything the summary is made from. People by handle and role only. */
  private async gather(roomId: string, room: typeof rooms.$inferSelect, endedAt: Date) {
    const members = await this.db
      .select({ handle: users.handle, role: roomMembers.role, id: roomMembers.userId })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, roomId));
    const who = new Map(members.map((m) => [m.id, m]));
    const handleOf = (id: string | null) => (id ? (who.get(id)?.handle ?? null) : null);

    let problemTitle: string | null = null;
    let statement: string | null = null;
    if (room.problemId) {
      const [p] = await this.db
        .select({ title: problems.title, statement: problemVersions.statementMd })
        .from(problems)
        .leftJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
        .where(eq(problems.id, room.problemId))
        .limit(1);
      problemTitle = p?.title ?? null;
      statement = p?.statement ?? null;
    }

    const runRows = await this.db
      .select()
      .from(customRuns)
      .where(eq(customRuns.roomId, roomId))
      .orderBy(asc(customRuns.createdAt));
    const snaps = runRows.length
      ? await this.db
          .select({ id: roomSnapshots.id, snapshot: roomSnapshots.snapshot })
          .from(roomSnapshots)
          .where(
            and(
              eq(roomSnapshots.roomId, roomId),
              inArray(
                roomSnapshots.id,
                runRows.map((r) => r.id),
              ),
            ),
          )
      : [];
    const codeOf = new Map(
      snaps.map((s) => {
        try {
          return [
            s.id,
            (JSON.parse(Buffer.from(s.snapshot).toString('utf8')) as { text?: string }).text ??
              null,
          ] as const;
        } catch {
          return [s.id, null] as const;
        }
      }),
    );
    const runs: RunFact[] = runRows.map((r) => {
      const result = (r.result ?? {}) as {
        verdict?: unknown;
        tests?: { no?: unknown; verdict?: unknown }[];
      };
      const failing = Array.isArray(result.tests)
        ? result.tests.find((t) => t.verdict !== 'AC')
        : undefined;
      return {
        at: r.createdAt,
        by: handleOf(r.userId) ?? 'someone',
        mode: r.input === null ? 'submit' : 'run',
        language: r.language,
        verdict: typeof result.verdict === 'string' ? result.verdict : null,
        failedTest: typeof failing?.no === 'number' ? failing.no : null,
        code: codeOf.get(r.id) ?? null,
      };
    });

    const evRows = await this.db
      .select()
      .from(roomEvents)
      .where(
        and(
          eq(roomEvents.roomId, roomId),
          inArray(roomEvents.kind, ['language', 'restore', 'join', 'leave']),
        ),
      )
      .orderBy(asc(roomEvents.seq));
    const events: EventFact[] = evRows.map((e) => ({
      at: e.ts,
      kind: e.kind,
      by: handleOf(e.userId),
      payload: (e.payload ?? null) as Record<string, unknown> | null,
    }));

    const perUser = await this.db.execute(sql`
      select user_id, count(*)::int as n, min(ts) as first_at, max(ts) as last_at
      from room_updates where room_id = ${roomId} group by user_id`);
    const gaps = await this.db.execute(sql`
      select start_at, extract(epoch from gap)::float8 as secs from (
        select lag(ts) over (order by seq) as start_at, ts - lag(ts) over (order by seq) as gap
        from room_updates where room_id = ${roomId}) g
      where gap > interval '60 seconds' order by gap desc limit 5`);
    const rows = perUser.rows as {
      user_id: string | null;
      n: number;
      first_at: Date;
      last_at: Date;
    }[];
    const edits: EditStats = {
      total: rows.reduce((n, r) => n + r.n, 0),
      byUser: rows.map((r) => ({
        handle: handleOf(r.user_id),
        role: r.user_id ? (who.get(r.user_id)?.role ?? null) : null,
        updates: r.n,
      })),
      firstAt: rows.length
        ? new Date(Math.min(...rows.map((r) => new Date(r.first_at).getTime())))
        : null,
      lastAt: rows.length
        ? new Date(Math.max(...rows.map((r) => new Date(r.last_at).getTime())))
        : null,
      silences: (gaps.rows as { start_at: Date; secs: number }[]).map((g) => ({
        startAt: new Date(g.start_at),
        seconds: g.secs,
      })),
    };

    const [note] = await this.db
      .select({ body: interviewerNotes.bodyMd })
      .from(interviewerNotes)
      .where(eq(interviewerNotes.roomId, roomId))
      .limit(1);

    return {
      statement,
      notes: note?.body ?? '',
      input: {
        room: {
          language: room.language,
          durationMin: room.durationMin,
          createdAt: room.createdAt,
          endedAt,
          problemTitle,
          problemStatement: statement,
        },
        members: members.map((m) => ({ handle: m.handle ?? 'someone', role: m.role as Role })),
        runs,
        events,
        edits,
      },
    };
  }
}
