import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config } from '../../config/config';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import { LOGGER } from '../../telemetry/logger';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';

export const AI_GROUP = 'ai';
const MAX_DELIVERIES = 3;
const RECLAIM_IDLE_MS = 120_000;

export interface AiJob {
  kind: string;
  payload: unknown;
}
export type AiJobHandler = (
  payload: unknown,
  job: { id: string; delivery: number },
) => Promise<void>;

export const aiWorkerEnabled = (c: Pick<Config, 'NODE_ENV' | 'AI_WORKER'>) =>
  (c.AI_WORKER ?? (c.NODE_ENV === 'test' ? 'off' : 'on')) === 'on';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The async AI job queue: Redis stream `ai:jobs` with a consumer group, one job at a time, and a pause
 * between jobs (`paceMs`) so background work (post-contest reviews, SD-§12.3) trickles through within the
 * daily budget instead of draining it. Unacknowledged jobs of a dead instance are taken over after
 * two minutes; a job delivered three times without success is parked in `ai:jobs:dlq`.
 * A handler that throws is retried by redelivery; handlers must be safe to repeat.
 */
@Injectable()
export class AiQueue implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumer = `${hostname()}-${process.pid}`;
  private readonly handlers = new Map<string, AiJobHandler>();
  private blocking?: Redis;
  private running = false;
  private loop?: Promise<void>;
  /** Pause after each job (ms); set by the feature that owns the background work. */
  paceMs = 0;
  blockMs = 2000;
  reclaimIdleMs = RECLAIM_IDLE_MS;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private get key() {
    return `${this.prefix}ai:jobs`;
  }
  get dlqKey() {
    return `${this.prefix}ai:jobs:dlq`;
  }

  /** Features register what to do with a kind of job. */
  register(kind: string, handler: AiJobHandler) {
    this.handlers.set(kind, handler);
  }

  async enqueue(kind: string, payload: unknown): Promise<string> {
    await whenReady(this.redis);
    const id = await this.redis.xadd(this.key, '*', 'job', JSON.stringify({ kind, payload }));
    return id!;
  }

  async depth(): Promise<number> {
    await whenReady(this.redis);
    return this.redis.xlen(this.key);
  }

  onApplicationBootstrap() {
    if (aiWorkerEnabled(this.config)) this.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.blocking = this.redis.duplicate({
      lazyConnect: true,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    this.blocking.on('error', () => {});
    this.loop = this.run();
  }

  async onApplicationShutdown() {
    await this.stop();
  }

  async stop() {
    this.running = false;
    this.blocking?.disconnect();
    await this.loop;
    this.loop = undefined;
    this.blocking = undefined;
  }

  private async ensureGroup() {
    try {
      await this.redis.xgroup('CREATE', this.key, AI_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message).startsWith('BUSYGROUP')) throw err;
    }
  }

  private async run() {
    const blocking = this.blocking!;
    let lastReclaim = 0;
    while (this.running) {
      try {
        if (blocking.status !== 'ready' && blocking.status !== 'connecting')
          await blocking.connect();
        await this.ensureGroup();
        if (Date.now() - lastReclaim >= this.reclaimIdleMs / 2) {
          lastReclaim = Date.now();
          await this.reclaim();
        }
        const res = (await blocking.xreadgroup(
          'GROUP',
          AI_GROUP,
          this.consumer,
          'COUNT',
          1,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.key,
          '>',
        )) as [string, [string, string[]][]][] | null;
        for (const [, entries] of res ?? []) {
          for (const e of entries) {
            await this.handle(e, 1);
            if (this.paceMs > 0) await sleep(this.paceMs);
          }
        }
      } catch (err) {
        if (!this.running) break;
        this.log.warn(
          { err: { message: (err as Error).message } },
          'ai queue error, retrying in 1 s',
        );
        await sleep(1000);
      }
    }
  }

  /** Takes over jobs a dead instance left unacknowledged; too many deliveries → dead letters. */
  async reclaim() {
    const res = (await this.redis.xautoclaim(
      this.key,
      AI_GROUP,
      this.consumer,
      this.reclaimIdleMs,
      '0-0',
      'COUNT',
      10,
    )) as [string, [string, string[]][], string[]];
    for (const e of res[1]) {
      if (!e[1].length) continue;
      const [info] = (await this.redis.xpending(this.key, AI_GROUP, e[0], e[0], 1)) as [
        string,
        string,
        number,
        number,
      ][];
      await this.handle(e, Number(info?.[3] ?? 2));
    }
  }

  private async handle([id, fields]: [string, string[]], delivery: number) {
    const at = fields.indexOf('job');
    const raw = at >= 0 ? fields[at + 1]! : '';
    let job: AiJob | undefined;
    try {
      job = JSON.parse(raw) as AiJob;
    } catch {
      /* unreadable: parked below */
    }
    const handler = job ? this.handlers.get(job.kind) : undefined;
    try {
      if (!job || !handler)
        throw new Error(job ? `no handler for "${job.kind}"` : 'unreadable job');
      await handler(job.payload, { id, delivery });
      await this.redis.xack(this.key, AI_GROUP, id);
      await this.redis.xdel(this.key, id);
    } catch (err) {
      const msg = (err as Error).message;
      if (delivery >= MAX_DELIVERIES || !handler) {
        // A job nobody can handle (or that failed three times) is parked, not retried forever.
        await this.redis.xadd(
          this.dlqKey,
          '*',
          'job',
          raw,
          'error',
          msg.slice(0, 300),
          'at',
          Date.now(),
        );
        await this.redis.xack(this.key, AI_GROUP, id);
        await this.redis.xdel(this.key, id);
        this.log.error(
          { jobId: id, kind: job?.kind, err: { message: msg } },
          'ai job moved to the dead letters',
        );
      } else {
        this.log.warn(
          { jobId: id, kind: job?.kind, delivery, err: { message: msg } },
          'ai job failed, will be redelivered',
        );
      }
    }
  }
}
