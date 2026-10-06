import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config, resultConsumerEnabled } from '../../config/config';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { QUEUE_KEY_PREFIX } from './queue.service';
import { ResultsProcessor } from './results.processor';

export const CONSUMER_OPTIONS = Symbol('RESULTS_CONSUMER_OPTIONS');

/** Timings and limits; the defaults are the SD-§5.3 / ADR-005 values, tests shrink them. */
export interface ConsumerOptions {
  /** How long one XREADGROUP waits for new results. */
  blockMs: number;
  /** How often to look for results held by API instances that died. */
  reclaimEveryMs: number;
  /** A result idle this long in someone else's pending list is taken over. */
  reclaimIdleMs: number;
  /** After this many deliveries a result that still fails is parked. */
  maxDeliveries: number;
  /** How often to trim acknowledged results older than `retainMs`. */
  trimEveryMs: number;
  retainMs: number;
  /** In-process retries (with back-off) for a transient failure before leaving the entry pending. */
  retryBackoffMs: number[];
}

export const DEFAULT_CONSUMER_OPTIONS: ConsumerOptions = {
  blockMs: 2000,
  reclaimEveryMs: 30_000,
  reclaimIdleMs: 60_000,
  maxDeliveries: 5,
  trimEveryMs: 60_000,
  retainMs: 60 * 60_000,
  retryBackoffMs: [200, 1000, 3000],
};

export const RESULTS_GROUP = 'api';

const dlqCounter = metrics.getMeter('api').createCounter('ca_results_dlq_total', {
  description: 'Results parked in results:dlq, by reason',
});

type Entry = [id: string, fields: string[]];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const idMs = (id: string) => Number(id.split('-')[0]);

/**
 * Reads the `results` stream as consumer group `api` (SD-§5.2, ADR-005). Each API
 * instance is one consumer; an entry is acknowledged only after its transaction
 * committed, so a crash redelivers it and the processor's duplicate check absorbs
 * the repeat (FR-QUEUE-06).
 */
