import {
  ROOM_SESSION_MAX_MINUTES,
  type RoomSettingsEvent,
  type RoomSettingsPatch,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import { auditLog, roomMembers, rooms } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { publishEvent } from '../realtime/events';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';

const tracer = trace.getTracer('api');
const settingsTotal = metrics.getMeter('api').createCounter('ca_room_settings_total', {
  description: 'Room editor settings changed by the interviewer, by outcome',
});

interface Actor {
  id: string;
}

/**
 * ED-01 (FR-EDIT-03): the interviewer switches code suggestions on or off while a room is open. The value is stored on the
 * room (a joiner reads it with the room) and published on the room's topic so everyone connected follows at once. It is a
 * convenience applied by each browser, not a control: nothing server-side depends on it.
 */
@Injectable()
export class RoomSettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async patch(user: Actor, roomId: string, body: RoomSettingsPatch): Promise<RoomSettingsEvent> {
    return tracer.startActiveSpan('rooms.settings', async (span) => {
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
          throw new ProblemError('forbidden', 'Only the interviewer can change the room settings');
        }
        const over = Date.now() >= m.room.createdAt.getTime() + ROOM_SESSION_MAX_MINUTES * 60_000;
        if (m.room.status !== 'open' || over) {
          outcome = 'ended';
          throw new ProblemError('room-closed', 'The room has ended');
        }
        await this.db.transaction(async (tx) => {
          await tx.update(rooms).set({ suggestions: body.suggestions }).where(eq(rooms.id, roomId));
          await tx.insert(auditLog).values({
            actorId: user.id,
            action: 'room.settings',
            targetType: 'room',
            targetId: roomId,
            meta: { suggestions: body.suggestions },
          });
        });
        const data: RoomSettingsEvent = { suggestions: body.suggestions };
        await publishEvent(
          this.redis,
          this.prefix,
          this.log,
          `room:${roomId}`,
          'room.settings',
          data,
        );
        return data;
      } finally {
        settingsTotal.add(1, { outcome });
        span.setAttribute('room.settings.outcome', outcome);
        span.end();
      }
    });
  }
}
