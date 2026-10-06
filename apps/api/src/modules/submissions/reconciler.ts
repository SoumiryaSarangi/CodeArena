import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Lane } from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config, reconcilerEnabled } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { customRuns, problemVersions, submissions } from '../../db/schema';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { publishEvent } from '../realtime/events';
import { buildJob } from './job-builder';
import { QueuePositionService } from './queue-position.service';
import { QUEUE_KEY_PREFIX, QueueService } from './queue.service';
import { whenReady } from '../../redis/ready';

const tracer = trace.getTracer('api');
const outcomes = metrics.getMeter('api').createCounter('ca_reconciler_total', {
  description: 'Reconciler decisions, by outcome (requeued, failed, live, cooldown)',
});

/** After this many re-enqueues a submission that is still not judged is failed (SE), not looped. */
export const MAX_ATTEMPTS = 3;
const BATCH = 100;
/** Custom runs are throw-away: one stuck this long is failed and the user runs it again. */
const RUN_STUCK_MS = 10 * 60_000;
const SCAN_LIMIT = 1000;

export interface SweepReport {
  requeued: string[];
  failed: string[];
  live: number;
  cooldown: number;
  runsFailed: number;
}

/**
 * FR-QUEUE-09: a submission is saved before its job is queued, and the job can be lost
 * (the API dies in between, Redis is wiped). Every sweep looks for submissions still `queued` or
 * `judging` after `RECONCILER_STUCK_MS` whose job is nowhere in the queue, and queues it again with
 * the same run version, built by the same `buildJob()` as the first time. A verdict that arrives for
 * both copies is stored once (unique `(submission, run version)`), so a double is harmless.
 *
 * A job is *live* if its stream entry still exists (waiting, or claimed and not yet acknowledged:
 * Q-02's takeover owns that case). A job parked in `jobs:dlq` / `jobs:quarantine` was given up on:
 * the submission is failed, not retried. After `MAX_ATTEMPTS` re-enqueues it is failed as well.
 * Only one instance sweeps at a time (`lock:reconciler`).
 */
