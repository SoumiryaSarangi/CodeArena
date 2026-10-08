import { Inject, Injectable, Optional } from '@nestjs/common';
import { JudgeResult, type SubmissionVerdictData } from '@codearena/contracts';
import { context, metrics, trace } from '@opentelemetry/api';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { DB, type Db } from '../../db/db.module';
import { customRuns, judgeRuns, submissions, testResults } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { contextFromTraceparent, traceKey } from '../../telemetry/trace-context';
import { publishEvent } from '../realtime/events';
import { QUEUE_KEY_PREFIX } from './queue.service';
import { BoardService } from '../board/board.service';
import { ValidationService } from './validation.service';

const tracer = trace.getTracer('api');
const processed = metrics.getMeter('api').createCounter('ca_results_processed_total', {
  description: 'Judge results handled, by outcome',
});

const verdicts = metrics.getMeter('api').createCounter('ca_verdicts_total', {
  description: 'Verdicts stored for submissions, by verdict and language',
});
const timeToVerdict = metrics.getMeter('api').createHistogram('ca_time_to_verdict_seconds', {
  unit: 's',
  description: 'From submission to stored verdict, by lane and language',
});

/** FR-SUB-06: only this much of a compile log is stored. */
export const MAX_COMPILE_LOG_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Outcome =
  /** First time this (submission, run version) was seen: stored, and the user was told. */
  | {
      kind: 'applied';
      event: SubmissionVerdictData;
      contest?: ContestRef;
      /** For the verdict metrics; absent for custom runs. */
      stats?: { lane: string; language: string; createdAt: Date };
    }
  /** Already stored (a replay, or another API instance won the race): nothing changed. */
  | { kind: 'duplicate' }
  /** An older run version than the submission's current one: kept as history only. */
  | { kind: 'stale' }
  /** A verdict for a setter's validation run (UI-04): stored on its item, nobody is notified. */
  | { kind: 'validation' }
  /** Not trustworthy or not ours: the consumer moves it to `results:dlq`. */
  | { kind: 'parked'; reason: ParkReason; detail: string };

/** A contest submission's board cell (C-02). */
interface ContestRef {
  contestId: string;
  userId: string;
  versionId: string;
}

export type ParkReason =
  'invalid-json' | 'invalid-result' | 'unknown-submission' | 'unknown-run-version';

export type { RealtimeMessage } from '../realtime/events';

const cutBytes = (s: string, max: number) => {
  const buf = Buffer.from(s, 'utf8');
  return buf.length <= max ? s : buf.subarray(0, max).toString('utf8');
};

