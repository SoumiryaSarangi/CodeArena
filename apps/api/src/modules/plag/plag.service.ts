import { Inject, Injectable } from '@nestjs/common';
import type {
  PlagClaim,
  PlagFail,
  PlagResults,
  PlagRun,
  PlagRunCreate,
  PlagRunList,
} from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import {
  auditLog,
  contestProblems,
  contests,
  plagClusters,
  plagPairs,
  plagRuns,
  problems,
} from '../../db/schema';
import { contestState } from '../contests/state';

const tracer = trace.getTracer('api');
const runsTotal = metrics
  .getMeter('api')
  .createCounter('ca_plag_runs_total', { description: 'Plagiarism runs by outcome' });

type RunRow = typeof plagRuns.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const record = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/**
 * PL-05 (SD-§13, SRS plag endpoints): creating a run, the job claiming it and taking the final submissions, the job
 * posting the pairs and clusters (or its failure), and the admin reading runs. The Python job (`apps/plag`) polls
 * `claim`; nothing here starts a process.
 */
@Injectable()
export class PlagService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  // ---- admin ---------------------------------------------------------------------------------------

  /** A run needs a contest that is over (SD-§13: the check runs on final submissions) and no run in progress. */
  async create(actorId: string, body: PlagRunCreate): Promise<PlagRun> {
    return tracer.startActiveSpan('plag.create', async (span) => {
      try {
        const [c] = await this.db
          .select({
            id: contests.id,
            status: contests.status,
            startsAt: contests.startsAt,
            endsAt: contests.endsAt,
          })
          .from(contests)
          .where(eq(contests.id, body.contestId))
          .limit(1);
        if (!c || c.status === 'draft') throw new ProblemError('not-found', 'No such contest');
        const state = contestState(c, new Date());
        if (state !== 'ended' && state !== 'finalized') {
          throw new ProblemError(
            'validation',
            'A plagiarism check runs after the contest has ended',
          );
        }
        const [active] = await this.db
          .select({ id: plagRuns.id })
          .from(plagRuns)
          .where(and(eq(plagRuns.contestId, c.id), inArray(plagRuns.status, ['queued', 'running'])))
          .limit(1);
        if (active)
          throw new ProblemError(
            'validation',
            'A run is already queued or running for this contest',
          );
        const run = await this.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(plagRuns)
            .values({ contestId: c.id, params: body.params ?? {}, status: 'queued' })
            .returning();
          await tx.insert(auditLog).values({
            actorId,
            action: 'plag.run.start',
            targetType: 'plag_run',
            targetId: row!.id,
            meta: { contestId: c.id },
          });
          return row!;
        });
        runsTotal.add(1, { outcome: 'queued' });
        return this.view(run, []);
      } finally {
        span.end();
      }
    });
  }

  async list(contestId?: string): Promise<PlagRunList> {
    const rows = await this.db
      .select()
      .from(plagRuns)
      .where(contestId ? eq(plagRuns.contestId, contestId) : undefined)
      .orderBy(desc(plagRuns.id))
      .limit(100);
    return {
      items: rows.map((r) => ({
        id: r.id,
        contestId: r.contestId,
        status: r.status,
        params: record(r.params),
        metrics: record(r.metrics),
        startedAt: iso(r.startedAt),
        finishedAt: iso(r.finishedAt),
      })),
    };
  }

  async get(id: string): Promise<PlagRun> {
    const [run] = await this.db.select().from(plagRuns).where(eq(plagRuns.id, id)).limit(1);
    if (!run) throw new ProblemError('not-found', 'No such run');
    const clusters = await this.db
      .select({
        id: plagClusters.id,
        problemId: plagClusters.problemId,
        problemSlug: problems.slug,
        ids: plagClusters.submissionIds,
        maxScore: plagClusters.maxScore,
      })
      .from(plagClusters)
      .innerJoin(problems, eq(problems.id, plagClusters.problemId))
      .where(eq(plagClusters.runId, id))
      .orderBy(desc(plagClusters.maxScore), asc(plagClusters.id));
    return this.view(
      run,
      clusters.map((c) => ({
        id: c.id,
        problemId: c.problemId,
        problemSlug: c.problemSlug,
        size: c.ids.length,
        maxScore: c.maxScore,
      })),
    );
  }

  private view(r: RunRow, clusters: PlagRun['clusters']): PlagRun {
    return {
      id: r.id,
      contestId: r.contestId,
      status: r.status,
      params: record(r.params),
      metrics: record(r.metrics),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      clusters,
    };
  }

  // ---- the job ----------------------------------------------------------------------------------------

  /**
   * The job asks for work. Takes the oldest queued run (or a run that has been "running" longer than
   * `PLAG_STALE_MINUTES`: its job died), marks it running, and returns the final submissions of the contest's problems.
   * `null` when there is nothing to do. Two jobs never get the same run (`FOR UPDATE SKIP LOCKED`).
   */
  async claim(): Promise<PlagClaim | null> {
    return tracer.startActiveSpan('plag.claim', async (span) => {
      try {
        const stale = `${this.config.PLAG_STALE_MINUTES} minutes`;
        const taken = await this.db.execute<{
          id: string;
          contest_id: string;
          params: unknown;
        }>(sql`
          update plag_runs set status = 'running', started_at = now(), finished_at = null
          where id = (
            select id from plag_runs
            where status = 'queued' or (status = 'running' and started_at < now() - ${stale}::interval)
            order by id limit 1 for update skip locked)
          returning id, contest_id, params`);
        const row = (taken.rows ?? (taken as unknown as typeof taken.rows))[0];
        if (!row) return null;
        span.setAttribute('plag.run', row.id);
        return {
          runId: row.id,
          params: record(row.params) ?? {},
          problems: await this.inputs(row.contest_id),
        };
      } finally {
        span.end();
      }
    });
  }

  /**
   * SD-§13.1 step 1: per contest problem, one submission per person: their last accepted one, else their last judged
   * attempt (disqualified ones excluded). Persons are opaque ids; handles and e-mails never leave the API.
   */
  private async inputs(contestId: string): Promise<PlagClaim['problems']> {
    const list = await this.db
      .select({ problemId: contestProblems.problemId, slug: problems.slug })
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .where(eq(contestProblems.contestId, contestId))
      .orderBy(asc(contestProblems.label));
    const found = await this.db.execute<{
      id: string;
      user_id: string;
      language: string;
      source: string;
      problem_id: string;
    }>(sql`
      select distinct on (s.user_id, pv.problem_id) s.id, s.user_id, s.language, s.source, pv.problem_id
      from submissions s join problem_versions pv on pv.id = s.problem_version_id
      where s.contest_id = ${contestId} and s.verdict is not null and not s.disqualified
      order by s.user_id, pv.problem_id, (s.verdict = 'AC') desc, s.created_at desc`);
    const rows = found.rows ?? (found as unknown as typeof found.rows);
    return list.map((p) => ({
      problemId: p.problemId,
      slug: p.slug,
      templates: [],
      submissions: rows
        .filter((r) => r.problem_id === p.problemId)
        .map((r) => ({ id: r.id, language: r.language, source: r.source, user: r.user_id })),
    }));
  }

  /** The job's answer: pairs and clusters per problem. Only a run that is `running` takes it, and only once. */
  async results(runId: string, body: PlagResults): Promise<{ pairs: number; clusters: number }> {
    return tracer.startActiveSpan('plag.results', async (span) => {
      try {
        if (body.runId !== runId)
          throw new ProblemError('validation', 'The run id in the body does not match');
        const [run] = await this.db.select().from(plagRuns).where(eq(plagRuns.id, runId)).limit(1);
        if (!run) throw new ProblemError('not-found', 'No such run');
        if (run.status !== 'running')
          throw new ProblemError('validation', `The run is ${run.status}, not running`);

        // Every problem and submission must belong to this contest: a bad payload must not write other data.
        const inContest = await this.inputs(run.contestId);
        const known = new Map(
          inContest.map((p) => [p.problemId, new Set(p.submissions.map((s) => s.id))]),
        );
        for (const p of body.problems) {
          const subs = known.get(p.problemId);
          if (!subs)
            throw new ProblemError('validation', 'A problem in the results is not in the contest');
          const ids = [
            ...p.pairs.flatMap((x) => [x.subA, x.subB]),
            ...p.clusters.flatMap((c) => c.submissionIds),
          ];
          if (ids.some((i) => !subs.has(i))) {
            throw new ProblemError(
              'validation',
              'A submission in the results was not part of the check',
            );
          }
        }

        let pairs = 0;
        let clusters = 0;
        await this.db.transaction(async (tx) => {
          for (const p of body.problems) {
            const rows = p.pairs.map((x) => {
              const [a, b] = x.subA < x.subB ? [x.subA, x.subB] : [x.subB, x.subA];
              return {
                runId,
                problemId: p.problemId,
                subA: a,
                subB: b,
                fpScore: x.fpScore,
                embScore: x.embScore,
                combined: x.combined,
              };
            });
            for (let i = 0; i < rows.length; i += 500) {
              await tx
                .insert(plagPairs)
                .values(rows.slice(i, i + 500))
                .onConflictDoNothing();
            }
            pairs += rows.length;
            if (p.clusters.length > 0) {
              await tx.insert(plagClusters).values(
                p.clusters.map((c) => ({
                  runId,
                  problemId: p.problemId,
                  submissionIds: [...c.submissionIds].sort(),
                  maxScore: c.maxScore,
                })),
              );
              clusters += p.clusters.length;
            }
          }
          const [done] = await tx
            .update(plagRuns)
            .set({
              status: 'done',
              finishedAt: new Date(),
              metrics: {
                pairs,
                clusters,
                params: body.params ?? null,
                problems: body.problems.map((p) => ({
                  problemId: p.problemId,
                  ...(p.metrics ?? {}),
                })),
              },
            })
            .where(and(eq(plagRuns.id, runId), eq(plagRuns.status, 'running')))
            .returning({ id: plagRuns.id });
          if (!done) throw new ProblemError('validation', 'The run is no longer running');
        });
        runsTotal.add(1, { outcome: 'done' });
        span.setAttributes({ 'plag.pairs': pairs, 'plag.clusters': clusters });
        return { pairs, clusters };
      } finally {
        span.end();
      }
    });
  }

  /** The job gave up (the model would not load, a crash): the run is `failed` with the reason. */
  async fail(runId: string, body: PlagFail): Promise<void> {
    const done = await this.db
      .update(plagRuns)
      .set({ status: 'failed', finishedAt: new Date(), metrics: { error: body.error } })
      .where(and(eq(plagRuns.id, runId), eq(plagRuns.status, 'running')))
      .returning({ id: plagRuns.id });
    if (done.length === 0) throw new ProblemError('validation', 'No such run in progress');
    runsTotal.add(1, { outcome: 'failed' });
  }
}
