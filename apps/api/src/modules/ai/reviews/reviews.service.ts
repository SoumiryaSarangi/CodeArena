import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ReviewItem, ReviewList, ReviewResult } from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../../common/problem';
import { CONFIG, type Config } from '../../../config/config';
import { DB, type Db } from '../../../db/db.module';
import {
  contestProblems,
  contests,
  problemVersions,
  problems,
  productEvents,
  reviews,
  submissions,
} from '../../../db/schema';
import { LOGGER } from '../../../telemetry/logger';
import { contestState } from '../../contests/state';
import { budgetFor } from '../ai.config';
import { aiWorkerEnabled } from '../queue';
import { AiLedger } from '../ledger';
import { AiRouter } from '../router';
import { modelKey } from '../types';
import { hasAllSections, REVIEW, REVIEW_PROMPT_VERSION } from './review-prompts';

const tracer = trace.getTracer('api');
const reviewsTotal = metrics
  .getMeter('api')
  .createCounter('ca_reviews_total', { description: 'Reviews by outcome and trigger' });

/** Reviews younger than this (finalised contests) are looked for by the background writer. */
const SWEEP_WINDOW_DAYS = 14;
/** The background writer stops while the review model's daily budget is more than this used (hints need the rest). */
const BACKGROUND_BUDGET_SHARE = 0.7;
/** On-demand opening per user per hour. */
const OPENS_PER_HOUR = 30;

type Row = typeof reviews.$inferSelect;

/**
 * AI-03 (FR-AI-08, PRD US-8.2): one review per participant per attempted problem, of their final submission, once a
 * contest is finalised. Written on demand when opened, and by a paced background writer that wakes every minute,
 * writes a few, and stops when the review model's daily budget is mostly used. The state lives in the `reviews` table
 * (`pending` / `ready` / `failed`), so a restart loses nothing.
 */
