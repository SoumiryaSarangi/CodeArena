import {
  PRESENCE_COLOURS,
  ROOM_SESSION_MAX_MINUTES,
  type CollabIdentity,
  type RoomRole,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { asc, eq } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import { roomMembers, rooms, users } from '../../db/schema';
import { TicketsService } from '../realtime/tickets.service';

const tracer = trace.getTracer('api');
const authorizations = metrics.getMeter('api').createCounter('ca_collab_authorize_total', {
  description: 'Collab server asking who a ticket belongs to, by outcome',
});

/**
 * CP-01 (SD-§11, FR-PAD-03): the collab server hands over the ticket a browser presented and gets back who that is. The
 * ticket is redeemed here (single use), so the collab server never sees a credential it could replay, and nothing the
 * client says about itself (name, role, colour) is believed anywhere downstream.
 */
@Injectable()
export class CollabService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketsService) private readonly tickets: TicketsService,
  ) {}

  async authorize(roomId: string, ticket: string, now: Date = new Date()): Promise<CollabIdentity> {
    return tracer.startActiveSpan('collab.authorize', async (span) => {
      let outcome = 'ok';
      try {
        const granted = await this.tickets.redeem(ticket);
        if (!granted || !granted.uid) {
          outcome = 'bad-ticket';
          throw new ProblemError('unauthorized', 'The ticket is invalid, used or expired');
        }
        if (granted.roomId !== roomId) {
          outcome = 'wrong-room';
          throw new ProblemError('forbidden', 'The ticket is for another room');
        }
        const [room] = await this.db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
        if (!room) {
          outcome = 'no-room';
          throw new ProblemError('not-found', 'No such room');
        }
        if (room.status !== 'open') {
          outcome = 'closed';
          throw new ProblemError('forbidden', 'The room is closed');
        }
        const expiresAt = room.createdAt.getTime() + ROOM_SESSION_MAX_MINUTES * 60_000;
        if (now.getTime() >= expiresAt) {
          outcome = 'expired';
          throw new ProblemError('forbidden', 'The room session has ended');
        }
        // Everyone in the room, oldest member first: the colour is the person's place in that list.
        const members = await this.db
          .select({ userId: roomMembers.userId, role: roomMembers.role, handle: users.handle })
          .from(roomMembers)
          .innerJoin(users, eq(users.id, roomMembers.userId))
          .where(eq(roomMembers.roomId, roomId))
          .orderBy(asc(roomMembers.joinedAt), asc(roomMembers.userId));
        const at = members.findIndex((m) => m.userId === granted.uid);
        const me = members[at];
        if (!me) {
          outcome = 'not-member';
          throw new ProblemError('forbidden', 'Not a member of this room');
        }
        const role: RoomRole = me.role;
        span.setAttribute('collab.role', role);
        return {
          userId: me.userId,
          name: me.handle ?? 'guest',
          role,
          readOnly: role === 'observer',
          expiresAt,
          colorIndex: at % PRESENCE_COLOURS,
        };
      } catch (e) {
        span.recordException(e as Error);
        throw e;
      } finally {
        authorizations.add(1, { outcome });
        span.end();
      }
    });
  }
}
