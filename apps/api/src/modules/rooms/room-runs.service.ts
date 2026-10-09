import {
  ROOM_RUN_INTERVAL_MS,
  ROOM_SESSION_MAX_MINUTES,
  type RoomRunAccepted,
  type RoomRunCreate,
  type RoomRunList,
  type RoomRunView,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import {
  customRuns,
  problemVersions,
  problems,
  roomEvents,
  roomMembers,
  rooms,
  users,
} from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import { LOGGER } from '../../telemetry/logger';
import { publishEvent } from '../realtime/events';
import { buildJob } from '../submissions/job-builder';
import { QUEUE_KEY_PREFIX, QueueService } from '../submissions/queue.service';
import { roomRunView, SCRATCH_VERSION } from './room-run';

const tracer = trace.getTracer('api');
const runsTotal = metrics.getMeter('api').createCounter('ca_room_runs_total', {
  description: 'Runs and submissions started from interview rooms, by mode and outcome',
});

interface Actor {
  id: string;
  role: string;
}

/**
 * CP-04 (SD-§11.6, FR-PAD-08): Run and Submit from the pad. The shared code goes to the judge through the `interactive`
 * lane (strict priority: contest, then interactive, then practice), one run per room every 2 seconds, and what comes back
 * is shown to everyone in the room at the same moment: the verdict is stored once (`custom_runs`) and broadcast on the
 * room's topic, so all members read the same row. A submission here judges the attached problem's hidden tests but is not
 * a submission: it belongs to nobody's practice record or rating.
 */
@Injectable()
export class RoomRunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  private async member(user: Actor, roomId: string) {
    const [row] = await this.db
      .select({ room: rooms, role: roomMembers.role, handle: users.handle })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
      .limit(1);
    if (!row) throw new ProblemError('not-found', 'No such room');
    return row;
  }

  async start(user: Actor, roomId: string, body: RoomRunCreate): Promise<RoomRunAccepted> {
    return tracer.startActiveSpan('rooms.run', async (span) => {
      let outcome = 'ok';
      try {
        span.setAttributes({ 'room.mode': body.mode });
        const { room, role, handle } = await this.member(user, roomId);
        if (role === 'observer') {
          outcome = 'observer';
          throw new ProblemError('forbidden', 'Observers cannot run code');
        }
        const over = Date.now() >= room.createdAt.getTime() + ROOM_SESSION_MAX_MINUTES * 60_000;
        if (room.status !== 'open' || over) {
          outcome = 'ended';
          throw new ProblemError('validation', 'The room has ended');
        }
        if (
          Buffer.byteLength(body.source) > 64 * 1024 ||
          Buffer.byteLength(body.input ?? '') > 64 * 1024
        ) {
          throw new ProblemError('payload-too-large', 'Source and input are limited to 64 KB each');
        }

        // The same run id again (a retry) answers the same and runs nothing twice.
        const [seen] = await this.db
          .select({ roomId: customRuns.roomId, userId: customRuns.userId })
          .from(customRuns)
          .where(eq(customRuns.id, body.runId))
          .limit(1);
        if (seen) {
          if (seen.roomId !== roomId || seen.userId !== user.id) {
            throw new ProblemError('validation', 'That run id is already used');
          }
          outcome = 'replay';
          return { runId: body.runId };
        }

        let version: {
          id: string;
          testsetHash: string | null;
          testsetUri: string | null;
          limits: unknown;
          checker: unknown;
        } = SCRATCH_VERSION;
        let versionId: string | null = null;
        if (room.problemId) {
          const [v] = await this.db
            .select({
              id: problemVersions.id,
              testsetHash: problemVersions.testsetHash,
              testsetUri: problemVersions.testsetUri,
              limits: problemVersions.limits,
              checker: problemVersions.checker,
            })
            .from(problems)
            .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
            .where(eq(problems.id, room.problemId))
            .limit(1);
          if (v?.testsetHash) {
            version = v;
            versionId = v.id;
          }
        }
        if (body.mode === 'submit' && !versionId) {
          throw new ProblemError('validation', 'Attach a problem to the room to submit');
        }

        // One run every 2 seconds per room, whoever presses the button: a token that expires by itself.
        await whenReady(this.redis);
        const key = `${this.prefix}room-run:${roomId}`;
        if ((await this.redis.set(key, user.id, 'PX', ROOM_RUN_INTERVAL_MS, 'NX')) !== 'OK') {
          outcome = 'rate-limited';
          const wait = Math.max(1, Math.ceil((await this.redis.pttl(key)) / 1000));
          throw new ProblemError('rate-limited', 'One run every 2 seconds per room', {
            headers: { 'Retry-After': String(wait) },
          });
        }

        const input = body.mode === 'run' ? (body.input ?? '') : null;
        const [created] = await this.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(customRuns)
            .values({
              id: body.runId,
              userId: user.id,
              roomId,
              problemVersionId: versionId,
              language: body.language,
              source: body.source,
              input,
            })
            .returning({ id: customRuns.id, createdAt: customRuns.createdAt });
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${roomId}))`);
          await tx.insert(roomEvents).values({
            roomId,
            seq: sql`(select coalesce(max(seq), 0) + 1 from room_events where room_id = ${roomId})`,
            userId: user.id,
            kind: 'run',
            payload: { runId: body.runId, mode: body.mode, language: body.language },
          });
          // CP-07 (FR-PAD-12): every run is a version of the code the interviewer can go back to. The snapshot shares the
          // run's id, and `seq` ties it to the replay (the log position at that moment).
          await tx.execute(sql`
            insert into room_snapshots (id, room_id, seq, label, snapshot)
            values (${body.runId}, ${roomId},
                    (select coalesce(max(seq), 0) from room_updates where room_id = ${roomId}),
                    ${`${body.mode === 'submit' ? 'Submit' : 'Run'} by @${handle}`},
                    ${Buffer.from(JSON.stringify({ text: body.source, language: body.language }), 'utf8')})`);
          return inserted;
        });

        try {
          await this.queue.enqueue(
            buildJob(
              {
                id: body.runId,
                language: body.language,
                source: body.source,
                lane: 'interactive',
                ...(input === null ? {} : { customInput: input }),
              },
              version,
              body.mode,
            ),
          );
        } catch (err) {
          await this.db
            .update(customRuns)
            .set({ status: 'failed' })
            .where(eq(customRuns.id, body.runId));
          this.log.error(
            { roomId, err: { message: (err as Error).message } },
            'could not queue a room run',
          );
          outcome = 'queue-error';
          throw new ProblemError('internal', 'Could not queue the run; please try again');
        }

        // Everyone sees it start, with who pressed the button.
        await publishEvent(
          this.redis,
          this.prefix,
          this.log,
          `room:${roomId}`,
          'room.run',
          roomRunView({
            id: body.runId,
            by: handle,
            language: body.language,
            input,
            status: 'queued',
            result: null,
            createdAt: created!.createdAt,
          }),
        );
        return { runId: body.runId };
      } catch (e) {
        span.recordException(e as Error);
        throw e;
      } finally {
        runsTotal.add(1, { mode: body.mode, outcome });
        span.end();
      }
    });
  }

  /** The room's recent runs, newest first, for whoever joins late; members only, observers included. */
  async list(user: Actor, roomId: string): Promise<RoomRunList> {
    await this.member(user, roomId);
    const rows = await this.db
      .select({
        id: customRuns.id,
        by: users.handle,
        language: customRuns.language,
        input: customRuns.input,
        status: customRuns.status,
        result: customRuns.result,
        createdAt: customRuns.createdAt,
      })
      .from(customRuns)
      .innerJoin(users, eq(users.id, customRuns.userId))
      .where(eq(customRuns.roomId, roomId))
      .orderBy(desc(customRuns.createdAt))
      .limit(30);
    return { items: rows.map(roomRunView) as RoomRunView[] };
  }
}
