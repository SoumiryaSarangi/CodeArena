import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { CONFIG, type Config } from '../config/config';
import { LOGGER } from '../telemetry/logger';

export const REDIS = Symbol('REDIS');

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [CONFIG, LOGGER],
      useFactory: (config: Config, log: Logger) => {
        // lazyConnect: boot must not fail because Redis is briefly down; /health/ready reports it.
        const redis = new Redis(config.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        // Without a listener ioredis prints every reconnect failure as an unhandled error.
        let lastLog = 0;
        redis.on('error', (err: Error) => {
          if (Date.now() - lastLog < 30_000) return;
          lastLog = Date.now();
          log.warn(
            { err: { message: err.message } },
            'redis connection error (repeats suppressed for 30 s)',
          );
        });
        return redis;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown() {
    this.redis.disconnect();
  }
}
