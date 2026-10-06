import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { JudgeProgress } from '@codearena/contracts';
import { metrics } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config, realtimeBridgeEnabled } from '../../config/config';
import { REDIS } from '../../redis/redis.module';
import { LOGGER } from '../../telemetry/logger';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';
import { publishEvent } from './events';
import { whenReady } from '../../redis/ready';

const bridged = metrics.getMeter('api').createCounter('ca_progress_bridged_total', {
  description: 'Worker progress messages copied to the realtime layer, by outcome',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EWMA_ALPHA = 0.2;
const CLAIM_TTL_S = 600;

// Renew the lease only if it is still ours.
const RENEW = `
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end
return 0
`;

/**
 * Copies the worker's `progress:{id}` pub/sub into the replay buffer and `rt:` fan-out as
 * `submission.progress` events (SD-§10), so progress has ordered ids and survives a reconnect.
 * Exactly one API instance does this at a time (a lease on `lock:bridge`): a single writer is what
 * keeps event ids in the order the worker published, with no per-message coordination. If the
 * leader dies another instance takes over within one lease.
 *
 * It also learns how long a judge takes (claimed → done) and keeps `ewma:svc:{lane}` for the ETA.
 */
@Injectable()
export class ProgressBridge implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly me = randomUUID();
  private sub: Redis | null = null;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
  ) {}

  get leader() {
    return this.sub !== null;
  }

  onApplicationBootstrap() {
    if (!realtimeBridgeEnabled(this.config)) return;
    this.start();
  }

  start() {
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      Math.max(100, this.config.BRIDGE_LEASE_MS / 3),
    );
  }

  private get lockKey() {
    return `${this.prefix}lock:bridge`;
  }

  private async tick() {
    if (this.stopped) return;
    try {
      await whenReady(this.redis);
      const lease = this.config.BRIDGE_LEASE_MS;
      const took = await this.redis.set(this.lockKey, this.me, 'PX', lease, 'NX');
      const mine =
        took === 'OK' || (await this.redis.eval(RENEW, 1, this.lockKey, this.me, lease)) === 1;
      if (mine && !this.sub) await this.lead();
      else if (!mine && this.sub) this.resign();
    } catch (err) {
      this.log.warn(
        { err: { message: (err as Error).message } },
        'progress bridge lease check failed',
      );
      if (this.sub) this.resign(); // cannot prove we still hold the lease
    }
  }

  private async lead() {
    const s = new Redis(this.config.REDIS_URL);
    s.on('error', () => {});
    s.on('pmessage', (_pattern: string, channel: string, raw: string) => {
      // One at a time and in arrival order: that order becomes the event id order.
      this.chain = this.chain.then(() => this.handle(channel, raw)).catch(() => {});
    });
    await s.psubscribe(`${this.prefix}progress:*`);
    this.sub = s;
    this.log.info('progress bridge: this instance is the leader');
  }

  private resign() {
    this.sub?.disconnect();
    this.sub = null;
    this.log.info('progress bridge: this instance is no longer the leader');
  }

  private async handle(channel: string, raw: string) {
    let progress: JudgeProgress;
    try {
      const parsed = JudgeProgress.safeParse(JSON.parse(raw));
      if (!parsed.success) return void bridged.add(1, { outcome: 'invalid' });
      progress = parsed.data;
    } catch {
      return void bridged.add(1, { outcome: 'invalid' });
    }
    // The id comes from the channel name the worker published on; it must agree with the body.
    const id = channel.slice(`${this.prefix}progress:`.length);
    if (id !== progress.submissionId || !UUID.test(id))
      return void bridged.add(1, { outcome: 'ignored' });

    await publishEvent(
      this.redis,
      this.prefix,
      this.log,
      `sub:${id}`,
      'submission.progress',
      progress,
    );
    bridged.add(1, { outcome: 'bridged' });
    await this.learn(id, progress).catch(() => {});
  }

  /** claimed → done is one job's service time; fold it into the lane's moving average. */
  private async learn(id: string, p: JudgeProgress) {
    const claimKey = `${this.prefix}pclaim:${id}`;
    if (p.phase === 'claimed') {
      await this.redis.set(claimKey, String(p.ts), 'EX', CLAIM_TTL_S);
      return;
    }
    if (p.phase !== 'done') return;
    const [claimed, entry] = await Promise.all([
      this.redis.get(claimKey),
      this.redis.get(`${this.prefix}sub:entry:${id}`),
    ]);
    if (!claimed || !entry) return;
    const lane = entry.slice(0, entry.indexOf(':'));
    const svc = p.ts - Number(claimed);
    if (!(svc > 0)) return;
    const key = `${this.prefix}ewma:svc:${lane}`;
    const old = Number(await this.redis.get(key));
    await this.redis.set(key, String(old > 0 ? EWMA_ALPHA * svc + (1 - EWMA_ALPHA) * old : svc));
    await this.redis.del(claimKey);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    const wasLeader = this.sub !== null;
    this.resign();
    if (wasLeader) {
      // Hand the lease over at once instead of making the others wait for it to expire.
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
}
