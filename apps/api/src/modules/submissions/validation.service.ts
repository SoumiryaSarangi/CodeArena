import type { S3Client } from '@aws-sdk/client-s3';
import {
  type JudgeResult,
  type ValidationItem,
  type ValidationRun,
  type Verdict,
} from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { uuidv7 } from '../../db/uuid';
import {
  packageSolutions,
  problemVersions,
  problems,
  validationItems,
  validationRuns,
} from '../../db/schema';
import { S3 } from '../../s3/s3.module';
import { assertCanManage } from '../problems/access';
import { ObjectError, readObject } from '../problems/objects';
import type { AuthUser } from '../auth/guards';
import { buildJob } from './job-builder';
import { QueueService } from './queue.service';

const tracer = trace.getTracer('api');
const meter = metrics.getMeter('api');
const runsStarted = meter.createCounter('ca_validation_runs_total', {
  description: 'Validation runs, by outcome (started, passed, failed, timed-out)',
});

/** The judge's source limit (JudgeJob contract). */
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_COMPILE_LOG_BYTES = 16 * 1024;
/** A run whose judge never answered is given up on when it is next read. */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FAILED_TESTS = 20;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Row = typeof validationItems.$inferSelect;

interface ItemResult {
  verdict?: Verdict;
  timeMs?: number;
  memKb?: number;
  tests?: { no: number; verdict: Verdict; checkerMsg?: string }[];
  compileLog?: string;
  workerId?: string;
  message?: string;
}

const cutBytes = (s: string, max: number) => {
  const buf = Buffer.from(s, 'utf8');
  return buf.length <= max ? s : buf.subarray(0, max).toString('utf8');
};

/**
 * Validation runs (UI-04, FR-PROB-04): a package's solutions and its validator are judged by the
 * real judge, so a setter sees expected vs actual for each. Every item is an ordinary judge job on
 * the `rejudge` lane whose `submissionId` is the item's id; the verdict comes back on the normal
 * results stream and `ResultsProcessor` hands it here (`complete`). Nothing about this needs the
 * judge to read more than it already may, and no judge ever sees a database.
 */
