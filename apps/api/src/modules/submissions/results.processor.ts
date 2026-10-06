import { Inject, Injectable } from '@nestjs/common';
import { JudgeResult, type SubmissionVerdictData, type SseEventType } from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { DB, type Db } from '../../db/db.module';
import { customRuns, judgeRuns, submissions, testResults } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { QUEUE_KEY_PREFIX } from './queue.service';

const tracer = trace.getTracer('api');
const processed = metrics.getMeter('api').createCounter('ca_results_processed_total', {
  description: 'Judge results handled, by outcome',
});

/** FR-SUB-06: only this much of a compile log is stored. */
export const MAX_COMPILE_LOG_BYTES = 16 * 1024;
/** SD-§7: replay buffer sizes for `evt:{topic}`. */
const EVT_MAXLEN = 2000;
const EVT_IDLE_TTL_S = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Outcome =
  /** First time this (submission, run version) was seen: stored, and the user was told. */
  | { kind: 'applied'; event: SubmissionVerdictData }
  /** Already stored (a replay, or another API instance won the race): nothing changed. */
  | { kind: 'duplicate' }
  /** An older run version than the submission's current one: kept as history only. */
  | { kind: 'stale' }
  /** Not trustworthy or not ours: the consumer moves it to `results:dlq`. */
  | { kind: 'parked'; reason: ParkReason; detail: string };

export type ParkReason =
  'invalid-json' | 'invalid-result' | 'unknown-submission' | 'unknown-run-version';

/** What goes on the `rt:{topic}` channel: the replay stream id (the SSE `id:`) plus the envelope. */
export interface RealtimeMessage {
  id: string;
  envelope: { topic: string; type: SseEventType; ts: number; data: SubmissionVerdictData };
}

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
    return tracer.startActiveSpan('results.handle', async (span) => {
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
        .select({ currentRunVersion: submissions.currentRunVersion })
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
      };
    });

    if (outcome.kind === 'applied') await this.publish(outcome.event);
    return outcome;
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
      return {
        kind: 'parked',
        reason: 'unknown-submission',
        detail: `no submission or custom run ${r.submissionId}`,
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
   * Tells the user (SD-§10): append to the replay buffer, then fan out. Runs after
   * the commit and only for the call that stored the verdict, so replays are silent.
   * If Redis is down the event is lost but the verdict is safe in Postgres; a client
   * that reconnects reads the submission itself.
   */
  private async publish(data: SubmissionVerdictData): Promise<void> {
    const topic = `sub:${data.submissionId}`;
    const evtKey = `${this.prefix}evt:${topic}`;
    const envelope: RealtimeMessage['envelope'] = {
      topic,
      type: 'submission.verdict',
      ts: Date.now(),
      data,
    };
    const body = JSON.stringify(envelope);
    try {
      const id = (await this.redis.xadd(
        evtKey,
        'MAXLEN',
        '~',
        EVT_MAXLEN,
        '*',
        'event',
        body,
      )) as string;
      await this.redis.expire(evtKey, EVT_IDLE_TTL_S);
      const message: RealtimeMessage = { id, envelope };
      await this.redis.publish(`${this.prefix}rt:${topic}`, JSON.stringify(message));
    } catch (err) {
      this.log.warn(
        { err: { message: (err as Error).message }, topic },
        'could not publish the verdict event',
      );
    }
  }
}
