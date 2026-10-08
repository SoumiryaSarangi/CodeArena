import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { TicketRequest, TicketResponse } from '@codearena/contracts';
import { and, eq, ne } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import { contests, customRuns, participants, roomMembers, submissions } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import type { AuthUser } from '../auth/guards';

export const TICKET_TTL_SECONDS = 60; // FR-AUTH-11

const Stored = z.object({
  uid: z.string().nullable(),
  role: z.enum(['user', 'setter', 'admin']).nullable(),
  topics: z.array(z.string()),
  roomId: z.string().nullable(),
});
export type RedeemedTicket = z.infer<typeof Stored>;

const key = (t: string) => `tkt:${t}`;

/**
 * Single-use, 60-second realtime tickets bound to a user and an explicit topic set (SD-§5.7, §10).
 * SSE and the collab server redeem them with `redeem()`.
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DB) private readonly db: Db,
  ) {}

  async issue(user: AuthUser | undefined, req: TicketRequest): Promise<TicketResponse> {
    const topics = 'topics' in req ? [...new Set(req.topics)] : [];
    const roomId = 'roomId' in req ? req.roomId : null;
    for (const t of topics) await this.authorizeTopic(user, t);
    if (roomId) await this.authorizeRoom(user, roomId);

    const ticket = randomBytes(32).toString('base64url'); // 256 bits
    const value: RedeemedTicket = {
      uid: user?.id ?? null,
      role: user?.role ?? null,
      topics,
      roomId,
    };
    await whenReady(this.redis);
    const ok = await this.redis.set(
      key(ticket),
      JSON.stringify(value),
      'EX',
      TICKET_TTL_SECONDS,
      'NX',
    );
    if (ok !== 'OK') throw new Error('ticket collision'); // 2^-256; never expected
    return { ticket, expiresAt: Date.now() + TICKET_TTL_SECONDS * 1000 };
  }

  /** GETDEL makes the ticket single-use. Returns null if unknown, used, expired or over-asked. */
  async redeem(ticket: string, requested?: string[]): Promise<RedeemedTicket | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    await whenReady(this.redis);
    const raw = await this.redis.getdel(key(ticket));
    if (!raw) return null;
    const parsed = Stored.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    if (requested && !requested.every((t) => parsed.data.topics.includes(t))) return null;
    return parsed.data;
  }

  /** SD-§10 topic authorisation. Unknown or unauthorised topics are `forbidden-topic`. */
  private async authorizeTopic(user: AuthUser | undefined, topic: string): Promise<void> {
    const deny = () => {
      throw new ProblemError('forbidden-topic', `Not allowed to subscribe to ${topic}`);
    };
    if (topic === 'sys') return;
    const admin = user?.role === 'admin';
    if (topic.startsWith('admin:')) return admin ? undefined : deny();

    const sub = /^sub:([0-9a-f-]{36})$/.exec(topic);
    if (sub) {
      if (!user) return deny();
      if (admin) return;
      // A topic id is either a submission or one of the caller's custom runs (POST /runs).
      const [row] = await this.db
        .select({ id: submissions.id })
        .from(submissions)
        .where(and(eq(submissions.id, sub[1]!), eq(submissions.userId, user.id)));
      if (row) return;
      const [run] = await this.db
        .select({ id: customRuns.id })
        .from(customRuns)
        .where(and(eq(customRuns.id, sub[1]!), eq(customRuns.userId, user.id)));
      return run ? undefined : deny();
    }

    const contest = /^contest:([0-9a-f-]{36}):([a-z0-9:_-]+)$/.exec(topic);
    if (contest) {
      const [c] = await this.db
        .select({ id: contests.id })
        .from(contests)
        .where(and(eq(contests.id, contest[1]!), ne(contests.status, 'draft')));
      if (!c) return admin ? undefined : deny();
      if (contest[2] === 'board') return; // public board once the contest is published
      if (!user) return deny();
      if (admin) return;
      // `u:{userId}` carries private answers: only its owner (C-05).
      const priv = /^u:([0-9a-f-]{36})$/.exec(contest[2]!);
      if (priv && priv[1] !== user.id) return deny();
      const [p] = await this.db
        .select({ uid: participants.userId })
        .from(participants)
        .where(and(eq(participants.contestId, c.id), eq(participants.userId, user.id)));
      return p ? undefined : deny();
    }
    return deny();
  }

  private async authorizeRoom(user: AuthUser | undefined, roomId: string): Promise<void> {
    if (!user) throw new ProblemError('forbidden-topic', 'Sign in to join this room');
    const [m] = await this.db
      .select({ uid: roomMembers.userId })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)));
    if (!m) throw new ProblemError('forbidden-topic', 'Not a member of this room');
  }
}