@Injectable()
export class Reconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly me = randomUUID();
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<unknown> = Promise.resolve();
  /** Test seam: runs in the window between "decided to re-queue" and the final status check. */
  beforeRequeue?: (submissionId: string) => Promise<void>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(QueuePositionService) private readonly positions: QueuePositionService,
  ) {}

  onApplicationBootstrap() {
    if (reconcilerEnabled(this.config)) this.start();
  }

  start() {
    this.timer ??= setInterval(() => {
      this.sweeping = this.sweepLocked().catch((err) =>
        this.log.warn({ err: { message: (err as Error).message } }, 'reconciler sweep failed'),
      );
    }, this.config.RECONCILER_EVERY_MS);
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping;
  }

  private get lockKey() {
    return `${this.prefix}lock:reconciler`;
  }

  /** One sweep if no other instance is sweeping; null when the lease is held elsewhere. */
  async sweepLocked(): Promise<SweepReport | null> {
    await whenReady(this.redis);
    const ttl = Math.max(this.config.RECONCILER_EVERY_MS, 5_000);
    if ((await this.redis.set(this.lockKey, this.me, 'PX', ttl, 'NX')) !== 'OK') return null;
    try {
      return await this.sweep();
    } finally {
      // Free it for the next tick (only if still ours).
      await this.redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
          1,
          this.lockKey,
          this.me,
        )
        .catch(() => {});
    }
  }

  async sweep(now = Date.now()): Promise<SweepReport> {
    return tracer.startActiveSpan('reconciler.sweep', async (span) => {
      try {
        const report: SweepReport = {
          requeued: [],
          failed: [],
          live: 0,
          cooldown: 0,
          runsFailed: 0,
        };
        const cutoff = new Date(now - this.config.RECONCILER_STUCK_MS);
        const stuck = await this.db
          .select({
            id: submissions.id,
            lane: submissions.lane,
            language: submissions.language,
            source: submissions.source,
            runVersion: submissions.currentRunVersion,
            version: {
              id: problemVersions.id,
              testsetHash: problemVersions.testsetHash,
              testsetUri: problemVersions.testsetUri,
              limits: problemVersions.limits,
              checker: problemVersions.checker,
            },
          })
          .from(submissions)
          .innerJoin(problemVersions, eq(problemVersions.id, submissions.problemVersionId))
          .where(
            and(
              inArray(submissions.status, ['queued', 'judging']),
              isNull(submissions.verdict),
              lt(submissions.createdAt, cutoff),
            ),
          )
          .orderBy(submissions.createdAt)
          .limit(BATCH);

        const poisoned = stuck.length > 0 ? await this.parkedSubmissionIds() : new Set<string>();
        for (const s of stuck) {
          const kind = await this.reconcileOne(s, poisoned);
          if (kind === 'requeued') report.requeued.push(s.id);
          else if (kind === 'failed') report.failed.push(s.id);
          else if (kind === 'live') report.live++;
          else report.cooldown++;
          outcomes.add(1, { outcome: kind });
        }
        report.runsFailed = await this.failStuckRuns(now);
        span.setAttributes({
          requeued: report.requeued.length,
          failed: report.failed.length,
          runsFailed: report.runsFailed,
        });
        return report;
      } finally {
        span.end();
      }
    });
  }

  private async reconcileOne(
    s: {
      id: string;
      lane: Lane;
      language: string;
      source: string;
      runVersion: number;
      version: Parameters<typeof buildJob>[1];
    },
    poisoned: Set<string>,
  ): Promise<'requeued' | 'failed' | 'live' | 'cooldown'> {
    // The job still exists in its lane (waiting, or claimed and not acknowledged): not ours to touch.
    if (await this.jobIsLive(s.id)) return 'live';
    if (poisoned.has(s.id)) {
      await this.fail(s.id, s.runVersion);
      return 'failed';
    }
    // Space the attempts out: one per stuck period, even with several sweeps in between.
    const cooldown = await this.redis.set(
      `${this.prefix}recon:cool:${s.id}`,
      '1',
      'PX',
      this.config.RECONCILER_STUCK_MS,
      'NX',
    );
    if (cooldown !== 'OK') return 'cooldown';
    const attempts = await this.redis.hincrby(`${this.prefix}recon:attempts`, s.id, 1);
    await this.redis.expire(`${this.prefix}recon:attempts`, 24 * 3600);
    if (attempts > MAX_ATTEMPTS) {
      await this.fail(s.id, s.runVersion);
      return 'failed';
    }
    await this.beforeRequeue?.(s.id);
    // A verdict may have landed since the query: look again right before queueing.
    const [now] = await this.db
      .select({ status: submissions.status })
      .from(submissions)
      .where(eq(submissions.id, s.id));
    if (!now || (now.status !== 'queued' && now.status !== 'judging')) return 'live';

    const queued = await this.queue.enqueue(
      buildJob(
        {
          id: s.id,
          language: s.language,
          source: s.source,
          lane: s.lane,
          runVersion: s.runVersion,
        },
        s.version,
        'submit',
      ),
    );
    await this.positions.remember(s.id, s.lane, queued.entryId);
    this.log.info(
      { submissionId: s.id, attempt: attempts, lane: s.lane },
      'reconciler re-queued a lost job',
    );
    return 'requeued';
  }

  private async jobIsLive(id: string): Promise<boolean> {
    const raw = await this.redis.get(`${this.prefix}sub:entry:${id}`);
    if (!raw) return false;
    const at = raw.indexOf(':');
    const lane = raw.slice(0, at);
    const entryId = raw.slice(at + 1);
    try {
      const found = await this.redis.xrange(`${this.prefix}jobs:${lane}`, entryId, entryId);
      return found.length > 0;
    } catch {
      return false;
    }
  }

  /** Submissions whose job a judge gave up on (dead letter or quarantine). Bounded scan of two small streams. */
  private async parkedSubmissionIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const stream of ['jobs:dlq', 'jobs:quarantine']) {
      const entries = await this.redis
        .xrevrange(`${this.prefix}${stream}`, '+', '-', 'COUNT', SCAN_LIMIT)
        .catch(() => []);
      for (const [, fields] of entries) {
        const i = fields.indexOf('job');
        if (i < 0) continue;
        try {
          const job = JSON.parse(fields[i + 1]!) as { submissionId?: string };
          if (job.submissionId) ids.add(job.submissionId);
        } catch {
          // an unreadable parked job names no submission
        }
      }
    }
    return ids;
  }

  /** The user is told the truth: it could not be judged (SE), and can submit again. */
  private async fail(id: string, runVersion: number) {
    const updated = await this.db
      .update(submissions)
      .set({ status: 'failed', verdict: 'SE', judgedAt: new Date() })
      .where(
        and(
          eq(submissions.id, id),
          inArray(submissions.status, ['queued', 'judging']),
          isNull(submissions.verdict),
        ),
      )
      .returning({ id: submissions.id });
    if (updated.length === 0) return;
    this.log.warn({ submissionId: id }, 'reconciler gave up: the submission could not be judged');
    await publishEvent(this.redis, this.prefix, this.log, `sub:${id}`, 'submission.verdict', {
      submissionId: id,
      runVersion,
      status: 'failed' as const,
      verdict: 'SE' as const,
      timeMs: 0,
      memKb: 0,
      failedTest: null,
    });
  }

  private async failStuckRuns(now: number): Promise<number> {
    const cutoff = new Date(now - Math.max(RUN_STUCK_MS, this.config.RECONCILER_STUCK_MS));
    const rows = await this.db
      .update(customRuns)
      .set({ status: 'failed' })
      .where(
        and(inArray(customRuns.status, ['queued', 'running']), lt(customRuns.createdAt, cutoff)),
      )
      .returning({ id: customRuns.id });
    for (const r of rows) {
      await publishEvent(this.redis, this.prefix, this.log, `sub:${r.id}`, 'submission.verdict', {
        submissionId: r.id,
        runVersion: 1,
        status: 'failed' as const,
        verdict: 'SE' as const,
        timeMs: 0,
        memKb: 0,
        failedTest: null,
      });
    }
    return rows.length;
  }
}
