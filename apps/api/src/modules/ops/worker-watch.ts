import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config, reconcilerEnabled } from '../../config/config';
import { LOGGER } from '../../telemetry/logger';
import { REDIS } from '../../redis/redis.module';
import { whenReady } from '../../redis/ready';
import { noteRestarts } from '../submissions/live-workers';
import { QUEUE_KEY_PREFIX } from '../submissions/queue.service';

/** X-15: how often the heartbeats are compared with the start times seen before (they come every 3 s). */
export const WORKER_WATCH_EVERY_MS = 3_000;

/** Notices judge worker restarts (see `noteRestarts`) so the console can show them. Off in tests, like the reconciler. */
@Injectable()
export class WorkerWatch implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(QUEUE_KEY_PREFIX) private readonly prefix: string,
  ) {}

  onApplicationBootstrap() {
    if (reconcilerEnabled(this.config)) this.start();
  }

  start() {
    this.timer ??= setInterval(() => void this.tick(), WORKER_WATCH_EVERY_MS);
  }

  async tick(now = Date.now()) {
    try {
      await whenReady(this.redis);
      const n = await noteRestarts(this.redis, this.prefix, now);
      if (n > 0) this.log.warn({ restarts: n }, 'a judge worker restarted');
    } catch (err) {
      this.log.warn({ err: { message: (err as Error).message } }, 'worker watch failed');
    }
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
