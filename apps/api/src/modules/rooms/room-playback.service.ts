import {
  PLAYBACK_CHECKPOINT_EVERY,
  type RoomRunMode,
  type RoomTimeline,
  type RoomTimelineEvent,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import {
  customRuns,
  roomCheckpoints,
  roomEvents,
  roomMembers,
  roomUpdates,
  rooms,
  users,
} from '../../db/schema';

const tracer = trace.getTracer('api');
const plays = metrics.getMeter('api').createCounter('ca_room_playback_total', {
  description: 'Replay requests: timeline, seek and chunk',
});

export const EVENTS_MAX = 2000;
/** The most updates one playback answer carries after its checkpoint (a seek has at most one checkpoint interval). */
export const CHUNK_MAX = 1000;
export const KIND_CHECKPOINT = 0;
export const KIND_UPDATE = 1;

interface Actor {
  id: string;
}

export interface PlaybackQuery {
  toTs?: string;
  toSeq?: number;
  fromSeq?: number;
}

/** One record of the binary answer: `[u8 kind][u32 seq][f64 ts ms][u32 length][bytes]`, all big-endian. */
export function frame(
  records: { kind: number; seq: number; ts: number; bytes: Uint8Array }[],
): Buffer {
  const parts: Buffer[] = [];
  for (const r of records) {
    const head = Buffer.alloc(17);
    head.writeUInt8(r.kind, 0);
    head.writeUInt32BE(r.seq, 1);
    head.writeDoubleBE(r.ts, 5);
    head.writeUInt32BE(r.bytes.byteLength, 13);
    parts.push(head, Buffer.from(r.bytes));
  }
  return Buffer.concat(parts);
}

/**
 * CP-06 (SD-§11.4, FR-PAD-10): what the interviewer's replay reads. The log is written by the collab server; this only
 * slices it: a seek is the last checkpoint at or before the point plus the (at most ~200) updates after it, so it does not
 * grow with the length of the session.
 */
@Injectable()
export class RoomPlaybackService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async interviewerOf(user: Actor, roomId: string) {
    const [m] = await this.db
      .select({ role: roomMembers.role, room: rooms })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1);
    if (!m) throw new ProblemError('not-found', 'No such room');
    if (m.role !== 'interviewer')
      throw new ProblemError('forbidden', 'Only the interviewer can replay a session');
    return m.room;
  }

  async timeline(user: Actor, roomId: string): Promise<RoomTimeline> {
    return tracer.startActiveSpan('rooms.timeline', async (span) => {
      try {
        const room = await this.interviewerOf(user, roomId);
        const [agg] = await this.db
          .select({
            n: sql<number>`count(*)::int`,
            last: sql<number>`coalesce(max(${roomUpdates.seq}), 0)::int`,
            first: sql<Date | null>`min(${roomUpdates.ts})`,
            end: sql<Date | null>`max(${roomUpdates.ts})`,
          })
          .from(roomUpdates)
          .where(eq(roomUpdates.roomId, roomId));
        const evs = await this.db
          .select({
            seq: roomEvents.seq,
            ts: roomEvents.ts,
            kind: roomEvents.kind,
            payload: roomEvents.payload,
            by: users.handle,
          })
          .from(roomEvents)
          .leftJoin(users, eq(users.id, roomEvents.userId))
          .where(eq(roomEvents.roomId, roomId))
          .orderBy(asc(roomEvents.seq))
          .limit(EVENTS_MAX + 1);
        const cut = evs.length > EVENTS_MAX;
        const list = evs.slice(0, EVENTS_MAX);
        const runIds = list
          .map((e) =>
            e.kind === 'run' ? (e.payload as { runId?: string } | null)?.runId : undefined,
          )
          .filter((x): x is string => !!x);
        const verdicts = new Map<string, string | null>();
        if (runIds.length > 0) {
          const rows = await this.db
            .select({ id: customRuns.id, result: customRuns.result })
            .from(customRuns)
            .where(inArray(customRuns.id, runIds));
          for (const r of rows)
            verdicts.set(r.id, ((r.result ?? {}) as { verdict?: string }).verdict ?? null);
        }
        const events: RoomTimelineEvent[] = list.map((e) => {
          const p = (e.payload ?? {}) as Record<string, unknown>;
          const out: RoomTimelineEvent = {
            seq: e.seq,
            ts: e.ts.toISOString(),
            kind: e.kind,
            by: e.by ?? null,
          };
          if (e.kind === 'run') {
            out.mode = p.mode as RoomRunMode;
            out.runId = String(p.runId ?? '');
            out.verdict = (verdicts.get(out.runId) ?? null) as RoomTimelineEvent['verdict'];
          }
          if (e.kind === 'language' && typeof p.language === 'string') out.language = p.language;
          return out;
        });
        const times = [
          room.createdAt.getTime(),
          ...(agg?.first ? [new Date(agg.first).getTime()] : []),
          ...list.map((e) => e.ts.getTime()),
        ];
        const startedAt = Math.min(...times);
        const endedAt = Math.max(
          startedAt,
          ...(agg?.end ? [new Date(agg.end).getTime()] : []),
          ...list.map((e) => e.ts.getTime()),
          ...(room.closedAt ? [room.closedAt.getTime()] : []),
        );
        plays.add(1, { kind: 'timeline' });
        return {
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: endedAt - startedAt,
          updates: agg?.n ?? 0,
          lastSeq: agg?.last ?? 0,
          checkpointEvery: PLAYBACK_CHECKPOINT_EVERY,
          events,
          eventsCut: cut,
        };
      } finally {
        span.end();
      }
    });
  }

  /**
   * `toSeq` or `toTs`: a seek: the last checkpoint at or before that point, then the updates after it up to the point.
   * `fromSeq` (with an optional `toSeq`): a chunk for playing on: the updates after `fromSeq`, at most {@link CHUNK_MAX}.
   */
  async playback(
    user: Actor,
    roomId: string,
    q: PlaybackQuery,
  ): Promise<{ body: Buffer; fromSeq: number; toSeq: number }> {
    return tracer.startActiveSpan('rooms.playback', async (span) => {
      try {
        await this.interviewerOf(user, roomId);
        const chunk = q.fromSeq !== undefined;
        if (chunk && q.toTs !== undefined) {
          throw new ProblemError('validation', 'Use fromSeq with toSeq, not with toTs');
        }
        if (!chunk && q.toSeq === undefined && q.toTs === undefined) {
          throw new ProblemError('validation', 'Give toSeq, toTs or fromSeq');
        }
        if (q.toSeq !== undefined && q.toTs !== undefined) {
          throw new ProblemError('validation', 'Give toSeq or toTs, not both');
        }

        let upTo: number;
        if (q.toTs !== undefined) {
          const t = new Date(q.toTs);
          if (Number.isNaN(t.getTime())) throw new ProblemError('validation', 'toTs is not a time');
          const [r] = await this.db
            .select({ s: sql<number>`coalesce(max(${roomUpdates.seq}), 0)::int` })
            .from(roomUpdates)
            .where(and(eq(roomUpdates.roomId, roomId), lte(roomUpdates.ts, t)));
          upTo = r?.s ?? 0;
        } else {
          upTo = q.toSeq ?? Number.MAX_SAFE_INTEGER;
        }

        const records: { kind: number; seq: number; ts: number; bytes: Uint8Array }[] = [];
        let after = q.fromSeq ?? 0;
        if (!chunk) {
          const [ck] = await this.db
            .select({ seq: roomCheckpoints.seq, state: roomCheckpoints.state })
            .from(roomCheckpoints)
            .where(and(eq(roomCheckpoints.roomId, roomId), lte(roomCheckpoints.seq, upTo)))
            .orderBy(sql`${roomCheckpoints.seq} desc`)
            .limit(1);
          if (ck) {
            const [at] = await this.db
              .select({ ts: roomUpdates.ts })
              .from(roomUpdates)
              .where(and(eq(roomUpdates.roomId, roomId), eq(roomUpdates.seq, ck.seq)));
            records.push({
              kind: KIND_CHECKPOINT,
              seq: ck.seq,
              ts: at ? at.ts.getTime() : 0,
              bytes: ck.state,
            });
            after = ck.seq;
          }
        }
        const rows = await this.db
          .select({ seq: roomUpdates.seq, ts: roomUpdates.ts, update: roomUpdates.update })
          .from(roomUpdates)
          .where(
            and(
              eq(roomUpdates.roomId, roomId),
              gt(roomUpdates.seq, after),
              lte(roomUpdates.seq, upTo),
            ),
          )
          .orderBy(asc(roomUpdates.seq))
          .limit(CHUNK_MAX);
        for (const r of rows)
          records.push({ kind: KIND_UPDATE, seq: r.seq, ts: r.ts.getTime(), bytes: r.update });
        const last = rows.length > 0 ? rows[rows.length - 1]!.seq : after;
        plays.add(1, { kind: chunk ? 'chunk' : 'seek' });
        return { body: frame(records), fromSeq: after, toSeq: last };
      } finally {
        span.end();
      }
    });
  }
}
