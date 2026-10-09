import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { LOGGER } from '../../telemetry/logger';

/** SD-§6.4: the update log and its checkpoints are kept this long after a room ends. */
export const LOG_RETENTION_DAYS = 90;
const EVERY_MS = 6 * 3_600_000;

/**
 * CP-06 (SD-§6.4): 90 days after a room closed, its update log, checkpoints and version snapshots are deleted ("compacted to the final
 * state": the final document stays in `room_docs`, and the events and notes stay with the room). A room nobody closed counts
 * from the end of its 90-minute session. Idempotent, so every API instance may run it.
 */
@Injectable()
export class RoomsRetention implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async purge(
    now: Date = new Date(),
  ): Promise<{ updates: number; checkpoints: number; snapshots: number }> {
    const cutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000).toISOString();
    const old = sql`(select id from rooms where coalesce(closed_at, created_at + interval '90 minutes') < ${cutoff}::timestamptz)`;
    const count = async (q: ReturnType<typeof sql>) => (await this.db.execute(q)).rowCount ?? 0;
    const checkpoints = await count(sql`delete from room_checkpoints where room_id in ${old}`);
    const updates = await count(sql`delete from room_updates where room_id in ${old}`);
    const snapshots = await count(sql`delete from room_snapshots where room_id in ${old}`);
    if (updates + checkpoints + snapshots > 0)
      this.log.info({ updates, checkpoints, snapshots }, 'room update logs past retention deleted');
    return { updates, checkpoints, snapshots };
  }

  onApplicationBootstrap() {
    if (this.config.NODE_ENV === 'test') return;
    const run = () =>
      this.purge().catch((err) =>
        this.log.warn({ err: { message: (err as Error).message } }, 'room log purge failed'),
      );
    void run();
    this.timer = setInterval(() => void run(), EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