@Injectable()
export class ResultsProcessor {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(LOGGER) private readonly log: Logger,
    /** Absent when the processor is built by hand (tests, the CLI): such results are parked as before. */
    @Optional() @Inject(ValidationService) private readonly validation?: ValidationService,
    /** Absent in hand-built processors: contest verdicts then do not reach a board. */
    @Optional() @Inject(BoardService) private readonly board?: BoardService,
  ) {}

  /**
   * Handles one entry of the `results` stream (FR-QUEUE-06). It is idempotent on
   * (submission id, run version): `judge_runs` has a unique constraint on that
   * pair and the insert is `ON CONFLICT DO NOTHING`, so the first call stores
   * everything in one transaction and every later call, from this or another API
   * instance, finds the row and changes nothing. A transient failure throws and
   * the caller retries; permanent problems are returned as `parked`.
   */
  async handle(raw: string): Promise<Outcome> {
    // The result carries no trace id: the one the job was enqueued under was kept at enqueue.
    const parent = await this.traceOf(raw);
    return tracer.startActiveSpan('queue.result', {}, parent, async (span) => {
      try {
        const outcome = await this.process(raw);
        processed.add(1, { outcome: outcome.kind });
        span.setAttribute('outcome', outcome.kind);
        return outcome;
      } catch (err) {
        processed.add(1, { outcome: 'error' });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async traceOf(raw: string) {
    try {
      const { submissionId, runVersion } = JSON.parse(raw) as {
        submissionId?: unknown;
        runVersion?: unknown;
      };
      if (typeof submissionId !== 'string' || typeof runVersion !== 'number') {
        return context.active();
      }
      return contextFromTraceparent(
        await this.redis.get(traceKey(this.prefix, submissionId, runVersion)),
      );
    } catch {
      return context.active();
    }
  }

  private async process(raw: string): Promise<Outcome> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { kind: 'parked', reason: 'invalid-json', detail: 'not JSON' };
    }
    const parsed = JudgeResult.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { kind: 'parked', reason: 'invalid-result', detail };
    }
    const r = parsed.data;
    if (!UUID.test(r.submissionId)) {
      return {
        kind: 'parked',
        reason: 'unknown-submission',
        detail: `${r.submissionId} is not an id we issue`,
      };
    }

    const outcome = await this.db.transaction(async (tx): Promise<Outcome> => {
      const [sub] = await tx
        .select({
          currentRunVersion: submissions.currentRunVersion,
          contestId: submissions.contestId,
          userId: submissions.userId,
          versionId: submissions.problemVersionId,
          lane: submissions.lane,
          language: submissions.language,
          createdAt: submissions.createdAt,
        })
        .from(submissions)
        .where(eq(submissions.id, r.submissionId))
        .limit(1);

      if (!sub) return this.customRun(tx, r);

      // SD-§16.1: a result for a run version we never started cannot come from a healthy judge.
      if (r.runVersion > sub.currentRunVersion) {
        return {
          kind: 'parked',
          reason: 'unknown-run-version',
          detail: `run version ${r.runVersion} but the submission is at ${sub.currentRunVersion}`,
        };
      }

      const journey = await this.journey(r.submissionId, r.runVersion);
      const inserted = await tx
        .insert(judgeRuns)
        .values({
          submissionId: r.submissionId,
          runVersion: r.runVersion,
          reason: r.runVersion === 1 ? 'initial' : 'rejudge',
          workerId: r.workerId,
          finishedAt: new Date(r.finishedAt),
          verdict: r.verdict,
          timeMs: r.timeMs,
          memKb: r.memKb,
          compileLog:
            r.compileLog === undefined ? null : cutBytes(r.compileLog, MAX_COMPILE_LOG_BYTES),
          journey,
        })
        .onConflictDoNothing({ target: [judgeRuns.submissionId, judgeRuns.runVersion] })
        .returning({ id: judgeRuns.id });
      if (inserted.length === 0) return { kind: 'duplicate' };

      if (r.tests.length > 0) {
        await tx.insert(testResults).values(
          r.tests.map((t) => ({
            judgeRunId: inserted[0]!.id,
            testNo: t.no,
            verdict: t.verdict,
            timeMs: t.timeMs,
            memKb: t.memKb,
            checkerMsg: t.checkerMsg ?? null,
          })),
        );
      }

      // Only the submission's current run version may set its summary; the guard in the
      // WHERE also covers a rejudge bumping the version while this transaction runs.
      const failedTest = r.tests.find((t) => t.verdict !== 'AC')?.no ?? null;
      const status = r.verdict === 'SE' ? 'failed' : 'done';
      const updated = await tx
        .update(submissions)
        .set({
          status,
          verdict: r.verdict,
          timeMs: r.timeMs,
          memKb: r.memKb,
          failedTest,
          judgedAt: new Date(r.finishedAt),
        })
        .where(
          and(eq(submissions.id, r.submissionId), eq(submissions.currentRunVersion, r.runVersion)),
        )
        .returning({ id: submissions.id });
      if (updated.length === 0) return { kind: 'stale' };

      return {
        kind: 'applied',
        event: {
          submissionId: r.submissionId,
          runVersion: r.runVersion,
          status,
          verdict: r.verdict,
          timeMs: r.timeMs,
          memKb: r.memKb,
          failedTest,
        },
        stats: { lane: sub.lane, language: sub.language, createdAt: sub.createdAt },
        ...(sub.contestId
          ? { contest: { contestId: sub.contestId, userId: sub.userId, versionId: sub.versionId } }
          : {}),
      };
    });

    if (outcome.kind === 'applied') {
      if (outcome.stats) {
        verdicts.add(1, { verdict: outcome.event.verdict, language: outcome.stats.language });
        timeToVerdict.record((Date.now() - outcome.stats.createdAt.getTime()) / 1000, {
          lane: outcome.stats.lane,
          language: outcome.stats.language,
        });
      }
      await this.publish(outcome.event);
      // After the commit, so the board reads the stored verdict (C-02). Never throws.
      if (outcome.contest) {
        const { contestId, userId, versionId } = outcome.contest;
        await this.board?.update(contestId, userId, versionId);
      }
    }
    return outcome;
  }

  /**
   * When each phase of this run began (US-3.3), read from the replay buffer the progress bridge
   * fills while the judge works. The progress events are only kept for minutes, so the verdict is
   * the moment to keep them. Missing events (bridge off, Redis down) give a partial timeline, never
   * a failure: the verdict matters more than its history.
   */
  private async journey(
    submissionId: string,
    runVersion: number,
  ): Promise<{ steps: { phase: string; at: number }[] } | null> {
    try {
      const entries = await this.redis.xrange(
        `${this.prefix}evt:sub:${submissionId}`,
        '-',
        '+',
        'COUNT',
        500,
      );
      const first = new Map<string, number>();
      for (const [, fields] of entries) {
        const env = JSON.parse(fields[1]!) as {
          type?: string;
          data?: { phase?: string; ts?: number; runVersion?: number };
        };
        if (env.type !== 'submission.progress') continue;
        const { phase, ts, runVersion: v } = env.data ?? {};
        if (v !== runVersion || !phase || typeof ts !== 'number') continue;
        if (!first.has(phase) || ts < first.get(phase)!) first.set(phase, ts);
      }
      if (first.size === 0) return null;
      const order = ['claimed', 'compiling', 'running', 'done'];
      return {
        steps: order.filter((p) => first.has(p)).map((p) => ({ phase: p, at: first.get(p)! })),
      };
    } catch {
      return null;
    }
  }

  /** Results for `POST /api/runs` jobs carry the custom run's id (JudgeJob contract). */
  private async customRun(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    r: JudgeResult,
  ): Promise<Outcome> {
    const [run] = await tx
      .select({ id: customRuns.id })
      .from(customRuns)
      .where(eq(customRuns.id, r.submissionId))
      .limit(1);
    if (!run) {
      // Not a custom run either: it may be an item of a setter's validation run (UI-04).
      const validated = await this.validation?.complete(tx, r);
      if (validated)
        return validated === 'applied' ? { kind: 'validation' } : { kind: 'duplicate' };
      return {
        kind: 'parked',
        reason: 'unknown-submission',
        detail: `no submission, custom run or validation item ${r.submissionId}`,
      };
    }
    const failedTest = r.tests.find((t) => t.verdict !== 'AC')?.no ?? null;
    const status = r.verdict === 'SE' ? 'failed' : 'done';
    // Only a run that is still waiting can be completed: a replay finds it done and changes nothing.
    const updated = await tx
      .update(customRuns)
      .set({
        status,
        result: {
          verdict: r.verdict,
          timeMs: r.timeMs,
          memKb: r.memKb,
          tests: r.tests,
          output: r.output ?? null,
          stderr: r.stderr ?? null,
          compileLog:
            r.compileLog === undefined ? null : cutBytes(r.compileLog, MAX_COMPILE_LOG_BYTES),
          workerId: r.workerId,
          finishedAt: r.finishedAt,
        },
      })
      .where(
        and(eq(customRuns.id, r.submissionId), inArray(customRuns.status, ['queued', 'running'])),
      )
      .returning({ id: customRuns.id });
    if (updated.length === 0) return { kind: 'duplicate' };
    return {
      kind: 'applied',
      event: {
        submissionId: r.submissionId,
        runVersion: r.runVersion,
        status,
        verdict: r.verdict,
        timeMs: r.timeMs,
        memKb: r.memKb,
        failedTest,
      },
    };
  }

  /**
   * Tells the user (SD-§10): see `publishEvent`. Runs after the commit and only for the call that
   * stored the verdict, so replays are silent.
   */
  private async publish(data: SubmissionVerdictData): Promise<void> {
    await publishEvent(
      this.redis,
      this.prefix,
      this.log,
      `sub:${data.submissionId}`,
      'submission.verdict',
      data,
    );
  }
}