@Injectable()
export class ReviewsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AiRouter) private readonly router: AiRouter,
    @Inject(AiLedger) private readonly ledger: AiLedger,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onApplicationBootstrap() {
    if (aiWorkerEnabled(this.config)) this.start();
  }

  start() {
    this.timer ??= setInterval(() => {
      this.sweeping = this.sweep().catch((err) =>
        this.log.warn({ err: { message: (err as Error).message } }, 'review sweep failed'),
      );
    }, this.config.AI_REVIEW_EVERY_MS);
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping;
  }

  // ---- lookups -----------------------------------------------------------------------------

  /** A finalised contest, or an error: reviews exist only after finalising (FR-AI-08), and a draft does not exist. */
  private async finalContest(slug: string) {
    const [c] = await this.db
      .select({
        id: contests.id,
        status: contests.status,
        startsAt: contests.startsAt,
        endsAt: contests.endsAt,
      })
      .from(contests)
      .where(eq(contests.slug, slug))
      .limit(1);
    if (!c || c.status === 'draft') throw new ProblemError('not-found', 'No such contest');
    if (contestState(c, new Date()) !== 'finalized') {
      throw new ProblemError('forbidden', 'Reviews are available once the contest is finalised');
    }
    return c;
  }

  /**
   * Creates the missing `pending` rows for the final submission of each (participant, problem) in a contest, or
   * for one participant. "Final" = the latest judged, not disqualified submission. Safe to repeat.
   */
  async ensureRows(contestId: string, userId?: string) {
    const found = await this.db.execute<{
      submission_id: string;
      user_id: string;
      problem_id: string;
    }>(sql`
      select distinct on (s.user_id, pv.problem_id) s.id as submission_id, s.user_id, pv.problem_id
      from submissions s join problem_versions pv on pv.id = s.problem_version_id
      where s.contest_id = ${contestId} and s.verdict is not null and not s.disqualified
        ${userId ? sql`and s.user_id = ${userId}` : sql``}
      order by s.user_id, pv.problem_id, s.created_at desc`);
    const rows = found.rows ?? (found as unknown as typeof found.rows);
    if (rows.length === 0) return 0;
    const inserted = await this.db
      .insert(reviews)
      .values(
        rows.map((r) => ({
          userId: r.user_id,
          contestId,
          problemId: r.problem_id,
          submissionId: r.submission_id,
        })),
      )
      .onConflictDoNothing({ target: reviews.submissionId })
      .returning({ id: reviews.id });
    return inserted.length;
  }

  private statusOf(row: Row, generating: boolean): ReviewItem['status'] {
    if (row.status === 'ready') return 'ready';
    if (row.status === 'failed') return 'failed';
    return generating ? 'generating' : 'queued';
  }

  // ---- my reviews --------------------------------------------------------------------------

  async list(userId: string, slug: string): Promise<ReviewList> {
    const c = await this.finalContest(slug);
    await this.ensureRows(c.id, userId);
    const rows = await this.db
      .select({
        review: reviews,
        label: contestProblems.label,
        slug: problems.slug,
        title: problems.title,
        verdict: submissions.verdict,
        failedTest: submissions.failedTest,
      })
      .from(reviews)
      .innerJoin(submissions, eq(submissions.id, reviews.submissionId))
      .innerJoin(problems, eq(problems.id, reviews.problemId))
      .innerJoin(
        contestProblems,
        and(
          eq(contestProblems.contestId, reviews.contestId),
          eq(contestProblems.problemId, reviews.problemId),
        ),
      )
      .where(and(eq(reviews.userId, userId), eq(reviews.contestId, c.id)))
      .orderBy(asc(contestProblems.label));
    const items: ReviewItem[] = [];
    for (const r of rows) {
      const generating =
        r.review.status === 'pending' && (await this.ledger.isLocked(`review:${r.review.id}`));
      items.push({
        reviewId: r.review.id,
        submissionId: r.review.submissionId,
        label: r.label,
        problemSlug: r.slug,
        problemTitle: r.title,
        verdict: r.verdict,
        failedTest: r.failedTest,
        status: this.statusOf(r.review, generating),
        contentMd: r.review.status === 'ready' ? r.review.contentMd : null,
        helpful: r.review.helpful,
      });
    }
    return { items };
  }

  /** Opening a review: ready → as is; otherwise write it now (on demand), or say it is queued when AI is busy. */
  async open(userId: string, submissionId: string): Promise<ReviewResult> {
    const [sub] = await this.db
      .select({ userId: submissions.userId, contestId: submissions.contestId })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);
    if (!sub || sub.userId !== userId || !sub.contestId)
      throw new ProblemError('not-found', 'No such review');
    const [c] = await this.db
      .select({ slug: contests.slug })
      .from(contests)
      .where(eq(contests.id, sub.contestId))
      .limit(1);
    await this.finalContest(c!.slug);
    await this.ensureRows(sub.contestId, userId);
    const [row] = await this.db
      .select()
      .from(reviews)
      .where(eq(reviews.submissionId, submissionId))
      .limit(1);
    // A submission that is not the final one for its problem has no review.
    if (!row)
      throw new ProblemError(
        'not-found',
        'No review for this submission: only your final one is reviewed',
      );
    if (row.status === 'ready') return this.result(row);
    await this.router.guardUser('review', userId, OPENS_PER_HOUR);
    await this.db
      .insert(productEvents)
      .values({ userId, name: 'review_opened', props: { reviewId: row.id } })
      .catch(() => {});
    const after = await this.generate(row, 'on-demand');
    return this.result(after.row, after.generating);
  }

  private result(row: Row, generating = false): ReviewResult {
    return {
      status: this.statusOf(row, generating),
      reviewId: row.id,
      contentMd: row.status === 'ready' ? row.contentMd : null,
      helpful: row.helpful,
    };
  }

  async rate(userId: string, reviewId: string, helpful: boolean) {
    const done = await this.db
      .update(reviews)
      .set({ helpful })
      .where(and(eq(reviews.id, reviewId), eq(reviews.userId, userId)))
      .returning({ id: reviews.id });
    if (done.length === 0) throw new ProblemError('not-found', 'No such review');
    await this.db
      .insert(productEvents)
      .values({ userId, name: 'review_rated', props: { reviewId, helpful } })
      .catch(() => {});
  }

  // ---- writing one -------------------------------------------------------------------------

  /**
   * Writes the review for `row` unless someone else is already doing it. AI busy (budget used up, rate limit) leaves
   * it `pending` (queued); a bad or failed answer marks it `failed` (opening it again retries).
   */
  async generate(
    row: Row,
    trigger: 'on-demand' | 'background',
  ): Promise<{ row: Row; generating: boolean }> {
    const lock = `review:${row.id}`;
    if (!(await this.ledger.tryLock(lock, 120))) return { row, generating: true };
    return tracer.startActiveSpan('reviews.generate', async (span) => {
      try {
        const ctx = await this.context(row);
        let text: string | null = null;
        let model = '';
        let tokens = 0;
        for (let attempt = 0; attempt < 2 && text === null; attempt++) {
          const r = await this.router.complete({
            task: 'review',
            feature: trigger === 'background' ? 'review-background' : 'review',
            messages: REVIEW.render({ ...ctx, strict: attempt > 0 }),
            maxTokens: 700,
          });
          tokens += r.usage.inputTokens + r.usage.outputTokens;
          model = r.model;
          if (hasAllSections(r.text)) text = r.text.trim();
        }
        if (text === null)
          return {
            row: await this.mark(row, { status: 'failed', model, tokens }, trigger, 'bad-format'),
            generating: false,
          };
        reviewsTotal.add(1, { outcome: 'ready', trigger });
        return {
          row: await this.mark(
            row,
            {
              status: 'ready',
              contentMd: text,
              model,
              tokens,
              promptVersion: REVIEW_PROMPT_VERSION,
              readyAt: new Date(),
            },
            trigger,
            'ready',
          ),
          generating: false,
        };
      } catch (err) {
        if (
          err instanceof ProblemError &&
          (err.code === 'ai-busy' || err.code === 'rate-limited')
        ) {
          reviewsTotal.add(1, { outcome: 'queued', trigger });
          return { row, generating: false }; // stays pending: the background writer or the next open tries again
        }
        this.log.warn(
          { reviewId: row.id, err: { message: (err as Error).message } },
          'review failed',
        );
        return {
          row: await this.mark(row, { status: 'failed' }, trigger, 'error'),
          generating: false,
        };
      } finally {
        await this.ledger.unlock(lock);
        span.end();
      }
    });
  }

  private async mark(
    row: Row,
    set: Partial<typeof reviews.$inferInsert>,
    trigger: string,
    outcome: string,
  ): Promise<Row> {
    if (outcome !== 'ready') reviewsTotal.add(1, { outcome, trigger });
    const [updated] = await this.db
      .update(reviews)
      .set(set)
      .where(eq(reviews.id, row.id))
      .returning();
    return updated ?? row;
  }

  private async context(row: Row) {
    const [r] = await this.db
      .select({
        source: submissions.source,
        language: submissions.language,
        verdict: submissions.verdict,
        failedTest: submissions.failedTest,
        title: problems.title,
        statement: problemVersions.statementMd,
        editorial: problemVersions.editorialMd,
        limits: problemVersions.limits,
      })
      .from(submissions)
      .innerJoin(problemVersions, eq(problemVersions.id, submissions.problemVersionId))
      .innerJoin(problems, eq(problems.id, problemVersions.problemId))
      .where(eq(submissions.id, row.submissionId))
      .limit(1);
    if (!r) throw new Error('submission is gone');
    return {
      title: r.title,
      statement: r.statement,
      editorial: r.editorial,
      code: r.source,
      language: r.language,
      verdict: r.verdict,
      failedTest: r.failedTest,
      timeLimitMs: (r.limits as { timeMs?: number } | null)?.timeMs ?? null,
    };
  }

  // ---- the background writer ---------------------------------------------------------------

  /** True while the first review model still has room in today's budget for background work. */
  private async hasHeadroom(): Promise<boolean> {
    const first = this.router.settings.routes.review[0];
    const budget = first && budgetFor(this.router.settings, first);
    if (!first || !budget) return false;
    const used = await this.ledger.used(modelKey(first));
    return used.tokens < budget.tokensPerDay * BACKGROUND_BUDGET_SHARE;
  }

  /** One wake-up: make rows for recently finalised contests, then write a few pending reviews, oldest first. */
  async sweep(): Promise<{ created: number; written: number }> {
    if (!this.router.available) return { created: 0, written: 0 };
    if (
      !(await this.ledger.tryLock(
        'review-sweep',
        Math.max(5, Math.ceil(this.config.AI_REVIEW_EVERY_MS / 1000) - 1),
      ))
    ) {
      return { created: 0, written: 0 };
    }
    let created = 0;
    let written = 0;
    const recent = await this.db
      .select({ id: contests.id })
      .from(contests)
      .where(
        and(
          eq(contests.status, 'finalized'),
          gt(contests.endsAt, sql`now() - ${`${SWEEP_WINDOW_DAYS} days`}::interval`),
        ),
      );
    for (const c of recent) created += await this.ensureRows(c.id);
    const pending = await this.db
      .select()
      .from(reviews)
      .where(eq(reviews.status, 'pending'))
      .orderBy(asc(reviews.createdAt))
      .limit(this.config.AI_REVIEW_PER_TICK);
    for (const row of pending) {
      if (!(await this.hasHeadroom())) break;
      const out = await this.generate(row, 'background');
      if (out.row.status === 'ready') written += 1;
      else if (out.row.status === 'pending') break; // AI is busy: try again next wake-up
    }
    if (created + written > 0) this.log.info({ created, written }, 'review sweep');
    return { created, written };
  }
}
