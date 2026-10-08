import type {
  ContestResults,
  FinalizeResult,
  RatingHistory,
  RecomputeResult,
  Role,
} from '@codearena/contracts';
import { ContestRules } from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import {
  auditLog,
  contests,
  participants,
  ratingChanges,
  submissions,
  users,
} from '../../db/schema';
import { BoardService } from '../board/board.service';
import { contestState } from '../contests/state';
import { MIN_RATED_PLAYERS, computeRatings, type Player } from './ratings';

const tracer = trace.getTracer('api');
const counter = metrics.getMeter('api').createCounter('ca_ratings_total', {
  description: 'Contest finalisations and rating recomputations, by action',
});

interface Actor {
  id: string;
  role: Role;
}

/** Finalising a contest and the ratings that follow (C-08, FR-CONT-07, FR-RATE-01..03). */
@Injectable()
export class RatingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BoardService) private readonly board: BoardService,
  ) {}

  private async contest(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ProblemError('not-found', 'No such contest');
    const [c] = await this.db.select().from(contests).where(eq(contests.id, id)).limit(1);
    if (!c) throw new ProblemError('not-found', 'No such contest');
    return c;
  }

  /**
   * Who counts and where they stand: registered users with at least one counted (not
   * disqualified) submission, ranked among themselves by the board's score. The board is rebuilt
   * from the database first, so the standings are exactly what the submissions say.
   */
  private async standings(
    c: typeof contests.$inferSelect,
  ): Promise<{ id: string; rank: number }[]> {
    await this.board.rebuild(c.id, 'admin');
    const snap = await this.board.snapshot(c, { id: 'system', role: 'admin' });
    const active = await this.db
      .selectDistinct({ userId: submissions.userId })
      .from(submissions)
      .innerJoin(
        participants,
        and(
          eq(participants.contestId, submissions.contestId),
          eq(participants.userId, submissions.userId),
        ),
      )
      .where(and(eq(submissions.contestId, c.id), eq(submissions.disqualified, false)));
    const rated = new Set(active.map((r) => r.userId));
    const rows = snap.rows.filter((r) => rated.has(r.userId));
    return rows.map((r) => ({
      id: r.userId,
      rank: 1 + rows.filter((o) => o.score > r.score).length,
    }));
  }

  /**
   * FR-CONT-07: ends the contest for good. Standings stop being frozen, and (for a rated contest
   * with at least 5 participants) ratings are computed from the ratings the users have now and
   * stored in `rating_changes`, with `users.rating` updated, all in one transaction. Only an
   * ended contest can be finalised, once.
   */
  async finalize(id: string, actor: Actor): Promise<FinalizeResult> {
    return tracer.startActiveSpan('contests.finalize', async (span) => {
      try {
        const c = await this.contest(id);
        const state = contestState(c, new Date());
        if (state !== 'ended') {
          throw new ProblemError(
            'validation',
            state === 'finalized'
              ? 'This contest is already finalised'
              : 'Only a contest that has ended can be finalised',
          );
        }
        const rules = ContestRules.parse(c.rules);
        const field = rules.rated ? await this.standings(c) : [];
        const rated = rules.rated && field.length >= MIN_RATED_PLAYERS;
        const changed = await this.db.transaction(async (tx) => {
          const [flipped] = await tx
            .update(contests)
            .set({ status: 'finalized' })
            .where(and(eq(contests.id, c.id), sql`${contests.status} <> 'finalized'`))
            .returning({ id: contests.id });
          if (!flipped) throw new ProblemError('validation', 'This contest is already finalised');
          let count = 0;
          if (rated) {
            const current = await tx
              .select({ id: users.id, rating: users.rating })
              .from(users)
              .where(
                inArray(
                  users.id,
                  field.map((f) => f.id),
                ),
              )
              .orderBy(asc(users.id))
              .for('update');
            const before = new Map(current.map((u) => [u.id, u.rating]));
            const players: Player[] = field
              .filter((f) => before.has(f.id))
              .map((f) => ({ id: f.id, rating: before.get(f.id)!, rank: f.rank }));
            const ranks = new Map(players.map((p) => [p.id, p.rank]));
            for (const r of computeRatings(players)) {
              await tx.insert(ratingChanges).values({
                contestId: c.id,
                userId: r.id,
                oldRating: r.oldRating,
                newRating: r.newRating,
                delta: r.delta,
                seed: String(r.seed),
                rank: ranks.get(r.id)!,
              });
              await tx.update(users).set({ rating: r.newRating }).where(eq(users.id, r.id));
              count += 1;
            }
          }
          await tx.insert(auditLog).values({
            actorId: actor.id,
            action: 'contest.finalize',
            targetType: 'contest',
            targetId: c.id,
            meta: { rated, changes: count },
          });
          return count;
        });
        counter.add(1, { action: 'finalize', rated: String(rated) });
        span.setAttribute('rated', rated);
        return { rated, changes: changed };
      } finally {
        span.end();
      }
    });
  }

  /**
   * FR-RATE-02: computes the ratings again from the stored pre-contest ratings and the standings
   * the submissions give now, and rewrites the rows. With unchanged submissions nothing differs.
   * A user's current rating is only moved when it is still the one this contest gave them.
   */
  async recompute(id: string, actor: Actor): Promise<RecomputeResult> {
    return tracer.startActiveSpan('contests.recompute-ratings', async (span) => {
      try {
        const c = await this.contest(id);
        if (c.status !== 'finalized') {
          throw new ProblemError('validation', 'Only a finalised contest has ratings to recompute');
        }
        const stored = await this.db
          .select()
          .from(ratingChanges)
          .where(eq(ratingChanges.contestId, c.id));
        if (stored.length === 0) return { differing: 0, changes: 0 };
        const field = await this.standings(c);
        const old = new Map(stored.map((r) => [r.userId, r]));
        const players: Player[] = field
          .filter((f) => old.has(f.id))
          .map((f) => ({ id: f.id, rating: old.get(f.id)!.oldRating, rank: f.rank }));
        const ranks = new Map(players.map((p) => [p.id, p.rank]));
        const next = computeRatings(players);
        let differing = 0;
        await this.db.transaction(async (tx) => {
          for (const r of next) {
            const was = old.get(r.id)!;
            if (was.newRating !== r.newRating || was.rank !== ranks.get(r.id)) differing += 1;
            await tx
              .update(ratingChanges)
              .set({
                newRating: r.newRating,
                delta: r.delta,
                seed: String(r.seed),
                rank: ranks.get(r.id)!,
              })
              .where(and(eq(ratingChanges.contestId, c.id), eq(ratingChanges.userId, r.id)));
            await tx
              .update(users)
              .set({ rating: r.newRating })
              .where(and(eq(users.id, r.id), eq(users.rating, was.newRating)));
          }
          await tx.insert(auditLog).values({
            actorId: actor.id,
            action: 'contest.recompute-ratings',
            targetType: 'contest',
            targetId: c.id,
            meta: { differing },
          });
        });
        counter.add(1, { action: 'recompute' });
        return { differing, changes: next.length };
      } finally {
        span.end();
      }
    });
  }

  /** `GET /contests/{slug}/results`: only once the contest is final. */
  async results(slug: string): Promise<ContestResults> {
    const [c] = await this.db.select().from(contests).where(eq(contests.slug, slug)).limit(1);
    if (!c || c.status !== 'finalized') {
      throw new ProblemError('not-found', 'No final results for this contest');
    }
    const rows = await this.db
      .select({
        userId: ratingChanges.userId,
        handle: users.handle,
        rank: ratingChanges.rank,
        oldRating: ratingChanges.oldRating,
        newRating: ratingChanges.newRating,
        delta: ratingChanges.delta,
      })
      .from(ratingChanges)
      .innerJoin(users, eq(users.id, ratingChanges.userId))
      .where(eq(ratingChanges.contestId, c.id))
      .orderBy(asc(ratingChanges.rank), asc(users.handle));
    return {
      serverNow: new Date().toISOString(),
      rated: rows.length > 0,
      changes: rows.map((r) => ({ ...r, handle: r.handle ?? 'unknown' })),
    };
  }

  /** `GET /users/{handle}/ratings`: the rating graph and contest history. */
  async history(handle: string): Promise<RatingHistory> {
    const [u] = await this.db
      .select({ id: users.id, handle: users.handle, rating: users.rating })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    if (!u) throw new ProblemError('not-found', 'No such user');
    const rows = await this.db
      .select({
        contestSlug: contests.slug,
        contestTitle: contests.title,
        endedAt: contests.endsAt,
        rank: ratingChanges.rank,
        oldRating: ratingChanges.oldRating,
        newRating: ratingChanges.newRating,
        delta: ratingChanges.delta,
      })
      .from(ratingChanges)
      .innerJoin(contests, eq(contests.id, ratingChanges.contestId))
      .where(eq(ratingChanges.userId, u.id))
      .orderBy(asc(contests.endsAt));
    return {
      handle: u.handle ?? handle,
      rating: u.rating,
      history: rows.map((r) => ({ ...r, endedAt: r.endedAt.toISOString() })),
    };
  }
}
