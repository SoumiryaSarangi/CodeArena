import type { ComponentState, Lane, PlatformStatus } from '@codearena/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { REDIS } from '../../redis/redis.module';
import { laneDepth } from '../submissions/lane-depth';
import { liveWorkers } from '../submissions/live-workers';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';

const tracer = trace.getTracer('api');
const reads = metrics.getMeter('api').createCounter('ca_status_reads_total', {
  description: 'Status page reads, by whether the 5 s cache answered',
});

const LANES: Lane[] = ['contest', 'interactive', 'practice', 'rejudge'];
/** SRS: the status answer is cached for 5 s, so a busy page cannot load the database. */
export const STATUS_CACHE_MS = 5000;
/** A contest lane this deep means contestants are waiting noticeably (SD-§15.3 is about time; this is the leading sign). */
const CONTEST_BACKLOG = 20;

const within = async (ms: number, fn: () => Promise<unknown>): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms))),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** What the public status page shows (O-02, UI_UX S18): health of each part, queue, speed, totals. */
@Injectable()
export class StatusService {
  private cached: { at: number; value: PlatformStatus } | null = null;
  private inflight: Promise<PlatformStatus> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async get(now = Date.now()): Promise<PlatformStatus> {
    if (this.cached && now - this.cached.at < STATUS_CACHE_MS) {
      reads.add(1, { cache: 'hit' });
      return this.cached.value;
    }
    // Several readers arriving together share one computation.
    this.inflight ??= this.compute().finally(() => (this.inflight = null));
    const value = await this.inflight;
    this.cached = { at: now, value };
    reads.add(1, { cache: 'miss' });
    return value;
  }

  /**
   * The interview pad is up when the collab servers the API already talks to (COLLAB_URL) answer
   * `GET /` (the same check as their container health check). Not configured here: 'planned'.
   */
  private async padState(): Promise<{ state: ComponentState; detail: string }> {
    const urls = (this.config.COLLAB_URL ?? '').split(/[\s,]+/).filter(Boolean);
    if (urls.length === 0) return { state: 'planned', detail: 'Not set up on this server' };
    const up = (
      await Promise.all(
        urls.map((u) =>
          within(2000, async () => {
            const res = await fetch(u, { signal: AbortSignal.timeout(2000) });
            if (!res.ok) throw new Error(String(res.status));
          }),
        ),
      )
    ).filter(Boolean).length;
    if (up === urls.length)
      return { state: 'ok', detail: `${up} server${up === 1 ? '' : 's'} answering` };
    if (up > 0) return { state: 'degraded', detail: `${up} of ${urls.length} servers answering` };
    return { state: 'down', detail: 'Not answering; open rooms may disconnect' };
  }

  private async compute(): Promise<PlatformStatus> {
    return tracer.startActiveSpan('status.compute', async (span) => {
      try {
        const now = Date.now();
        const [dbOk, redisOk, pad] = await Promise.all([
          within(2000, () => this.db.execute(sql`select 1`)),
          within(2000, () => this.redis.ping()),
          this.padState(),
        ]);
        const [queue, workers, times, totals] = await Promise.all([
          redisOk
            ? Promise.all(
                LANES.map(async (lane) => ({
                  lane,
                  depth: await laneDepth(this.redis, this.prefix, lane),
                })),
              )
            : Promise.resolve(LANES.map((lane) => ({ lane, depth: 0 }))),
          redisOk ? liveWorkers(this.redis, this.prefix, now).catch(() => []) : Promise.resolve([]),
          dbOk ? this.times() : Promise.resolve({ p50: null, p95: null }),
          dbOk ? this.totals() : Promise.resolve({ submissionsJudged: 0, contestsHosted: 0 }),
        ]);

        const backlog = queue.find((q) => q.lane === 'contest')?.depth ?? 0;
        const alive = workers.length;
        const state = (ok: boolean): ComponentState => (ok ? 'ok' : 'down');
        const components: PlatformStatus['components'] = [
          { id: 'api', label: 'API', state: 'ok', detail: 'Answering requests' },
          {
            id: 'database',
            label: 'Database',
            state: state(dbOk),
            detail: dbOk ? 'Reachable' : 'Not reachable',
          },
          {
            id: 'queue',
            label: 'Judging queue',
            state: !redisOk ? 'down' : backlog > CONTEST_BACKLOG ? 'degraded' : 'ok',
            detail: !redisOk
              ? 'Not reachable'
              : backlog > CONTEST_BACKLOG
                ? `${backlog} contest jobs waiting`
                : 'Jobs are being picked up',
          },
          {
            id: 'judges',
            label: 'Judges',
            state: alive > 0 ? 'ok' : 'down',
            detail:
              alive > 0
                ? `${alive} judge${alive === 1 ? '' : 's'} reporting`
                : 'No judge is reporting; submissions wait',
          },
          {
            id: 'realtime',
            label: 'Live updates',
            state: state(redisOk),
            detail: redisOk ? 'Verdicts and scoreboards stream live' : 'Not available',
          },
          { id: 'pad', label: 'Interview pad', ...pad },
        ];
        // Judging is the product's core: the pad being down makes the platform "degraded", never "down".
        const core = components.filter((c) => c.state !== 'planned' && c.id !== 'pad');
        const overall: PlatformStatus['overall'] = core.some((c) => c.state === 'down')
          ? 'down'
          : core.some((c) => c.state === 'degraded') ||
              pad.state === 'down' ||
              pad.state === 'degraded'
            ? 'degraded'
            : 'ok';
        span.setAttribute('status.overall', overall);
        return {
          serverNow: new Date(now).toISOString(),
          overall,
          components,
          queue,
          p50Ms: times.p50 === null ? null : Math.round(times.p50),
          p95Ms: times.p95 === null ? null : Math.round(times.p95),
          totals,
        };
      } finally {
        span.end();
      }
    });
  }

  private async times(): Promise<{ p50: number | null; p95: number | null }> {
    try {
      const res = await this.db.execute<{ p50: number | null; p95: number | null; n: number }>(sql`
        select
          percentile_cont(0.5) within group (order by extract(epoch from (judged_at - created_at)) * 1000) as p50,
          percentile_cont(0.95) within group (order by extract(epoch from (judged_at - created_at)) * 1000) as p95,
          count(*)::int as n
        from submissions
        where judged_at is not null and verdict is not null and judged_at > now() - interval '15 minutes'
      `);
      const row = res.rows[0];
      return row && row.n > 0
        ? {
            p50: row.p50 === null ? null : Number(row.p50),
            p95: row.p95 === null ? null : Number(row.p95),
          }
        : { p50: null, p95: null };
    } catch {
      return { p50: null, p95: null };
    }
  }

  private async totals(): Promise<PlatformStatus['totals']> {
    try {
      const res = await this.db.execute<{ judged: number; contests: number }>(sql`
        select
          (select count(*)::int from submissions where verdict is not null) as judged,
          (select count(*)::int from contests where status <> 'draft') as contests
      `);
      const row = res.rows[0];
      return {
        submissionsJudged: Number(row?.judged ?? 0),
        contestsHosted: Number(row?.contests ?? 0),
      };
    } catch {
      return { submissionsJudged: 0, contestsHosted: 0 };
    }
  }
}
