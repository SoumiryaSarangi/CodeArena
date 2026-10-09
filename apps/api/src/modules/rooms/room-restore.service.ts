import {
  ROOM_RESTORE_INTERVAL_MS,
  ROOM_SESSION_MAX_MINUTES,
  type RoomRestore,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { roomEvents, roomMembers, roomSnapshots, rooms } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import { LOGGER } from '../../telemetry/logger';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';

const tracer = trace.getTracer('api');
const restoresTotal = metrics.getMeter('api').createCounter('ca_room_restores_total', {
  description: 'Version restores asked for in interview rooms, by outcome',
});

interface Actor {
  id: string;
}

/**
 * CP-07 (FR-PAD-12, US-10.6): the interviewer puts the code of an earlier run back. The API holds the snapshot but not the
 * live document, so it hands the text to one collab server, which applies it as an anti-operation (the edits that make
 * the live text equal the snapshot) and relays it to the other server through Redis. Asking every server would apply it
 * twice, so they are tried in order until one answers. The `restore` event is written only after collab confirmed.
 */
@Injectable()
export class RoomRestoreService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async restore(user: Actor, roomId: string, body: RoomRestore): Promise<{ runId: string }> {
    return tracer.startActiveSpan('rooms.restore', async (span) => {
      let outcome = 'ok';
      try {
        const [m] = await this.db
          .select({ room: rooms, role: roomMembers.role })
          .from(roomMembers)
          .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
          .limit(1);
        if (!m) {
          outcome = 'not-member';
          throw new ProblemError('not-found', 'No such room');
        }
        if (m.role !== 'interviewer') {
          outcome = 'denied';
          throw new ProblemError('forbidden', 'Only the interviewer can restore a version');
        }
        const over = Date.now() >= m.room.createdAt.getTime() + ROOM_SESSION_MAX_MINUTES * 60_000;
        if (m.room.status !== 'open' || over) {
          outcome = 'ended';
          throw new ProblemError('room-closed', 'The room has ended');
        }
        const [snap] = await this.db
          .select({ snapshot: roomSnapshots.snapshot })
          .from(roomSnapshots)
          .where(and(eq(roomSnapshots.id, body.runId), eq(roomSnapshots.roomId, roomId)))
          .limit(1);
        if (!snap) {
          outcome = 'unknown-version';
          throw new ProblemError('not-found', 'No such version in this room');
        }
        const saved = JSON.parse(Buffer.from(snap.snapshot).toString('utf8')) as {
          text: string;
          language: string;
        };

        await whenReady(this.redis);
        const key = `${this.prefix}room-restore:${roomId}`;
        if ((await this.redis.set(key, user.id, 'PX', ROOM_RESTORE_INTERVAL_MS, 'NX')) !== 'OK') {
          outcome = 'rate-limited';
          const wait = Math.max(1, Math.ceil((await this.redis.pttl(key)) / 1000));
          throw new ProblemError('rate-limited', 'One restore every 2 seconds per room', {
            headers: { 'Retry-After': String(wait) },
          });
        }

        if (!(await this.askCollab(roomId, { ...saved, userId: user.id }))) {
          outcome = 'collab-unreachable';
          throw new ProblemError('internal', 'Could not reach the pad server; nothing was changed');
        }
        await this.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${roomId}))`);
          await tx.insert(roomEvents).values({
            roomId,
            seq: sql`(select coalesce(max(seq), 0) + 1 from room_events where room_id = ${roomId})`,
            userId: user.id,
            kind: 'restore',
            payload: { runId: body.runId },
          });
        });
        return { runId: body.runId };
      } finally {
        restoresTotal.add(1, { outcome });
        span.setAttribute('room.restore.outcome', outcome);
        span.end();
      }
    });
  }

  /** The first collab server that answers 200 wins; the others hear about the change from Redis. */
  private async askCollab(
    roomId: string,
    body: { text: string; language: string; userId: string },
  ): Promise<boolean> {
    const urls = (this.config.COLLAB_URL ?? '').split(/[\s,]+/).filter(Boolean);
    const token = this.config.COLLAB_SERVICE_TOKEN;
    if (urls.length === 0 || !token || token === 'not-configured') return false;
    for (const url of urls) {
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/internal/rooms/${roomId}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-service-token': token },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 200) return true;
        this.log.warn({ roomId, url, status: res.status }, 'collab did not apply the restore');
      } catch (err) {
        this.log.warn(
          { roomId, url, err: { message: (err as Error).message } },
          'could not reach collab for a restore',
        );
      }
    }
    return false;
  }
}
