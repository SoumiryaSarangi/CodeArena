import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Logger } from 'pino';
import { CONFIG, type Config } from '../config/config';
import { LOGGER } from '../telemetry/logger';
import { connect, type Db } from './client';
import * as schema from './schema';

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CONFIG, LOGGER],
      useFactory: (config: Config, log: Logger): pg.Pool =>
        connect(config.DATABASE_URL, (e) =>
          log.warn({ err: e.message }, 'an idle database connection failed; the pool replaces it'),
        ).pool,
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Db => drizzle(pool, { schema }),
    },
  ],
  exports: [PG_POOL, DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

export type { Db };