@Injectable()
export class ResultsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumer = `${hostname()}-${process.pid}`;
  private readonly opt: ConsumerOptions;
  private blocking?: Redis;
  private running = false;
  private loop?: Promise<void>;
  private lastReclaim = 0;
  private lastTrim = 0;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(ResultsProcessor) private readonly processor: ResultsProcessor,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CONFIG) private readonly config: Config,
    @Optional() @Inject(CONSUMER_OPTIONS) options?: Partial<ConsumerOptions>,
  ) {
    this.opt = { ...DEFAULT_CONSUMER_OPTIONS, ...options };
  }

  private get key() {
    return `${this.prefix}results`;
  }

  private get dlqKey() {
    return `${this.prefix}results:dlq`;
  }

  onApplicationBootstrap() {
    if (resultConsumerEnabled(this.config)) this.start();
  }

  /** Starts the loop (also used directly by tests and the chaos CLI). */
  start() {
    if (this.running) return;
    this.running = true;
    // A blocking read needs its own connection: it would stall the shared one.
    this.blocking = this.redis.duplicate({
      lazyConnect: true,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    this.blocking.on('error', () => {}); // the loop logs and retries
    this.loop = this.run();
  }

  async onApplicationShutdown() {
    await this.stop();
  }

  async stop() {
    this.running = false;
    this.blocking?.disconnect(); // aborts a pending BLOCK
    await this.loop;
    this.loop = undefined;
    this.blocking = undefined;
  }

  private async run() {
    const blocking = this.blocking!;
    while (this.running) {
      try {
        if (blocking.status !== 'ready' && blocking.status !== 'connecting')
          await blocking.connect();
        await this.ensureGroup();
        await this.maintenance();
        const res = (await blocking.xreadgroup(
          'GROUP',
          RESULTS_GROUP,
          this.consumer,
          'COUNT',
          10,
          'BLOCK',
          this.opt.blockMs,
          'STREAMS',
          this.key,
          '>',
        )) as [string, Entry[]][] | null;
        for (const [, entries] of res ?? []) for (const e of entries) await this.handleEntry(e);
      } catch (err) {
        if (!this.running) break;
        this.log.warn(
          { err: { message: (err as Error).message } },
          'results consumer error, retrying in 1 s',
        );
        await sleep(1000);
      }
    }
  }

  private async ensureGroup() {
    try {
      await this.redis.xgroup('CREATE', this.key, RESULTS_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message).startsWith('BUSYGROUP')) throw err;
    }
  }

  /** Takeover of dead instances' results, and trimming. Both are cheap and time-gated. */
  private async maintenance() {
    const now = Date.now();
    if (now - this.lastReclaim >= this.opt.reclaimEveryMs) {
      this.lastReclaim = now;
      await this.reclaim();
    }
    if (now - this.lastTrim >= this.opt.trimEveryMs) {
      this.lastTrim = now;
      await this.trim(now);
    }
  }

  async reclaim() {
    const res = (await this.redis.xautoclaim(
      this.key,
      RESULTS_GROUP,
      this.consumer,
      this.opt.reclaimIdleMs,
      '0-0',
      'COUNT',
      20,
    )) as [string, Entry[], string[]];
    for (const e of res[1]) {
      if (!e[1].length) continue; // deleted entry still in the pending list: XAUTOCLAIM reports it separately
      await this.handleEntry(e, true);
    }
  }

  private async handleEntry([id, fields]: Entry, reclaimed = false) {
    const at = fields.indexOf('result');
    const raw = at >= 0 ? fields[at + 1]! : '';

    if (reclaimed) {
      const [info] = (await this.redis.xpending(this.key, RESULTS_GROUP, id, id, 1)) as [
        string,
        string,
        number,
        number,
      ][];
      if (info && info[3] > this.opt.maxDeliveries) {
        await this.park(
          id,
          raw,
          'too-many-deliveries',
          `delivered ${info[3]} times without being processed`,
        );
        return;
      }
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await this.processor.handle(raw);
        if (outcome.kind === 'parked') {
          this.log.error(
            { entry: id, reason: outcome.reason, detail: outcome.detail },
            'ALERT unusable judge result parked',
          );
          await this.park(id, raw, outcome.reason, outcome.detail);
        } else {
          await this.redis.xack(this.key, RESULTS_GROUP, id);
        }
        return;
      } catch (err) {
        const wait = this.opt.retryBackoffMs[attempt];
        this.log.warn(
          { entry: id, attempt, err: { message: (err as Error).message } },
          'could not process a judge result',
        );
        if (wait === undefined || !this.running) return; // stays pending: the takeover scan retries it
        await sleep(wait);
      }
    }
  }

  private async park(id: string, raw: string, reason: string, detail: string) {
    await this.redis
      .multi()
      .xadd(
        this.dlqKey,
        '*',
        'result',
        raw,
        'reason',
        reason,
        'detail',
        detail,
        'entry',
        id,
        'ts',
        String(Date.now()),
      )
      .xack(this.key, RESULTS_GROUP, id)
      .exec();
    dlqCounter.add(1, { reason });
  }

  /**
   * Drops results older than `retainMs` (SD-§7), but never one that has not been
   * acknowledged yet or has not been delivered: the cutoff stops at the group's
   * oldest pending entry and at its last delivered id.
   */
  async trim(now = Date.now()) {
    const groups = (await this.redis.xinfo('GROUPS', this.key)) as unknown[][];
    const g = groups
      .map((row) => Object.fromEntries(chunk(row)))
      .find((x) => x.name === RESULTS_GROUP);
    if (!g) return 0;
    let cutoff = Math.min(now - this.opt.retainMs, idMs(String(g['last-delivered-id'])));
    const [count, minPending] = (await this.redis.xpending(this.key, RESULTS_GROUP)) as [
      number,
      string | null,
    ];
    if (count > 0 && minPending) cutoff = Math.min(cutoff, idMs(minPending));
    if (!(cutoff > 0)) return 0;
    // Exact (no `~`): an approximate trim can keep everything on a short stream, and either way never goes past the cutoff.
    return this.redis.xtrim(this.key, 'MINID', `${cutoff}-0`);
  }
}

function* pairs<T>(row: T[]): Generator<[string, T]> {
  for (let i = 0; i + 1 < row.length; i += 2) yield [String(row[i]), row[i + 1]!];
}
const chunk = <T>(row: T[]) => [...pairs(row)];
