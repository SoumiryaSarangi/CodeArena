import { Inject, Injectable } from '@nestjs/common';
import {
  Language,
  type CreateRun,
  type CreateSubmission,
  type QueuePosition,
  type RunCreated,
  type RunResult,
  type SubmissionCreated,
  type SubmissionDetail,
  type SubmissionList,
  type SubmissionListQuery,
} from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, desc, eq, lt, type SQL } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import {
  contestProblems,
  contests,
  customRuns,
  judgeRuns,
  participants,
  problemVersions,
  problems,
  submissions,
  testResults,
} from '../../db/schema';
import { contestMinute, contestState } from '../contests/state';
import { practiceVisible } from '../problems/practice';
import { buildJob } from './job-builder';
import { QueuePositionService } from './queue-position.service';
import { QueueService } from './queue.service';

const tracer = trace.getTracer('api');
const submitted = metrics.getMeter('api').createCounter('ca_submissions_created_total', {
  description: 'Submissions accepted, by lane',
});
const runsCreated = metrics.getMeter('api').createCounter('ca_runs_created_total', {
  description: 'Custom runs accepted',
});

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Token-by-token comparison, the way the `tokens` checker would compare a sample. */
const sameTokens = (a: string, b: string) =>
  a.trim().split(/\s+/).join(' ') === b.trim().split(/\s+/).join(' ');

const PHASES = ['claimed', 'compiling', 'running', 'done'] as const;

/** The stored `{steps:[{phase, at}]}` as ISO times, ignoring anything that does not look right. */
function journeySteps(raw: unknown): SubmissionDetail['journey']['steps'] {
  const steps = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s: { phase?: unknown; at?: unknown }) =>
    PHASES.includes(s.phase as never) && typeof s.at === 'number'
      ? [{ phase: s.phase as (typeof PHASES)[number], at: new Date(s.at).toISOString() }]
      : [],
  );
}

