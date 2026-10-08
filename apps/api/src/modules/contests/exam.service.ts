import {
  EXAM_MAX_STRIKES,
  type ExamAdminList,
  type ExamFinishReason,
  type LeaveResult,
  type Role,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, desc, eq, or, sql, gt, isNotNull } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import { auditLog, contests, participants, users } from '../../db/schema';
import { examOn } from './exam';
import { contestState } from './state';

const tracer = trace.getTracer('api');
const events = metrics.getMeter('api').createCounter('ca_exam_events_total', {
  description: 'Exam-mode events: finish, leave, auto-finish, reopen',
});

/** Leaves closer together than this count once (Alt-Tab fires blur and visibilitychange together). */
export const LEAVE_DEBOUNCE_SECONDS = 2;

interface Actor {
  id: string;
  role: Role;
}

/**
 * Exam mode (C-10, FR-EXAM-01..05). The server holds every counter: a client that reloads, or one
 * that is modified, cannot reset or skip a strike.
 */
@Injectable()
export class ExamService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** A running contest with exam mode on, for the endpoint that needs it. */
  private async running(slug: string) {
    const [c] = await this.db.select().from(contests).where(eq(contests.slug, slug)).limit(1);
    if (!c || c.status === 'draft') throw new ProblemError('not-found', 'No such contest');
    if (!examOn(c.rules)) {
      throw new ProblemError('forbidden', 'This contest does not use exam mode');
    }
    const state = contestState(c, new Date());
    if (state === 'scheduled') throw new ProblemError('contest-not-started');
    if (state !== 'running') throw new ProblemError('contest-ended');
    return c;
  }

  private notRegistered() {
    return new ProblemError('forbidden', 'Register for the contest first');
  }

  /** FR-EXAM-01: ends the participant's test. Idempotent. */
  async finish(slug: string, user: Actor): Promise<void> {
    return tracer.startActiveSpan('contests.finish', async (span) => {
      try {
        const c = await this.running(slug);
        const done = await this.db
          .update(participants)
          .set({ finishedAt: sql`now()`, finishReason: 'self' })
          .where(
            and(
              eq(participants.contestId, c.id),
              eq(participants.userId, user.id),
              sql`${participants.finishedAt} is null`,
            ),
          )
          .returning({ userId: participants.userId });
        if (done.length > 0) {
          events.add(1, { kind: 'finish' });
          return;
        }
        const [p] = await this.db
          .select({ userId: participants.userId })
          .from(participants)
          .where(and(eq(participants.contestId, c.id), eq(participants.userId, user.id)));
        if (!p) throw this.notRegistered();
      } finally {
        span.end();
      }
    });
  }

  /**
   * FR-EXAM-02: the client saw the test window being left. One atomic UPDATE counts it (unless the
   * previous leave was under two seconds ago) and, on the third, finishes the test in the same
   * statement, so parallel calls can neither skip nor double a strike.
   */
  async leave(slug: string, user: Actor): Promise<LeaveResult> {
    return tracer.startActiveSpan('contests.leave', async (span) => {
      try {
        const c = await this.running(slug);
        if (user.role === 'admin' || user.role === 'setter') {
          return { strikes: 0, remaining: EXAM_MAX_STRIKES, finished: false, counted: false };
        }
        const r = await this.db.execute<{ leave_count: number; finished_at: Date | null }>(sql`
          update participants set
            leave_count = leave_count + 1,
            last_leave_at = now(),
            finished_at = case when leave_count + 1 >= ${EXAM_MAX_STRIKES} then now() else finished_at end,
            finish_reason = case when leave_count + 1 >= ${EXAM_MAX_STRIKES} then 'left-window' else finish_reason end
          where contest_id = ${c.id} and user_id = ${user.id} and finished_at is null
            and (last_leave_at is null or last_leave_at < now() - ${LEAVE_DEBOUNCE_SECONDS} * interval '1 second')
          returning leave_count, finished_at`);
        const hit = r.rows[0];
        if (hit) {
          const finished = hit.finished_at !== null;
          events.add(1, { kind: finished ? 'auto-finish' : 'leave' });
          span.setAttribute('exam.strikes', hit.leave_count);
          return {
            strikes: hit.leave_count,
            remaining: Math.max(0, EXAM_MAX_STRIKES - hit.leave_count),
            finished,
            counted: true,
          };
        }
        const [p] = await this.db
          .select({ n: participants.leaveCount, f: participants.finishedAt })
          .from(participants)
          .where(and(eq(participants.contestId, c.id), eq(participants.userId, user.id)));
        if (!p) throw this.notRegistered();
        return {
          strikes: p.n,
          remaining: Math.max(0, EXAM_MAX_STRIKES - p.n),
          finished: p.f !== null,
          counted: false,
        };
      } finally {
        span.end();
      }
    });
  }

  private async contestById(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ProblemError('not-found', 'No such contest');
    const [c] = await this.db.select().from(contests).where(eq(contests.id, id)).limit(1);
    if (!c) throw new ProblemError('not-found', 'No such contest');
    return c;
  }

  /** The ops console list: everyone who left the window or finished, finished and noisiest first. */
  async adminList(id: string): Promise<ExamAdminList> {
    const c = await this.contestById(id);
    const rows = await this.db
      .select({
        userId: participants.userId,
        handle: users.handle,
        leaveCount: participants.leaveCount,
        finishedAt: participants.finishedAt,
        finishReason: participants.finishReason,
      })
      .from(participants)
      .innerJoin(users, eq(users.id, participants.userId))
      .where(
        and(
          eq(participants.contestId, c.id),
          or(gt(participants.leaveCount, 0), isNotNull(participants.finishedAt)),
        ),
      )
      .orderBy(desc(participants.finishedAt), desc(participants.leaveCount));
    return {
      items: rows.map((r) => ({
        userId: r.userId,
        handle: r.handle,
        leaveCount: r.leaveCount,
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        finishReason: (r.finishReason as ExamFinishReason | null) ?? null,
      })),
    };
  }

  /** FR-EXAM-05: gives a participant their test back (false positives happen). Audit-logged. */
  async reopen(id: string, userId: string, admin: Actor): Promise<void> {
    const c = await this.contestById(id);
    if (!/^[0-9a-f-]{36}$/.test(userId)) throw new ProblemError('not-found', 'No such participant');
    const done = await this.db
      .update(participants)
      .set({ finishedAt: null, finishReason: null, leaveCount: 0, lastLeaveAt: null })
      .where(and(eq(participants.contestId, c.id), eq(participants.userId, userId)))
      .returning({ userId: participants.userId });
    if (done.length === 0) throw new ProblemError('not-found', 'No such participant');
    await this.db.insert(auditLog).values({
      actorId: admin.id,
      action: 'contest.reopen',
      targetType: 'contest',
      targetId: c.id,
      meta: { userId },
    });
    events.add(1, { kind: 'reopen' });
  }
}
