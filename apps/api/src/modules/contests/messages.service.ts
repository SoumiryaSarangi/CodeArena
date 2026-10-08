import type {
  AdminClarificationItem,
  AdminClarificationList,
  Announcement,
  AnnouncementEvent,
  AnnouncementCreate,
  AnnouncementList,
  ClarificationAnswer,
  ClarificationCreate,
  ClarificationEvent,
  ClarificationNewEvent,
  ClarificationItem,
  ClarificationList,
  Role,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, desc, eq, isNotNull, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import {
  announcements,
  auditLog,
  clarifications,
  contestProblems,
  contests,
  participants,
  users,
} from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { publishEvent } from '../realtime/events';
import { contestState } from './state';

const tracer = trace.getTracer('api');
const counter = metrics.getMeter('api').createCounter('ca_contest_messages_total', {
  description: 'Clarifications and announcements, by kind',
});

export interface Actor {
  id: string;
  role: Role;
}

type Row = typeof clarifications.$inferSelect;

/**
 * Clarifications and announcements (C-05, FR-CONT-04). Questions go to the admins' topic as they
 * are asked; an answer goes to its asker alone (private) or to every registered contestant
 * (public); announcements go to every registered contestant. Topics and who may open them:
 * `contest:{id}:clar` (registered), `contest:{id}:u:{userId}` (that user), `admin:contest:{id}:clar`.
 */
@Injectable()
export class MessagesService {
  private readonly prefix: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {
    this.prefix = config.QUEUE_KEY_PREFIX;
  }

  private publish<T>(topic: string, type: 'clar.new' | 'clar.answer' | 'announce.new', data: T) {
    return publishEvent(this.redis, this.prefix, this.log, topic, type, data);
  }

  /** A published contest by slug; a draft is 404 for everyone but admins. */
  private async contest(slug: string, actor?: Actor) {
    const [c] = await this.db.select().from(contests).where(eq(contests.slug, slug)).limit(1);
    if (!c || (c.status === 'draft' && actor?.role !== 'admin')) {
      throw new ProblemError('not-found', 'No such contest');
    }
    return c;
  }

  private async registered(cid: string, uid: string) {
    const [p] = await this.db
      .select({ uid: participants.userId })
      .from(participants)
      .where(and(eq(participants.contestId, cid), eq(participants.userId, uid)))
      .limit(1);
    return !!p;
  }

  /** Registered contestants and admins; everyone else gets 403 (404 if there is no such contest). */
  private async member(slug: string, actor: Actor) {
    const c = await this.contest(slug, actor);
    if (actor.role !== 'admin' && !(await this.registered(c.id, actor.id))) {
      throw new ProblemError('forbidden', 'Register for the contest to use this');
    }
    return c;
  }

  private toItem(r: Row, viewerId: string | null): ClarificationItem {
    return {
      id: r.id,
      problemLabel: r.problemLabel,
      question: r.question,
      answer: r.answer,
      isPublic: r.isPublic,
      mine: r.askerId === viewerId,
      createdAt: r.createdAt.toISOString(),
      answeredAt: r.answeredAt ? r.answeredAt.toISOString() : null,
    };
  }

  private async toAdminItem(r: Row): Promise<AdminClarificationItem> {
    const [u] = await this.db
      .select({ handle: users.handle })
      .from(users)
      .where(eq(users.id, r.askerId))
      .limit(1);
    return { ...this.toItem(r, null), askerId: r.askerId, askerHandle: u?.handle ?? 'unknown' };
  }

  /** My questions and every public answer, newest first. */
  async list(slug: string, actor: Actor): Promise<ClarificationList> {
    const c = await this.member(slug, actor);
    const rows = await this.db
      .select()
      .from(clarifications)
      .where(
        and(
          eq(clarifications.contestId, c.id),
          or(
            eq(clarifications.askerId, actor.id),
            and(eq(clarifications.isPublic, true), isNotNull(clarifications.answer)),
          ),
        ),
      )
      .orderBy(desc(clarifications.createdAt))
      .limit(200);
    return { items: rows.map((r) => this.toItem(r, actor.id)) };
  }

  /** US-4.6: ask while the contest runs, about one problem or in general. */
  async ask(slug: string, actor: Actor, body: ClarificationCreate): Promise<ClarificationItem> {
    return tracer.startActiveSpan('contests.clarify', async (span) => {
      try {
        const c = await this.member(slug, actor);
        span.setAttribute('contest.id', c.id);
        const state = contestState(c, new Date());
        if (state === 'scheduled') {
          throw new ProblemError('contest-not-started', 'The contest has not started yet');
        }
        if (state === 'ended' || state === 'finalized') {
          throw new ProblemError('contest-ended', 'The contest has ended');
        }
        const label = body.problemLabel ?? null;
        if (label) {
          const [p] = await this.db
            .select({ label: contestProblems.label })
            .from(contestProblems)
            .where(and(eq(contestProblems.contestId, c.id), eq(contestProblems.label, label)))
            .limit(1);
          if (!p) {
            throw new ProblemError('validation', 'No such problem in this contest', {
              errors: [{ path: 'problemLabel', message: `no problem ${label}` }],
            });
          }
        }
        const [row] = await this.db
          .insert(clarifications)
          .values({
            contestId: c.id,
            problemLabel: label,
            askerId: actor.id,
            question: body.question,
          })
          .returning();
        counter.add(1, { kind: 'question' });
        const event: ClarificationNewEvent = {
          contestId: c.id,
          item: await this.toAdminItem(row!),
        };
        await this.publish(`admin:contest:${c.id}:clar`, 'clar.new', event);
        return this.toItem(row!, actor.id);
      } finally {
        span.end();
      }
    });
  }

  // ----- announcements -----

  async announcements(slug: string, actor: Actor): Promise<AnnouncementList> {
    const c = await this.member(slug, actor);
    const rows = await this.db
      .select()
      .from(announcements)
      .where(eq(announcements.contestId, c.id))
      .orderBy(desc(announcements.createdAt))
      .limit(100);
    return { items: rows.map(this.toAnnouncement) };
  }

  private toAnnouncement = (r: typeof announcements.$inferSelect): Announcement => ({
    id: r.id,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  });

  // ----- admin -----

  private async byId(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ProblemError('not-found', 'No such contest');
    const [c] = await this.db.select().from(contests).where(eq(contests.id, id)).limit(1);
    if (!c) throw new ProblemError('not-found', 'No such contest');
    return c;
  }

  /** The inbox: unanswered first (oldest first, they have waited longest), then answered. */
  async inbox(contestId: string): Promise<AdminClarificationList> {
    const c = await this.byId(contestId);
    const rows = await this.db
      .select()
      .from(clarifications)
      .where(eq(clarifications.contestId, c.id))
      .orderBy(asc(clarifications.createdAt))
      .limit(500);
    const items = await Promise.all(rows.map((r) => this.toAdminItem(r)));
    const open = items.filter((i) => i.answer === null);
    const done = items.filter((i) => i.answer !== null).reverse();
    return { items: [...open, ...done] };
  }

  /** Answers (or re-answers) a question, privately to its asker or publicly to everyone. */
  async answer(
    id: string,
    admin: Actor,
    body: ClarificationAnswer,
  ): Promise<AdminClarificationItem> {
    return tracer.startActiveSpan('contests.answer', async (span) => {
      try {
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new ProblemError('not-found', 'No such question');
        const [row] = await this.db
          .update(clarifications)
          .set({
            answer: body.answer,
            isPublic: body.isPublic,
            answeredBy: admin.id,
            answeredAt: new Date(),
          })
          .where(eq(clarifications.id, id))
          .returning();
        if (!row) throw new ProblemError('not-found', 'No such question');
        counter.add(1, { kind: body.isPublic ? 'answer-public' : 'answer-private' });
        await this.db.insert(auditLog).values({
          actorId: admin.id,
          action: 'clarification.answer',
          targetType: 'clarification',
          targetId: row.id,
          meta: { contestId: row.contestId, isPublic: body.isPublic },
        });
        const item = await this.toAdminItem(row);
        // Public answers name no one; a private answer goes to its asker alone.
        if (row.isPublic) {
          const event: ClarificationEvent = {
            contestId: row.contestId,
            item: this.toItem(row, null),
          };
          await this.publish(`contest:${row.contestId}:clar`, 'clar.answer', event);
        } else {
          const event: ClarificationEvent = {
            contestId: row.contestId,
            item: this.toItem(row, row.askerId),
          };
          await this.publish(`contest:${row.contestId}:u:${row.askerId}`, 'clar.answer', event);
        }
        return item;
      } finally {
        span.end();
      }
    });
  }

  async announce(contestId: string, admin: Actor, body: AnnouncementCreate): Promise<Announcement> {
    return tracer.startActiveSpan('contests.announce', async (span) => {
      try {
        const c = await this.byId(contestId);
        const [row] = await this.db
          .insert(announcements)
          .values({ contestId: c.id, body: body.body, createdBy: admin.id })
          .returning();
        counter.add(1, { kind: 'announcement' });
        await this.db.insert(auditLog).values({
          actorId: admin.id,
          action: 'contest.announce',
          targetType: 'contest',
          targetId: c.id,
        });
        const a = this.toAnnouncement(row!);
        const event: AnnouncementEvent = { contestId: c.id, item: a };
        await this.publish(`contest:${c.id}:clar`, 'announce.new', event);
        return a;
      } finally {
        span.end();
      }
    });
  }
}
