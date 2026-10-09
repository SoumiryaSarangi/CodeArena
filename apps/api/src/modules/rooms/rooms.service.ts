import { createHash, randomBytes } from 'node:crypto';
import {
  MAX_OPEN_ROOMS,
  MAX_ROOM_MEMBERS,
  ROOM_SESSION_MAX_MINUTES,
  type RoomCreate,
  type RoomInvite,
  type RoomInviteCreate,
  type RoomJoined,
  type RoomList,
  type RoomRole,
  type RoomSummary,
  type RoomView,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { auditLog, problems, roomInvites, roomMembers, rooms, users } from '../../db/schema';
import { LOGGER } from '../../telemetry/logger';

const tracer = trace.getTracer('api');
const events = metrics.getMeter('api').createCounter('ca_rooms_events_total', {
  description: 'Interview room events: create, invite, join, close',
});

type RoomRow = typeof rooms.$inferSelect;
const iso = (d: Date) => d.toISOString();
const expiryOf = (r: Pick<RoomRow, 'createdAt'>) =>
  new Date(r.createdAt.getTime() + ROOM_SESSION_MAX_MINUTES * 60_000);
const hash = (token: string) => createHash('sha256').update(token).digest();

interface Actor {
  id: string;
  role: string;
}

/**
 * Interview rooms (CP-02, FR-PAD-01/02, US-10.1): create, list, invite, join, close. The shared document itself lives in
 * the collab server (CP-01); here is who may be in the room and in what role. An invite is a random 192-bit token stored
 * only as a hash, for one role, valid until the room closes or its 90 minutes are up.
 */
@Injectable()
export class RoomsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async create(user: Actor, body: RoomCreate): Promise<RoomView> {
    return tracer.startActiveSpan('rooms.create', async (span) => {
      try {
        let problemId: string | null = null;
        if (body.problemSlug) {
          const [p] = await this.db
            .select({ id: problems.id, visibility: problems.visibility })
            .from(problems)
            .where(eq(problems.slug, body.problemSlug))
            .limit(1);
          const staff = user.role === 'admin' || user.role === 'setter';
          if (!p || (p.visibility !== 'public' && !staff)) {
            throw new ProblemError('not-found', 'No such problem');
          }
          problemId = p.id;
        }
        const [open] = await this.db
          .select({ n: count() })
          .from(rooms)
          .where(
            and(
              eq(rooms.ownerId, user.id),
              eq(rooms.status, 'open'),
              sql`${rooms.createdAt} > now() - interval '90 minutes'`,
            ),
          );
        if ((open?.n ?? 0) >= MAX_OPEN_ROOMS) {
          throw new ProblemError(
            'validation',
            `You already have ${MAX_OPEN_ROOMS} open rooms: end one first`,
          );
        }
        const id = await this.db.transaction(async (tx) => {
          const [room] = await tx
            .insert(rooms)
            .values({
              ownerId: user.id,
              problemId,
              language: body.language,
              durationMin: body.durationMin,
            })
            .returning({ id: rooms.id });
          await tx
            .insert(roomMembers)
            .values({ roomId: room!.id, userId: user.id, role: 'interviewer' });
          await tx.insert(auditLog).values({
            actorId: user.id,
            action: 'room.create',
            targetType: 'room',
            targetId: room!.id,
            meta: { problem: body.problemSlug ?? null },
          });
          return room!.id;
        });
        events.add(1, { kind: 'create' });
        return this.get(user, id);
      } finally {
        span.end();
      }
    });
  }

  private async summaries(rows: { room: RoomRow; role: RoomRole }[]): Promise<RoomSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.room.id);
    const counts = await this.db
      .select({ roomId: roomMembers.roomId, n: count() })
      .from(roomMembers)
      .where(inArray(roomMembers.roomId, ids))
      .groupBy(roomMembers.roomId);
    const nBy = new Map(counts.map((c) => [c.roomId, c.n]));
    const pids = rows.map((r) => r.room.problemId).filter((x): x is string => !!x);
    const titles = pids.length
      ? await this.db
          .select({ id: problems.id, slug: problems.slug, title: problems.title })
          .from(problems)
          .where(inArray(problems.id, pids))
      : [];
    const pBy = new Map(titles.map((t) => [t.id, { slug: t.slug, title: t.title }]));
    return rows.map(({ room, role }) => ({
      id: room.id,
      role,
      status: this.effectiveStatus(room),
      language: room.language,
      durationMin: room.durationMin,
      problem: room.problemId ? (pBy.get(room.problemId) ?? null) : null,
      createdAt: iso(room.createdAt),
      expiresAt: iso(expiryOf(room)),
      memberCount: nBy.get(room.id) ?? 0,
    }));
  }

  /** A room past its 90 minutes is over even if nobody pressed End. */
  private effectiveStatus(room: RoomRow): RoomRow['status'] {
    return room.status === 'open' && Date.now() >= expiryOf(room).getTime()
      ? 'closed'
      : room.status;
  }

  async list(user: Actor): Promise<RoomList> {
    const mine = await this.db
      .select({ room: rooms, role: roomMembers.role })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(eq(roomMembers.userId, user.id))
      .orderBy(desc(rooms.createdAt))
      .limit(50);
    return { items: await this.summaries(mine) };
  }

  /** Members only; anyone else gets "no such room", so a room id says nothing about whether it exists. */
  async get(user: Actor, id: string): Promise<RoomView> {
    const [mine] = await this.db
      .select({ room: rooms, role: roomMembers.role })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, user.id)))
      .limit(1);
    if (!mine) throw new ProblemError('not-found', 'No such room');
    const [summary] = await this.summaries([mine]);
    const members = await this.db
      .select({ handle: users.handle, role: roomMembers.role })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, id))
      .orderBy(asc(roomMembers.joinedAt), asc(roomMembers.userId));
    return {
      ...summary!,
      members: members.map((m) => ({ handle: m.handle ?? 'guest', role: m.role })),
    };
  }

  async invite(user: Actor, id: string, body: RoomInviteCreate): Promise<RoomInvite> {
    return tracer.startActiveSpan('rooms.invite', async (span) => {
      try {
        const room = await this.asInterviewer(user, id);
        if (this.effectiveStatus(room) !== 'open')
          throw new ProblemError('validation', 'The room has ended');
        const token = randomBytes(24).toString('base64url');
        const expiresAt = expiryOf(room);
        await this.db
          .insert(roomInvites)
          .values({ roomId: id, role: body.role, tokenHash: hash(token), expiresAt });
        events.add(1, { kind: 'invite', role: body.role });
        return {
          url: `${this.config.WEB_URL.replace(/\/$/, '')}/r/join?token=${token}`,
          expiresAt: iso(expiresAt),
        };
      } finally {
        span.end();
      }
    });
  }

  /** The invite's token becomes a membership. A person who is already a member keeps the role they have. */
  async join(user: Actor, token: string): Promise<RoomJoined> {
    return tracer.startActiveSpan('rooms.join', async (span) => {
      try {
        const bad = () => new ProblemError('not-found', 'This invite is not valid any more');
        const [inv] = await this.db
          .select({ invite: roomInvites, room: rooms })
          .from(roomInvites)
          .innerJoin(rooms, eq(rooms.id, roomInvites.roomId))
          .where(eq(roomInvites.tokenHash, hash(token)))
          .limit(1);
        if (!inv || inv.invite.revokedAt || inv.invite.expiresAt.getTime() <= Date.now())
          throw bad();
        if (this.effectiveStatus(inv.room) !== 'open') throw bad();
        const roomId = inv.room.id;
        const [existing] = await this.db
          .select({ role: roomMembers.role })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id)))
          .limit(1);
        if (existing) return { roomId, role: existing.role };
        const [n] = await this.db
          .select({ n: count() })
          .from(roomMembers)
          .where(eq(roomMembers.roomId, roomId));
        if ((n?.n ?? 0) >= MAX_ROOM_MEMBERS)
          throw new ProblemError('validation', 'This room is full');
        await this.db
          .insert(roomMembers)
          .values({ roomId, userId: user.id, role: inv.invite.role })
          .onConflictDoNothing();
        events.add(1, { kind: 'join', role: inv.invite.role });
        span.setAttribute('room.role', inv.invite.role);
        return { roomId, role: inv.invite.role };
      } finally {
        span.end();
      }
    });
  }

  /** Ends the room: closed, invites revoked, and the collab server told to drop everyone. Idempotent. */
  async close(user: Actor, id: string): Promise<{ status: 'closed' }> {
    return tracer.startActiveSpan('rooms.close', async (span) => {
      try {
        await this.asInterviewer(user, id);
        await this.db.transaction(async (tx) => {
          await tx
            .update(rooms)
            .set({ status: 'closed', closedAt: new Date() })
            .where(and(eq(rooms.id, id), eq(rooms.status, 'open')));
          await tx
            .update(roomInvites)
            .set({ revokedAt: new Date() })
            .where(and(eq(roomInvites.roomId, id), isNull(roomInvites.revokedAt)));
          await tx
            .insert(auditLog)
            .values({ actorId: user.id, action: 'room.close', targetType: 'room', targetId: id });
        });
        events.add(1, { kind: 'close' });
        await this.tellCollab(id);
        return { status: 'closed' as const };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Best effort: the room is closed in the database whatever the collab servers answer; its sessions also end by
   * themselves. Every instance is told, because the room may live on any of them (Redis shares edits, not closures).
   */
  private async tellCollab(id: string): Promise<void> {
    const urls = (this.config.COLLAB_URL ?? '').split(/[\s,]+/).filter(Boolean);
    const token = this.config.COLLAB_SERVICE_TOKEN;
    if (urls.length === 0 || !token || token === 'not-configured') return;
    await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(`${url.replace(/\/$/, '')}/internal/rooms/${id}/close`, {
            method: 'POST',
            headers: { 'x-service-token': token },
            signal: AbortSignal.timeout(2000),
          });
          if (res.status !== 204) {
            this.log.warn(
              { roomId: id, url, status: res.status },
              'collab did not confirm the room close',
            );
          }
        } catch (err) {
          this.log.warn(
            { roomId: id, url, err: { message: (err as Error).message } },
            'could not tell collab the room closed',
          );
        }
      }),
    );
  }

  private async asInterviewer(user: Actor, id: string): Promise<RoomRow> {
    const [row] = await this.db
      .select({ room: rooms, role: roomMembers.role })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, user.id)))
      .limit(1);
    if (!row) throw new ProblemError('not-found', 'No such room');
    if (row.role !== 'interviewer')
      throw new ProblemError('forbidden', 'Only the interviewer can do this');
    return row.room;
  }
}
