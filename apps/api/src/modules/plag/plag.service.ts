import { Inject, Injectable } from '@nestjs/common';
import type {
  PlagClaim,
  PlagClusterDetail,
  PlagClusterStatus,
  PlagDecision,
  PlagDecisionCreate,
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
  editorSignals,
  plagClusters,
  plagPairs,
  plagRuns,
  problems,
  reviewDecisions,
  submissions,
  users,
} from '../../db/schema';
import { contestState } from '../contests/state';
import { containsCanary } from '../signals/canary';
import { styleShift, timeToAcMinutes } from '../signals/derive';

const tracer = trace.getTracer('api');
const runsTotal = metrics
  .getMeter('api')
  .createCounter('ca_plag_runs_total', { description: 'Plagiarism runs by outcome' });

const decisionsTotal = metrics
  .getMeter('api')
  .createCounter('ca_plag_decisions_total', { description: 'Review decisions by kind' });

type RunRow = typeof plagRuns.$inferSelect;

/** The reviewer's words (clear / confirm / discuss) and the stored enum. */
const TO_DB = { clear: 'dismissed', confirm: 'confirmed', discuss: 'needs_more' } as const;
const FROM_DB: Record<(typeof TO_DB)[PlagDecision], PlagDecision> = {
  dismissed: 'clear',
  confirmed: 'confirm',
  needs_more: 'discuss',
};

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
    const latest = await this.latestDecisions(clusters.map((c) => c.id));
    return this.view(
      run,
      clusters.map((c) => ({
        id: c.id,
        problemId: c.problemId,
        problemSlug: c.problemSlug,
        size: c.ids.length,
        maxScore: c.maxScore,
        status: latest.get(c.id) ?? 'open',
      })),
    );
  }

  /** The latest decision per cluster, as the reviewer's word. */
  private async latestDecisions(ids: string[]): Promise<Map<string, PlagClusterStatus>> {
    const out = new Map<string, PlagClusterStatus>();
    if (ids.length === 0) return out;
    const rows = await this.db
      .select({ clusterId: reviewDecisions.clusterId, decision: reviewDecisions.decision })
      .from(reviewDecisions)
      .where(inArray(reviewDecisions.clusterId, ids))
      .orderBy(asc(reviewDecisions.createdAt), asc(reviewDecisions.id));
    for (const r of rows) out.set(r.clusterId, FROM_DB[r.decision]);
    return out;
  }

  /** S17: one cluster with its members' code, the pairs, advisory signals and the decisions so far. */
  async cluster(id: string): Promise<PlagClusterDetail> {
    return tracer.startActiveSpan('plag.cluster', async (span) => {
      try {
        const [c] = await this.db
          .select({
            id: plagClusters.id,
            runId: plagClusters.runId,
            problemId: plagClusters.problemId,
            ids: plagClusters.submissionIds,
            maxScore: plagClusters.maxScore,
            slug: problems.slug,
            contestId: plagRuns.contestId,
          })
          .from(plagClusters)
          .innerJoin(problems, eq(problems.id, plagClusters.problemId))
          .innerJoin(plagRuns, eq(plagRuns.id, plagClusters.runId))
          .where(eq(plagClusters.id, id))
          .limit(1);
        if (!c) throw new ProblemError('not-found', 'No such cluster');
        const members = await this.db
          .select({
            submissionId: submissions.id,
            userId: submissions.userId,
            handle: users.handle,
            language: submissions.language,
            verdict: submissions.verdict,
            submittedAt: submissions.createdAt,
            source: submissions.source,
          })
          .from(submissions)
          .innerJoin(users, eq(users.id, submissions.userId))
          .where(inArray(submissions.id, c.ids))
          .orderBy(asc(submissions.createdAt), asc(submissions.id));
        const pairs = await this.db
          .select({
            subA: plagPairs.subA,
            subB: plagPairs.subB,
            fpScore: plagPairs.fpScore,
            embScore: plagPairs.embScore,
            combined: plagPairs.combined,
          })
          .from(plagPairs)
          .where(
            and(
              eq(plagPairs.runId, c.runId),
              inArray(plagPairs.subA, c.ids),
              inArray(plagPairs.subB, c.ids),
            ),
          )
          .orderBy(desc(plagPairs.combined), asc(plagPairs.subA), asc(plagPairs.subB));
        const signals = await this.memberSignals(c.contestId, c.problemId, members);
        const decisions = await this.db
          .select({
            id: reviewDecisions.id,
            decision: reviewDecisions.decision,
            note: reviewDecisions.note,
            reviewer: users.handle,
            createdAt: reviewDecisions.createdAt,
          })
          .from(reviewDecisions)
          .innerJoin(users, eq(users.id, reviewDecisions.reviewerId))
          .where(eq(reviewDecisions.clusterId, id))
          .orderBy(asc(reviewDecisions.createdAt), asc(reviewDecisions.id));
        const last = decisions[decisions.length - 1];
        const status: PlagClusterStatus = last ? FROM_DB[last.decision] : 'open';
        return {
          id: c.id,
          runId: c.runId,
          contestId: c.contestId,
          problemId: c.problemId,
          problemSlug: c.slug,
          maxScore: c.maxScore,
          status,
          members: members.map((m) => ({
            submissionId: m.submissionId,
            handle: m.handle ?? 'unknown',
            language: m.language,
            verdict: m.verdict,
            submittedAt: m.submittedAt.toISOString(),
            source: m.source,
          })),
          pairs,
          signals,
          decisions: decisions.map((d) => ({
            id: d.id,
            decision: FROM_DB[d.decision],
            note: d.note,
            reviewer: d.reviewer ?? 'unknown',
            createdAt: d.createdAt.toISOString(),
          })),
        };
      } finally {
        span.end();
      }
    });
  }

  /** IN-01: per member, what the browser reported plus two derived numbers. Advisory only. */
  private async memberSignals(
    contestId: string,
    problemId: string,
    members: {
      submissionId: string;
      userId: string;
      handle: string | null;
      language: string;
      source: string;
    }[],
  ): Promise<PlagClusterDetail['signals']> {
    const userIds = members.map((m) => m.userId);
    const [cp] = await this.db
      .select({ token: contestProblems.canaryToken })
      .from(contestProblems)
      .where(
        and(eq(contestProblems.contestId, contestId), eq(contestProblems.problemId, problemId)),
      )
      .limit(1);
    const canaryToken = cp?.token ?? null;
    const rows = await this.db
      .select({
        userId: editorSignals.userId,
        kind: editorSignals.kind,
        size: editorSignals.size,
        at: editorSignals.at,
      })
      .from(editorSignals)
      .where(
        and(
          eq(editorSignals.contestId, contestId),
          eq(editorSignals.problemId, problemId),
          inArray(editorSignals.userId, userIds),
        ),
      )
      .orderBy(asc(editorSignals.at))
      .limit(5000);
    const firstAc = await this.db.execute<{ user_id: string; at: Date | string }>(sql`
      select s.user_id, min(s.created_at) as at
      from submissions s join problem_versions pv on pv.id = s.problem_version_id
      where s.contest_id = ${contestId} and pv.problem_id = ${problemId} and s.verdict = 'AC'
        and s.user_id in (${sql.join(
          userIds.map((u) => sql`${u}`),
          sql`, `,
        )})
      group by s.user_id`);
    const acBy = new Map(
      (
        firstAc.rows ??
        (firstAc as unknown as { rows: { user_id: string; at: Date | string }[] }).rows
      ).map((r) => [r.user_id, new Date(r.at)]),
    );
    const out: PlagClusterDetail['signals'] = [];
    for (const m of members) {
      const mine = rows.filter((r) => r.userId === m.userId);
      const opened = mine.find((r) => r.kind === 'problem_open')?.at ?? null;
      // The person's own earlier programs in the same language, before this one, for the style comparison.
      const history = await this.db
        .select({ source: submissions.source })
        .from(submissions)
        .where(
          and(
            eq(submissions.userId, m.userId),
            eq(submissions.language, m.language as (typeof submissions.$inferSelect)['language']),
            sql`${submissions.id} <> ${m.submissionId}`,
            sql`${submissions.createdAt} < (select created_at from submissions where id = ${m.submissionId})`,
          ),
        )
        .orderBy(desc(submissions.createdAt))
        .limit(20);
      out.push({
        handle: m.handle ?? 'unknown',
        pastes: mine
          .filter((r) => r.kind === 'paste')
          .map((r) => ({ size: r.size ?? 0, at: r.at.toISOString() })),
        focusLosses: mine.filter((r) => r.kind === 'blur' || r.kind === 'tab_hidden').length,
        openedAt: opened ? opened.toISOString() : null,
        timeToAcMinutes: timeToAcMinutes(opened, acBy.get(m.userId) ?? null),
        styleShift: styleShift(
          m.source,
          history.map((h) => h.source),
        ),
        canary: containsCanary(m.source, canaryToken),
      });
    }
    return out;
  }

  /** FR-PLAG-05: a decision with a note, in the audit log; it changes nothing else (no automatic penalty). */
  async decide(actorId: string, id: string, body: PlagDecisionCreate): Promise<PlagClusterDetail> {
    return tracer.startActiveSpan('plag.decide', async (span) => {
      try {
        const [c] = await this.db
          .select({ id: plagClusters.id })
          .from(plagClusters)
          .where(eq(plagClusters.id, id))
          .limit(1);
        if (!c) throw new ProblemError('not-found', 'No such cluster');
        await this.db.transaction(async (tx) => {
          await tx.insert(reviewDecisions).values({
            clusterId: id,
            decision: TO_DB[body.decision],
            note: body.note,
            reviewerId: actorId,
          });
          await tx.insert(auditLog).values({
            actorId,
            action: 'plag.decision',
            targetType: 'plag_cluster',
            targetId: id,
            meta: { decision: body.decision },
          });
        });
        decisionsTotal.add(1, { decision: body.decision });
        return this.cluster(id);
      } finally {
        span.end();
      }
    });
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
