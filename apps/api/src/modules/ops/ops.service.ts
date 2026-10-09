import {
  JudgeJob,
  MAX_CONTEST_MINUTES,
  type ContestExtend,
  type ContestExtendResult,
  type DlqList,
  type Lane,
  type OpsSummary,
  type Rejudge,
  type RejudgeResult,
  type Role,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import { auditLog, contestProblems, contests, problemVersions, submissions } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { BoardService } from '../board/board.service';
import { contestState } from '../contests/state';
import { newCanaryToken } from '../signals/canary';
import { MessagesService } from '../contests/messages.service';
import { buildJob } from '../submissions/job-builder';
import { laneDepth } from '../submissions/lane-depth';
import { liveWorkers } from '../submissions/live-workers';
import { QUEUE_KEY_PREFIX, QueueService } from '../submissions/queue.service';

const tracer = trace.getTracer('api');
const actions = metrics.getMeter('api').createCounter('ca_ops_actions_total', {
  description: 'Admin operations on contests and the judge queue, by action',
});

const LANES: Lane[] = ['contest', 'interactive', 'practice', 'rejudge'];
/** One rejudge request handles at most this many submissions (run it again for the rest). */
export const REJUDGE_LIMIT = 2000;

interface Actor {
  id: string;
  role: Role;
}

/** Contest operations and judge-queue visibility for admins (C-07, S16). */
@Injectable()
export class OpsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(BoardService) private readonly board: BoardService,
    @Inject(MessagesService) private readonly messages: MessagesService,
  ) {}

  private async contest(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ProblemError('not-found', 'No such contest');
    const [c] = await this.db.select().from(contests).where(eq(contests.id, id)).limit(1);
    if (!c) throw new ProblemError('not-found', 'No such contest');
    return c;
  }

  private audit(actor: Actor, action: string, targetType: string, targetId: string, meta?: object) {
    return this.db
      .insert(auditLog)
      .values({ actorId: actor.id, action, targetType, targetId, meta: meta ?? null });
  }

  /**
   * IN-02: switch a problem's canary instruction on or off. The identifier is created the first time and kept, so a
   * submission can still be checked after the switch is turned off. Audit-logged.
   */
  async setCanary(
    id: string,
    label: string,
    enabled: boolean,
    actor: Actor,
  ): Promise<{ enabled: boolean }> {
    return tracer.startActiveSpan('ops.canary', async (span) => {
      try {
        const c = await this.contest(id);
        const [row] = await this.db
          .select({ token: contestProblems.canaryToken })
          .from(contestProblems)
          .where(and(eq(contestProblems.contestId, c.id), eq(contestProblems.label, label)))
          .limit(1);
        if (!row) throw new ProblemError('not-found', 'No such problem');
        await this.db
          .update(contestProblems)
          .set({ canaryOn: enabled, canaryToken: row.token ?? (enabled ? newCanaryToken() : null) })
          .where(and(eq(contestProblems.contestId, c.id), eq(contestProblems.label, label)));
        await this.audit(
          actor,
          enabled ? 'contest.canary-on' : 'contest.canary-off',
          'contest',
          c.id,
          {
            label,
          },
        );
        actions.add(1, { action: enabled ? 'canary-on' : 'canary-off' });
        return { enabled };
      } finally {
        span.end();
      }
    });
  }

  /** FR-CONT-05: move the end later and tell the contestants. The freeze time stays where it was. */
  async extend(id: string, actor: Actor, body: ContestExtend): Promise<ContestExtendResult> {
    return tracer.startActiveSpan('ops.extend', async (span) => {
      try {
        const c = await this.contest(id);
        const state = contestState(c, new Date());
        if (state === 'ended' || state === 'finalized') {
          throw new ProblemError('validation', 'The contest is over; it cannot be extended', {
            errors: [{ path: 'minutes', message: 'the contest has ended' }],
          });
        }
        const endsAt = new Date(c.endsAt.getTime() + body.minutes * 60_000);
        if (endsAt.getTime() - c.startsAt.getTime() > MAX_CONTEST_MINUTES * 60_000) {
          throw new ProblemError(
            'validation',
            `A contest is at most ${MAX_CONTEST_MINUTES} minutes`,
            {
              errors: [{ path: 'minutes', message: 'that would make the contest too long' }],
            },
          );
        }
        await this.db.update(contests).set({ endsAt }).where(eq(contests.id, c.id));
        await this.audit(actor, 'contest.extend', 'contest', c.id, {
          minutes: body.minutes,
          endsAt: endsAt.toISOString(),
        });
        actions.add(1, { action: 'extend' });
        const note = await this.messages.announce(c.id, actor, {
          body: `The contest has been extended by ${body.minutes} minutes. It now ends at ${endsAt.toISOString().slice(11, 16)} UTC.`,
        });
        return { endsAt: endsAt.toISOString(), announcementId: note.id };
      } finally {
        span.end();
      }
    });
  }

  /**
   * Hides a problem from contestants and takes it off the board, or brings it back. Submissions
   * already made stay in the database; the board is rebuilt without (or with) the column.
   */
  async setHidden(
    id: string,
    label: string,
    hidden: boolean,
    actor: Actor,
  ): Promise<{ hidden: boolean }> {
    return tracer.startActiveSpan('ops.hide-problem', async (span) => {
      try {
        const c = await this.contest(id);
        const updated = await this.db
          .update(contestProblems)
          .set({ hidden })
          .where(and(eq(contestProblems.contestId, c.id), eq(contestProblems.label, label)))
          .returning({ label: contestProblems.label });
        if (updated.length === 0) throw new ProblemError('not-found', 'No such problem');
        await this.audit(
          actor,
          hidden ? 'contest.hide-problem' : 'contest.show-problem',
          'contest',
          c.id,
          {
            label,
          },
        );
        actions.add(1, { action: hidden ? 'hide-problem' : 'show-problem' });
        if (c.status !== 'draft') await this.board.rebuild(c.id, 'admin');
        return { hidden };
      } finally {
        span.end();
      }
    });
  }

  /**
   * FR-OPS-02: another run for a submission, every submission of a problem, or of a contest. The
   * run version goes up (the newer result wins; the old verdict stays until it arrives), the
   * submission is judged against the version it was made for, and the action is audit-logged.
   */
  async rejudge(actor: Actor, body: Rejudge): Promise<RejudgeResult> {
    return tracer.startActiveSpan('ops.rejudge', async (span) => {
      try {
        span.setAttribute('scope', body.scope);
        const where =
          body.scope === 'submission'
            ? eq(submissions.id, body.id)
            : body.scope === 'contest'
              ? eq(submissions.contestId, body.id)
              : inArray(
                  submissions.problemVersionId,
                  this.db
                    .select({ id: problemVersions.id })
                    .from(problemVersions)
                    .where(eq(problemVersions.problemId, body.id)),
                );
        const rows = await this.db
          .select({
            id: submissions.id,
            language: submissions.language,
            source: submissions.source,
            versionId: submissions.problemVersionId,
            status: submissions.status,
            contestId: submissions.contestId,
            userId: submissions.userId,
          })
          .from(submissions)
          .where(where)
          .limit(REJUDGE_LIMIT + 1);
        if (rows.length === 0 && body.scope === 'submission') {
          throw new ProblemError('not-found', 'No such submission');
        }
        const truncated = rows.length > REJUDGE_LIMIT;
        const picked = rows.slice(0, REJUDGE_LIMIT);
        const versionIds = [...new Set(picked.map((r) => r.versionId))];
        const versions = versionIds.length
          ? await this.db
              .select()
              .from(problemVersions)
              .where(inArray(problemVersions.id, versionIds))
          : [];
        const byId = new Map(versions.map((v) => [v.id, v]));
        const lane: Lane = body.urgent ? 'contest' : 'rejudge';
        let queued = 0;
        let skipped = 0;
        const touched = new Set<string>();
        for (const r of picked) {
          const version = byId.get(r.versionId);
          // Still waiting for its first verdict: that run will produce one anyway.
          if (!version || !version.testsetHash || r.status === 'queued' || r.status === 'judging') {
            skipped += 1;
            continue;
          }
          const [bumped] = await this.db
            .update(submissions)
            .set({ currentRunVersion: sql`${submissions.currentRunVersion} + 1` })
            .where(and(eq(submissions.id, r.id), inArray(submissions.status, ['done', 'failed'])))
            .returning({ runVersion: submissions.currentRunVersion });
          if (!bumped) {
            skipped += 1;
            continue;
          }
          try {
            await this.queue.enqueue(
              buildJob(
                {
                  id: r.id,
                  language: r.language,
                  source: r.source,
                  lane,
                  runVersion: bumped.runVersion,
                },
                version,
                'submit',
              ),
            );
            queued += 1;
            if (r.contestId) touched.add(r.contestId);
          } catch {
            // Nothing was queued: give the run version back so the submission is not left waiting.
            await this.db
              .update(submissions)
              .set({ currentRunVersion: sql`${submissions.currentRunVersion} - 1` })
              .where(
                and(eq(submissions.id, r.id), eq(submissions.currentRunVersion, bumped.runVersion)),
              );
            skipped += 1;
          }
        }
        await this.audit(actor, 'rejudge', body.scope, body.id, {
          queued,
          skipped,
          urgent: body.urgent,
          truncated,
        });
        actions.add(1, { action: 'rejudge' });
        span.setAttributes({ queued, skipped });
        return { queued, skipped, truncated };
      } finally {
        span.end();
      }
    });
  }

  /** Lane depths, worker heartbeats, time-to-verdict, throughput and the dead-letter count. */
  async summary(): Promise<OpsSummary> {
    return tracer.startActiveSpan('ops.summary', async (span) => {
      try {
        const now = Date.now();
        const [lanes, workers, times, dlq] = await Promise.all([
          Promise.all(
            LANES.map(async (lane) => ({
              lane,
              depth: await laneDepth(this.redis, this.prefix, lane),
            })),
          ),
          liveWorkers(this.redis, this.prefix, now),
          this.db.execute<{ p50: number | null; p95: number | null; n: number }>(sql`
            select
              percentile_cont(0.5) within group (order by extract(epoch from (judged_at - created_at)) * 1000) as p50,
              percentile_cont(0.95) within group (order by extract(epoch from (judged_at - created_at)) * 1000) as p95,
              count(*)::int as n
            from submissions
            where judged_at is not null and judged_at > now() - interval '15 minutes'
          `),
          this.redis.xlen(`${this.prefix}jobs:dlq`).catch(() => 0),
        ]);
        const row =
          times.rows?.[0] ??
          (times as unknown as { p50: number | null; p95: number | null; n: number }[])[0];
        const [perMin] = (
          await this.db.execute<{ n: number }>(sql`
          select count(*)::int as n from submissions where created_at > now() - interval '5 minutes'
        `)
        ).rows ?? [{ n: 0 }];
        actions.add(1, { action: 'summary' });
        return {
          serverNow: new Date(now).toISOString(),
          lanes,
          workers,
          p50Ms: row && row.n > 0 && row.p50 !== null ? Math.round(Number(row.p50)) : null,
          p95Ms: row && row.n > 0 && row.p95 !== null ? Math.round(Number(row.p95)) : null,
          submissionsPerMin: Math.round(((perMin?.n ?? 0) / 5) * 10) / 10,
          dlq,
        };
      } finally {
        span.end();
      }
    });
  }

  /** FR-OPS-01: the jobs judges gave up on, newest first. */
  async dlq(): Promise<DlqList> {
    const entries = await this.redis
      .xrevrange(`${this.prefix}jobs:dlq`, '+', '-', 'COUNT', 100)
      .catch(() => []);
    return {
      items: entries.map(([entryId, fields]) => {
        const f: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
        let submissionId: string | null = null;
        try {
          submissionId =
            (JSON.parse(f.job ?? '{}') as { submissionId?: string }).submissionId ?? null;
        } catch {
          // unreadable job: no submission to name
        }
        return {
          entryId,
          reason: f.reason ?? '',
          error: f.error ?? '',
          lane: f.lane ?? '',
          submissionId,
          workerId: f.workerId ?? '',
          at: f.ts ? Number(f.ts) : null,
        };
      }),
    };
  }

  /** Puts a dead-lettered job back on its lane (as a new job) and removes the entry. */
  async requeue(entryId: string, actor: Actor): Promise<{ lane: Lane }> {
    return tracer.startActiveSpan('ops.dlq-requeue', async (span) => {
      try {
        const key = `${this.prefix}jobs:dlq`;
        if (!/^\d+-\d+$/.test(entryId)) throw new ProblemError('not-found', 'No such entry');
        const [found] = await this.redis.xrange(key, entryId, entryId);
        if (!found) throw new ProblemError('not-found', 'No such entry');
        const fields = found[1];
        const i = fields.indexOf('job');
        const parsed = JudgeJob.safeParse(i < 0 ? null : safeJson(fields[i + 1]!));
        if (!parsed.success) {
          throw new ProblemError('validation', 'That job cannot be read; it cannot be re-queued');
        }
        const { seq, jobId, enqueuedAt, ...job } = parsed.data;
        void seq;
        void jobId;
        void enqueuedAt;
        // O-06: an `execution-failed` job has already stored an SE verdict for its run version (the
        // worker publishes SE, then dead-letters it). Putting it back with the same version would
        // have its result thrown away as a duplicate, so the contestant would stay on SE: a
        // submission that already has a verdict gets a new run version, like a rejudge.
        let runVersion = job.runVersion;
        const bumped = await this.db
          .update(submissions)
          .set({ currentRunVersion: sql`${submissions.currentRunVersion} + 1` })
          .where(
            and(
              eq(submissions.id, job.submissionId),
              inArray(submissions.status, ['done', 'failed']),
            ),
          )
          .returning({ runVersion: submissions.currentRunVersion });
        if (bumped[0]) runVersion = bumped[0].runVersion;
        try {
          await this.queue.enqueue({ ...job, runVersion });
        } catch (e) {
          if (bumped[0]) {
            await this.db
              .update(submissions)
              .set({ currentRunVersion: sql`${submissions.currentRunVersion} - 1` })
              .where(
                and(
                  eq(submissions.id, job.submissionId),
                  eq(submissions.currentRunVersion, bumped[0].runVersion),
                ),
              );
          }
          throw e;
        }
        await this.redis.xdel(key, entryId);
        await this.audit(actor, 'dlq.requeue', 'job', entryId, { submissionId: job.submissionId });
        actions.add(1, { action: 'dlq-requeue' });
        return { lane: job.lane };
      } finally {
        span.end();
      }
    });
  }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
