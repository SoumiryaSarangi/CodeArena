import { PASTE_MIN_CHARS, type SignalBatch } from '@codearena/contracts';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { contestProblems, contests, editorSignals, participants } from '../../db/schema';
import { LOGGER } from '../../telemetry/logger';
import { contestState } from '../contests/state';

const tracer = trace.getTracer('api');
const stored = metrics
  .getMeter('api')
  .createCounter('ca_signals_total', { description: 'Editor signals stored, by kind' });

/** Per person and contest: more than this is a broken or hostile client, so the rest is dropped. */
export const MAX_SIGNALS_PER_USER_CONTEST = 3000;
/** A client clock can be wrong; times outside [now - 15 min, now] become "now". */
const SKEW_MS = 15 * 60_000;
/** FR-SIG-02: signals are deleted this long after the contest ends. */
export const RETENTION_DAYS = 30;
const PURGE_EVERY_MS = 6 * 3_600_000;

/**
 * IN-01 (FR-SIG-01, FR-SIG-02, SD-§14): the browser sends paste events above 50 characters, the moment a problem was
 * opened and window-focus changes during a running contest. They are stored for the review screen (labelled advisory
 * there), deleted 30 days after the contest ends and never used to change a score.
 */
@Injectable()
export class SignalsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /**
   * Stores what is valid and ignores the rest quietly (a signal is never worth an error in the contestant's page):
   * only registered contestants (staff are not watched), only while the contest runs, only the problem named, small
   * pastes dropped, at most one `problem_open` per problem. Returns how many rows were stored.
   */
  async record(user: { id: string; role: string }, body: SignalBatch): Promise<number> {
    return tracer.startActiveSpan('signals.record', async (span) => {
      try {
        if (user.role === 'admin' || user.role === 'setter') return 0;
        const [c] = await this.db
          .select()
          .from(contests)
          .where(eq(contests.slug, body.contest))
          .limit(1);
        if (!c || c.status === 'draft') throw new ProblemError('not-found', 'No such contest');
        if (contestState(c, new Date()) !== 'running') return 0;
        const [problem] = await this.db
          .select({ problemId: contestProblems.problemId })
          .from(contestProblems)
          .where(and(eq(contestProblems.contestId, c.id), eq(contestProblems.label, body.problem)))
          .limit(1);
        if (!problem) throw new ProblemError('not-found', 'No such problem in this contest');
        const [p] = await this.db
          .select({ userId: participants.userId })
          .from(participants)
          .where(and(eq(participants.contestId, c.id), eq(participants.userId, user.id)));
        if (!p) return 0;

        const now = Date.now();
        const clamp = (iso: string) => {
          const t = Date.parse(iso);
          return new Date(t > now || t < now - SKEW_MS ? now : t);
        };
        const rows = body.events
          .filter((e) => e.kind !== 'paste' || (e.size ?? 0) > PASTE_MIN_CHARS)
          .map((e) => ({
            userId: user.id,
            contestId: c.id,
            problemId: problem.problemId,
            kind: e.kind,
            size: e.kind === 'paste' ? (e.size ?? null) : null,
            at: clamp(e.at),
          }));
        if (rows.length === 0) return 0;

        const [have] = await this.db
          .select({ n: count() })
          .from(editorSignals)
          .where(and(eq(editorSignals.userId, user.id), eq(editorSignals.contestId, c.id)));
        const room = MAX_SIGNALS_PER_USER_CONTEST - (have?.n ?? 0);
        if (room <= 0) return 0;

        let toStore = rows.slice(0, room);
        if (toStore.some((r) => r.kind === 'problem_open')) {
          const [opened] = await this.db
            .select({ id: editorSignals.id })
            .from(editorSignals)
            .where(
              and(
                eq(editorSignals.userId, user.id),
                eq(editorSignals.contestId, c.id),
                eq(editorSignals.problemId, problem.problemId),
                eq(editorSignals.kind, 'problem_open'),
              ),
            )
            .limit(1);
          let seen = !!opened;
          toStore = toStore.filter((r) => {
            if (r.kind !== 'problem_open') return true;
            if (seen) return false;
            seen = true;
            return true;
          });
        }
        if (toStore.length === 0) return 0;
        await this.db.insert(editorSignals).values(toStore);
        for (const r of toStore) stored.add(1, { kind: r.kind });
        span.setAttribute('signals.stored', toStore.length);
        return toStore.length;
      } finally {
        span.end();
      }
    });
  }

  /** FR-SIG-02: deletes the signals of contests that ended more than 30 days ago. Idempotent, safe on every instance. */
  async purge(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
    const gone = await this.db.execute(sql`
      delete from editor_signals where contest_id in (select id from contests where ends_at < ${cutoff.toISOString()}::timestamptz)
      returning id`);
    const n = (gone.rows ?? (gone as unknown as { rows: unknown[] }).rows).length;
    if (n > 0) this.log.info({ deleted: n }, 'editor signals past retention deleted');
    return n;
  }

  onApplicationBootstrap() {
    if (this.config.NODE_ENV === 'test') return;
    const run = () =>
      this.purge().catch((err) =>
        this.log.warn({ err: { message: (err as Error).message } }, 'signal purge failed'),
      );
    void run();
    this.timer = setInterval(() => void run(), PURGE_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
