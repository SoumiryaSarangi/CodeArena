import { Inject, Injectable } from '@nestjs/common';
import type { AdminGrantList } from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { asc, count, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { adminGrants, users } from '../../db/schema';
import { LOGGER } from '../../telemetry/logger';

const tracer = trace.getTracer('api');
const actions = metrics.getMeter('api').createCounter('ca_admin_grants_total', {
  description: 'Admin grants added and removed by the owner',
});

/** At most this many listed addresses: a typo cannot turn the list into a roster. */
export const MAX_GRANTS = 50;

/**
 * FR-AUTH-12..14. The owner (OWNER_EMAIL) lists addresses; whoever signs in with one is admin
 * (applied in UsersService.upsertFromOAuth). Adding promotes an existing account at once; removing
 * demotes it to `user`. The owner is never listed, demoted or removed.
 */
@Injectable()
export class AdminGrantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  private owner(): string | null {
    return this.config.OWNER_EMAIL?.toLowerCase() ?? null;
  }

  /** Only the owner: everyone else (an ordinary admin too) gets 403. */
  private async assertOwner(userId: string): Promise<string> {
    const owner = this.owner();
    const [u] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!owner || !u || u.email.toLowerCase() !== owner)
      throw new ProblemError('forbidden', 'Only the owner can manage admins.');
    return owner;
  }

  async list(userId: string): Promise<AdminGrantList> {
    const owner = await this.assertOwner(userId);
    const rows = await this.db
      .select({
        email: adminGrants.email,
        grantedBy: adminGrants.grantedBy,
        createdAt: adminGrants.createdAt,
        userId: users.id,
      })
      .from(adminGrants)
      .leftJoin(users, eq(users.email, adminGrants.email))
      .orderBy(asc(adminGrants.createdAt));
    return {
      owner,
      max: MAX_GRANTS,
      grants: rows.map((r) => ({
        email: r.email,
        // only the owner can add, so a recorded grantor is the owner
        grantedBy: r.grantedBy ? owner : null,
        createdAt: r.createdAt.toISOString(),
        signedUp: r.userId !== null,
      })),
    };
  }

  async add(userId: string, rawEmail: string): Promise<void> {
    return tracer.startActiveSpan('admin.grant.add', async (span) => {
      try {
        const owner = await this.assertOwner(userId);
        const email = rawEmail.toLowerCase();
        if (email === owner)
          throw new ProblemError('conflict', 'That is your own address: you are always admin.');
        await this.db.transaction(async (tx) => {
          const [total] = await tx.select({ n: count() }).from(adminGrants);
          if ((total?.n ?? 0) >= MAX_GRANTS)
            throw new ProblemError('validation', `At most ${MAX_GRANTS} addresses can be listed.`);
          const inserted = await tx
            .insert(adminGrants)
            .values({ email, grantedBy: userId })
            .onConflictDoNothing()
            .returning({ email: adminGrants.email });
          if (inserted.length === 0)
            throw new ProblemError('conflict', 'That address is already listed.');
          // Someone who already has an account is admin now (their next token refresh carries it).
          await tx.update(users).set({ role: 'admin' }).where(eq(users.email, email));
        });
        actions.add(1, { action: 'add' });
        this.log.info({ event: 'admin.grant.add', by: userId, email }, 'admin address added');
      } finally {
        span.end();
      }
    });
  }

  async remove(userId: string, rawEmail: string): Promise<void> {
    return tracer.startActiveSpan('admin.grant.remove', async (span) => {
      try {
        const owner = await this.assertOwner(userId);
        const email = rawEmail.toLowerCase();
        if (email === owner)
          throw new ProblemError('conflict', 'The owner is always admin and cannot be removed.');
        await this.db.transaction(async (tx) => {
          const gone = await tx
            .delete(adminGrants)
            .where(eq(adminGrants.email, email))
            .returning({ email: adminGrants.email });
          if (gone.length === 0) throw new ProblemError('not-found', 'That address is not listed.');
          // Back to an ordinary account (never below `user`, and never touching the owner).
          await tx.update(users).set({ role: 'user' }).where(eq(users.email, email));
        });
        actions.add(1, { action: 'remove' });
        this.log.info({ event: 'admin.grant.remove', by: userId, email }, 'admin address removed');
      } finally {
        span.end();
      }
    });
  }
}