@Injectable()
export class ValidationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(QueueService) private readonly queue: QueueService,
  ) {}

  async start(versionId: string, user: Pick<AuthUser, 'id' | 'role'>): Promise<ValidationRun> {
    return tracer.startActiveSpan('validation.start', async (span) => {
      try {
        span.setAttribute('problem.version.id', versionId);
        const run = await this.begin(versionId, user);
        runsStarted.add(1, { outcome: 'started' });
        return run;
      } catch (err) {
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async begin(
    versionId: string,
    user: Pick<AuthUser, 'id' | 'role'>,
  ): Promise<ValidationRun> {
    const [version] = await this.db
      .select()
      .from(problemVersions)
      .where(eq(problemVersions.id, isUuid(versionId) ? versionId : NIL_UUID))
      .limit(1);
    if (!version) throw new ProblemError('not-found');
    const [problem] = await this.db
      .select({ authorId: problems.authorId })
      .from(problems)
      .where(eq(problems.id, version.problemId))
      .limit(1);
    assertCanManage(user, problem?.authorId ?? null);
    if (!version.testsetUri || !version.testsetHash) {
      throw new ProblemError('invalid-package', 'This version has no tests to validate against');
    }
    if (!version.validatorUri) {
      throw new ProblemError(
        'invalid-package',
        'This version was imported before validators were stored. Upload the package again to validate it.',
      );
    }
    const [active] = await this.db
      .select({ id: validationRuns.id })
      .from(validationRuns)
      .where(
        and(
          eq(validationRuns.versionId, version.id),
          inArray(validationRuns.status, ['queued', 'running']),
          gt(validationRuns.createdAt, new Date(Date.now() - RUN_TIMEOUT_MS)),
        ),
      )
      .limit(1);
    if (active) {
      throw new ProblemError('validation', 'A validation run is already in progress', {
        errors: [{ path: 'versionId', message: 'a run for this version is still in progress' }],
      });
    }

    // Read every source first: an object that cannot be read fails its own item, not the run.
    const solutions = await this.db
      .select()
      .from(packageSolutions)
      .where(eq(packageSolutions.versionId, version.id))
      .orderBy(asc(packageSolutions.name));
    type Plan = {
      id: string;
      kind: 'solution' | 'validator';
      name: string;
      language: string;
      expected: Verdict;
      source?: string;
      error?: string;
    };
    const plan: Plan[] = [];
    const load = async (
      uri: string,
      prefix: string,
    ): Promise<{ source?: string; error?: string }> => {
      try {
        const body = await readObject(this.s3, this.config, uri, prefix, MAX_SOURCE_BYTES);
        return { source: body.toString('utf8') };
      } catch (err) {
        return {
          error:
            err instanceof ObjectError
              ? `source is not usable: ${err.message}`
              : 'source could not be read from storage',
        };
      }
    };
    for (const s of solutions) {
      plan.push({
        id: uuidv7(),
        kind: 'solution',
        name: s.name,
        language: s.language,
        expected: s.expectedVerdict,
        ...(await load(s.sourceUri, 'solutions/')),
      });
    }
    plan.push({
      id: uuidv7(),
      kind: 'validator',
      name: 'validator.cpp',
      language: 'cpp17',
      expected: 'AC',
      ...(await load(version.validatorUri, 'validators/')),
    });

    const runId = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(validationRuns)
        .values({ id: runId, versionId: version.id, status: 'running' });
      await tx.insert(validationItems).values(
        plan.map((p) => ({
          id: p.id,
          runId,
          kind: p.kind,
          name: p.name,
          language: p.language,
          expectedVerdict: p.expected,
          status: p.error ? ('failed' as const) : ('queued' as const),
          result: p.error ? ({ message: p.error } satisfies ItemResult) : null,
          finishedAt: p.error ? new Date() : null,
        })),
      );
      await tx
        .update(problemVersions)
        .set({ validationStatus: 'running' })
        .where(eq(problemVersions.id, version.id));
    });

    for (const p of plan) {
      if (p.error || p.source === undefined) continue;
      try {
        await this.queue.enqueue(
          buildJob(
            { id: p.id, language: p.language, source: p.source, lane: 'rejudge' },
            version,
            p.kind === 'validator' ? 'validate' : 'submit',
          ),
        );
      } catch {
        await this.db
          .update(validationItems)
          .set({
            status: 'failed',
            finishedAt: new Date(),
            result: { message: 'could not be queued for a judge' } satisfies ItemResult,
          })
          .where(and(eq(validationItems.id, p.id), eq(validationItems.status, 'queued')));
      }
    }
    // Everything may already be over (all sources unreadable, all enqueues refused).
    await this.db.transaction((tx) => this.finalize(tx, runId));
    return this.read(runId);
  }

  async get(runId: string, user: Pick<AuthUser, 'id' | 'role'>): Promise<ValidationRun> {
    if (!isUuid(runId)) throw new ProblemError('not-found');
    const [run] = await this.db
      .select({ versionId: validationRuns.versionId })
      .from(validationRuns)
      .where(eq(validationRuns.id, runId))
      .limit(1);
    if (!run) throw new ProblemError('not-found');
    const [owner] = await this.db
      .select({ authorId: problems.authorId })
      .from(problemVersions)
      .innerJoin(problems, eq(problems.id, problemVersions.problemId))
      .where(eq(problemVersions.id, run.versionId))
      .limit(1);
    assertCanManage(user, owner?.authorId ?? null);
    await this.expire(runId);
    return this.read(runId);
  }

  /**
   * Called by `ResultsProcessor` inside its transaction for a result whose id is not a submission
   * or a custom run. Returns null when the id is not a validation item either (the caller parks
   * it), `duplicate` for a replay, `applied` the first time. A replay changes nothing.
   */
  async complete(tx: Tx, r: JudgeResult): Promise<'applied' | 'duplicate' | null> {
    const [item] = await tx
      .select({
        id: validationItems.id,
        status: validationItems.status,
        runId: validationItems.runId,
      })
      .from(validationItems)
      .where(eq(validationItems.id, r.submissionId))
      .limit(1);
    if (!item) return null;
    if (item.status !== 'queued') return 'duplicate';
    const result: ItemResult = {
      verdict: r.verdict,
      timeMs: r.timeMs,
      memKb: r.memKb,
      tests: r.tests.slice(0, 200).map((t) => ({
        no: t.no,
        verdict: t.verdict,
        ...(t.checkerMsg === undefined ? {} : { checkerMsg: t.checkerMsg }),
      })),
      workerId: r.workerId,
      ...(r.compileLog === undefined
        ? {}
        : { compileLog: cutBytes(r.compileLog, MAX_COMPILE_LOG_BYTES) }),
    };
    const updated = await tx
      .update(validationItems)
      .set({ status: 'done', result, finishedAt: new Date(r.finishedAt) })
      .where(and(eq(validationItems.id, item.id), eq(validationItems.status, 'queued')))
      .returning({ id: validationItems.id });
    if (updated.length === 0) return 'duplicate';
    await this.finalize(tx, item.runId);
    return 'applied';
  }

  /** When no item is waiting any more, the run is over and the version's status follows. */
  private async finalize(tx: Tx, runId: string): Promise<void> {
    const items = await tx.select().from(validationItems).where(eq(validationItems.runId, runId));
    if (items.some((i) => i.status === 'queued' || i.status === 'running')) return;
    const ok = items.every(itemOk);
    const [run] = await tx
      .update(validationRuns)
      .set({ status: 'done', finishedAt: new Date(), results: { ok } })
      .where(
        and(eq(validationRuns.id, runId), inArray(validationRuns.status, ['queued', 'running'])),
      )
      .returning({ versionId: validationRuns.versionId });
    if (!run) return;
    await tx
      .update(problemVersions)
      .set({ validationStatus: ok ? 'passed' : 'failed', validatedAt: new Date() })
      .where(eq(problemVersions.id, run.versionId));
    runsStarted.add(1, { outcome: ok ? 'passed' : 'failed' });
  }

  /** A judge that never answered must not leave a run "running" for ever. */
  private async expire(runId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(validationRuns)
        .where(eq(validationRuns.id, runId))
        .limit(1);
      if (
        !run ||
        (run.status !== 'queued' && run.status !== 'running') ||
        run.createdAt.getTime() > Date.now() - RUN_TIMEOUT_MS
      ) {
        return;
      }
      await tx
        .update(validationItems)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          result: { message: 'the judge did not answer within 10 minutes' } satisfies ItemResult,
        })
        .where(
          and(
            eq(validationItems.runId, runId),
            inArray(validationItems.status, ['queued', 'running']),
            lt(validationItems.createdAt, new Date(Date.now() - RUN_TIMEOUT_MS)),
          ),
        );
      await tx
        .update(validationRuns)
        .set({ status: 'failed', finishedAt: new Date(), results: { ok: false } })
        .where(eq(validationRuns.id, runId));
      // Not validated rather than failed: nothing was learned about the package.
      await tx
        .update(problemVersions)
        .set({ validationStatus: 'pending' })
        .where(
          and(
            eq(problemVersions.id, run.versionId),
            eq(problemVersions.validationStatus, 'running'),
          ),
        );
      runsStarted.add(1, { outcome: 'timed-out' });
    });
  }

  private async read(runId: string): Promise<ValidationRun> {
    const [run] = await this.db
      .select()
      .from(validationRuns)
      .where(eq(validationRuns.id, runId))
      .limit(1);
    if (!run) throw new ProblemError('not-found');
    const rows = await this.db
      .select()
      .from(validationItems)
      .where(eq(validationItems.runId, runId));
    // Solutions by name, the validator last.
    rows.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'validator' ? 1 : -1,
    );
    const finished = run.status === 'done' || run.status === 'failed';
    return {
      id: run.id,
      versionId: run.versionId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      ok: finished ? ((run.results as { ok?: boolean } | null)?.ok ?? false) : null,
      items: rows.map(toItem),
    };
  }
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function itemOk(i: Row): boolean {
  const verdict = (i.result as ItemResult | null)?.verdict;
  return i.status === 'done' && verdict !== undefined && verdict === i.expectedVerdict;
}

function toItem(i: Row): ValidationItem {
  const r = (i.result ?? {}) as ItemResult;
  const failed = (r.tests ?? []).filter((t) => t.verdict !== 'AC').slice(0, MAX_FAILED_TESTS);
  const done = i.status === 'done';
  return {
    kind: i.kind as 'solution' | 'validator',
    name: i.name,
    language: i.language,
    expected: i.expectedVerdict ?? 'AC',
    status: i.status,
    actual: done ? (r.verdict ?? null) : null,
    timeMs: done ? (r.timeMs ?? null) : null,
    memKb: done ? (r.memKb ?? null) : null,
    failedTests: failed.map((t) => ({
      no: t.no,
      verdict: t.verdict,
      ...(t.checkerMsg === undefined ? {} : { message: t.checkerMsg }),
    })),
    ok: i.status === 'queued' || i.status === 'running' ? null : itemOk(i),
    ...(r.message === undefined
      ? r.compileLog === undefined
        ? {}
        : { message: r.compileLog }
      : { message: r.message }),
  };
}
