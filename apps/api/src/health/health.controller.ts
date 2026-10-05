import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Health } from '@codearena/contracts';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { CONFIG, type Config } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { Public } from '../modules/auth/guards';
import { RateLimit } from '../rate-limit/rate-limit';
import { REDIS } from '../redis/redis.module';
import { S3 } from '../s3/s3.module';

type Check = 'ok' | 'down';

const within = async (ms: number, fn: () => Promise<unknown>): Promise<Check> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms))),
    ]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
};

@ApiTags('health')
@Public()
@RateLimit(false)
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get('live')
  live(): Health {
    return { status: 'ok', service: 'api' };
  }

  @Get(['ready', ''])
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, redis, s3] = await Promise.all([
      within(2000, () => this.pool.query('select 1')),
      within(2000, async () => {
        if (this.redis.status === 'wait') await this.redis.connect();
        return this.redis.ping();
      }),
      within(2000, () =>
        this.s3.send(new HeadBucketCommand({ Bucket: this.config.S3_BUCKET_TESTS })),
      ),
    ]);
    const checks = { db, redis, s3 };
    const ok = Object.values(checks).every((c) => c === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