export interface Actor {
  id: string;
  role: 'user' | 'setter' | 'admin';
}

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(QueuePositionService) private readonly positions: QueuePositionService,
  ) {}

  private checkLanguage(language: string) {
    const parsed = Language.safeParse(language);
    if (!parsed.success) {
      throw new ProblemError('unsupported-language', `${language} is not an enabled language`);
    }
    return parsed.data;
  }

  private checkSize(source: string, input?: string) {
    if (bytes(source) > MAX_SOURCE_BYTES) {
      throw new ProblemError('payload-too-large', 'Source is larger than 64 KB');
    }
    if (input !== undefined && bytes(input) > MAX_INPUT_BYTES) {
      throw new ProblemError('payload-too-large', 'Input is larger than 1 MB');
    }
  }

  /** A problem practice may show, at its current version. 404 for anything else (FR-PROB-09). */
  private async version(slug: string) {
    const [row] = await this.db
      .select(this.versionColumns)
      .from(problems)
      .innerJoin(problemVersions, eq(problemVersions.id, problems.currentVersionId))
      .where(and(eq(problems.slug, slug), practiceVisible))
      .limit(1);
    if (!row || !row.testsetHash) throw new ProblemError('not-found', 'No such problem');
    return row;
  }

  private readonly versionColumns = {
    problemId: problems.id,
    title: problems.title,
    id: problemVersions.id,
    testsetHash: problemVersions.testsetHash,
    testsetUri: problemVersions.testsetUri,
    limits: problemVersions.limits,
    checker: problemVersions.checker,
    samples: problemVersions.samples,
  };

  /**
   * FR-SUB-03/08: where a submission goes. A contest problem (`contestSlug` + `label`) judges the
   * version the contest pinned: before start → `contest-not-started`; while running → the
   * `contest` lane, stamped with the contest minute and the freeze flag; after the end → accepted
   * as practice (no contest id, so it never touches the board).
   */
  private async target(userId: string, body: CreateSubmission) {
    if (body.contestSlug === undefined) {
      return { version: await this.version(body.problemSlug!), lane: 'practice' as const };
    }
    const [c] = await this.db
      .select({
        id: contests.id,
        status: contests.status,
        startsAt: contests.startsAt,
        endsAt: contests.endsAt,
        freezeAt: contests.freezeAt,
      })
      .from(contests)
      .where(eq(contests.slug, body.contestSlug))
      .limit(1);
    // A draft does not exist for contestants.
    if (!c || c.status === 'draft') throw new ProblemError('not-found', 'No such contest');
    const now = new Date();
    const state = contestState(c, now);
    const [row] = await this.db
      .select(this.versionColumns)
      .from(contestProblems)
      .innerJoin(problems, eq(problems.id, contestProblems.problemId))
      .innerJoin(problemVersions, eq(problemVersions.id, contestProblems.versionId))
      .where(and(eq(contestProblems.contestId, c.id), eq(contestProblems.label, body.label!)))
      .limit(1);
    if (!row || !row.testsetHash) throw new ProblemError('not-found', 'No such problem');
    if (state === 'scheduled') {
      throw new ProblemError('contest-not-started', 'The contest has not started yet');
    }
    if (state === 'ended' || state === 'finalized') {
      return { version: row, lane: 'practice' as const };
    }
    const [reg] = await this.db
      .select({ userId: participants.userId })
      .from(participants)
      .where(and(eq(participants.contestId, c.id), eq(participants.userId, userId)))
      .limit(1);
    if (!reg) throw new ProblemError('forbidden', 'Register for the contest to submit');
    return {
      version: row,
      lane: 'contest' as const,
      contestId: c.id,
      contestMinute: contestMinute(c.startsAt, now),
      afterFreeze: c.freezeAt !== null && now >= c.freezeAt,
    };
  }

  /** FR-SUB-01/02/03: persist, enqueue, then answer with the queue position and ETA. */
  async submit(userId: string, body: CreateSubmission): Promise<SubmissionCreated> {
    return tracer.startActiveSpan('submissions.create', async (span) => {
      try {
        const language = this.checkLanguage(body.language);
        this.checkSize(body.source);
        const target = await this.target(userId, body);
        const { version, lane } = target;
        const [sub] = await this.db
          .insert(submissions)
          .values({
            userId,
            problemVersionId: version.id,
            language,
            source: body.source,
            sourceBytes: bytes(body.source),
            lane,
            ...('contestId' in target
              ? {
                  contestId: target.contestId,
                  contestMinute: target.contestMinute,
                  afterFreeze: target.afterFreeze,
                }
              : {}),
          })
          .returning({ id: submissions.id });
        const id = sub!.id;
        span.setAttribute('submission.id', id);
        try {
          const job = buildJob({ id, language, source: body.source, lane }, version, 'submit');
          const queued = await this.queue.enqueue(job);
          await this.positions.remember(id, lane, queued.entryId);
        } catch (err) {
          // Nothing was queued: don't leave a submission that will never be judged looking alive.
          await this.db.update(submissions).set({ status: 'failed' }).where(eq(submissions.id, id));
          throw err instanceof ProblemError
            ? err
            : new ProblemError('internal', 'Could not queue the submission; please submit again');
        }
        submitted.add(1, { lane });
        const pos = await this.positions.of(id, lane);
        return { id, lane, position: pos.position, etaSeconds: pos.etaSeconds };
      } finally {
        span.end();
      }
    });
  }

  /** FR-SUB-05: runs on sample inputs or the user's own input; never touches scores. */
  async run(userId: string, body: CreateRun): Promise<RunCreated> {
    return tracer.startActiveSpan('runs.create', async (span) => {
      try {
        const language = this.checkLanguage(body.language);
        this.checkSize(body.source, body.input);
        const version = await this.version(body.problemSlug);
        const samples = version.samples as { in: string; out: string }[];
        let inputs: string[];
        if (body.sampleIds) {
          const bad = body.sampleIds.filter((n) => n > samples.length);
          if (bad.length > 0) {
            throw new ProblemError('validation', `This problem has ${samples.length} samples`, {
              errors: [{ path: 'sampleIds', message: `no sample ${bad.join(', ')}` }],
            });
          }
          inputs = [...new Set(body.sampleIds)].map((n) => samples[n - 1]!.in);
        } else {
          inputs = [body.input!];
        }
        const lane = 'practice' as const;
        const runIds: string[] = [];
        for (const input of inputs) {
          const [run] = await this.db
            .insert(customRuns)
            .values({
              userId,
              problemVersionId: version.id,
              language,
              source: body.source,
              input,
            })
            .returning({ id: customRuns.id });
          const id = run!.id;
          try {
            await this.queue.enqueue(
              buildJob(
                { id, language, source: body.source, lane, customInput: input },
                version,
                'run',
              ),
            );
          } catch {
            await this.db.update(customRuns).set({ status: 'failed' }).where(eq(customRuns.id, id));
            throw new ProblemError('internal', 'Could not queue the run; please try again');
          }
          runIds.push(id);
        }
        runsCreated.add(runIds.length);
        span.setAttribute('runs', runIds.length);
        return { runId: runIds[0]!, runIds };
      } finally {
        span.end();
      }
    });
  }

  async runResult(userId: string, id: string): Promise<RunResult> {
    const [run] = await this.db
      .select({
        id: customRuns.id,
        userId: customRuns.userId,
        status: customRuns.status,
        result: customRuns.result,
        input: customRuns.input,
        samples: problemVersions.samples,
      })
      .from(customRuns)
      .leftJoin(problemVersions, eq(problemVersions.id, customRuns.problemVersionId))
      .where(eq(customRuns.id, id))
      .limit(1);
    // Someone else's run looks exactly like no run (SRS: not-found).
    if (!run || run.userId !== userId) throw new ProblemError('not-found', 'No such run');
    const r = (run.result ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
    const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
    const output = str('output');
    const sample = ((run.samples ?? []) as { in: string; out: string }[]).find(
      (s) => s.in === run.input,
    );
    return {
      id: run.id,
      status: run.status,
      verdict: (str('verdict') as RunResult['verdict']) ?? null,
      timeMs: num('timeMs'),
      memKb: num('memKb'),
      output,
      stderr: str('stderr'),
      compileLog: str('compileLog'),
      expected: sample?.out ?? null,
      matches: sample && output !== null ? sameTokens(output, sample.out) : null,
    };
  }

  /** FR-SUB-07: own submissions, newest first; an admin may name another user. */
  async list(actor: Actor, q: SubmissionListQuery): Promise<SubmissionList> {
    if (q.user && q.user !== actor.id && actor.role !== 'admin') {
      throw new ProblemError('forbidden', 'Only an admin can list another user’s submissions');
    }
    const where: SQL[] = [eq(submissions.userId, q.user ?? actor.id)];
    if (q.problem) where.push(eq(problems.slug, q.problem));
    if (q.verdict) where.push(eq(submissions.verdict, q.verdict));
    if (q.language) where.push(eq(submissions.language, q.language));
    if (q.cursor) where.push(lt(submissions.id, q.cursor));
    const rows = await this.db
      .select({
        id: submissions.id,
        problemSlug: problems.slug,
        problemTitle: problems.title,
        language: submissions.language,
        status: submissions.status,
        verdict: submissions.verdict,
        timeMs: submissions.timeMs,
        memKb: submissions.memKb,
        failedTest: submissions.failedTest,
        lane: submissions.lane,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .innerJoin(problemVersions, eq(problemVersions.id, submissions.problemVersionId))
      .innerJoin(problems, eq(problems.id, problemVersions.problemId))
      .where(and(...where))
      .orderBy(desc(submissions.id))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit);
    return {
      items: items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      nextCursor: rows.length > q.limit ? items.at(-1)!.id : null,
    };
  }

  private async owned(actor: Actor, id: string) {
    const [sub] = await this.db
      .select({
        id: submissions.id,
        userId: submissions.userId,
        problemSlug: problems.slug,
        problemTitle: problems.title,
        problemVersion: problemVersions.version,
        samples: problemVersions.samples,
        language: submissions.language,
        source: submissions.source,
        status: submissions.status,
        verdict: submissions.verdict,
        timeMs: submissions.timeMs,
        memKb: submissions.memKb,
        failedTest: submissions.failedTest,
        lane: submissions.lane,
        runVersion: submissions.currentRunVersion,
        createdAt: submissions.createdAt,
        judgedAt: submissions.judgedAt,
      })
      .from(submissions)
      .innerJoin(problemVersions, eq(problemVersions.id, submissions.problemVersionId))
      .innerJoin(problems, eq(problems.id, problemVersions.problemId))
      .where(eq(submissions.id, id))
      .limit(1);
    if (!sub) throw new ProblemError('not-found', 'No such submission');
    // Someone else's submission looks exactly like no submission (SRS error catalogue: not-found
    // also hides existence; UI_UX S06).
    if (sub.userId !== actor.id && actor.role !== 'admin') {
      throw new ProblemError('not-found', 'No such submission');
    }
    return sub;
  }

  /** FR-SUB-06: per-test verdicts without test contents, first failing test, compile log, journey. */
  async detail(actor: Actor, id: string): Promise<SubmissionDetail> {
    const sub = await this.owned(actor, id);
    const [run] = await this.db
      .select()
      .from(judgeRuns)
      .where(and(eq(judgeRuns.submissionId, id), eq(judgeRuns.runVersion, sub.runVersion)))
      .limit(1);
    const tests = run
      ? await this.db
          .select()
          .from(testResults)
          .where(eq(testResults.judgeRunId, run.id))
          .orderBy(asc(testResults.testNo))
      : [];
    const sampleCount = (sub.samples as unknown[]).length;
    return {
      id: sub.id,
      problemSlug: sub.problemSlug,
      problemTitle: sub.problemTitle,
      language: sub.language,
      status: sub.status,
      verdict: sub.verdict,
      timeMs: sub.timeMs,
      memKb: sub.memKb,
      failedTest: sub.failedTest,
      lane: sub.lane,
      createdAt: sub.createdAt.toISOString(),
      source: sub.source,
      problemVersion: sub.problemVersion,
      runVersion: sub.runVersion,
      tests: tests.map((t) => ({
        no: t.testNo,
        verdict: t.verdict,
        timeMs: t.timeMs,
        memKb: t.memKb,
        // A checker message can quote the expected answer; only the public samples may show it.
        checkerMsg: t.testNo <= sampleCount ? (t.checkerMsg ?? null) : null,
      })),
      compileLog: sub.verdict === 'CE' ? (run?.compileLog ?? null) : null,
      journey: {
        submittedAt: sub.createdAt.toISOString(),
        judgedAt: sub.judgedAt?.toISOString() ?? null,
        workerId: run?.workerId ?? null,
        steps: journeySteps(run?.journey),
      },
      ...(actor.role === 'admin' ? { runs: await this.runsOf(id) } : {}),
    };
  }

  private async runsOf(id: string): Promise<NonNullable<SubmissionDetail['runs']>> {
    const rows = await this.db
      .select({
        runVersion: judgeRuns.runVersion,
        reason: judgeRuns.reason,
        workerId: judgeRuns.workerId,
        verdict: judgeRuns.verdict,
        finishedAt: judgeRuns.finishedAt,
      })
      .from(judgeRuns)
      .where(eq(judgeRuns.submissionId, id))
      .orderBy(asc(judgeRuns.runVersion));
    return rows.map((r) => ({ ...r, finishedAt: r.finishedAt?.toISOString() ?? null }));
  }

  async position(actor: Actor, id: string): Promise<QueuePosition> {
    const sub = await this.owned(actor, id);
    if (sub.status === 'done' || sub.status === 'failed') {
      return { lane: sub.lane, position: 0, etaSeconds: 0, capped: false };
    }
    return this.positions.of(id, sub.lane);
  }
}
