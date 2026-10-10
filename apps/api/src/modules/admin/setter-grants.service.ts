import { Inject, Injectable } from '@nestjs/common';
import type { SetterGrantList } from '@codearena/contracts';
import { metrics, trace } from '@opentelemetry/api';
import { asc, count, eq, and } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { auditLog, setterGrants, users } from '../../db/schema';
import { LOGGER } from '../../telemetry/logger';

const tracer = trace.getTracer('api');
const actions = metrics.getMeter('api').createCounter('ca_setter_grants_total', {
  description: 'Setter addresses added and removed by the owner',
});

/** At most this many listed addresses, like the admin list. */
export const MAX_SETTERS = 50;

/**
 * FR-AUTH-15..17. The owner (OWNER_EMAIL) lists addresses; whoever signs in with one is a setter
 * (applied in UsersService.upsertFromOAuth). Adding promotes an existing `user` account at once;
 * removing turns a `setter` back into a `user`. An admin is never lowered by either, and the owner is
 * never listed. Every change is written to the audit log.
 */
@Injectable()
export class SetterGrantsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /** Only the owner: everyone else (an ordinary admin too) gets 403. */
  private async assertOwner(userId: string): Promise<string> {
    const owner = this.config.OWNER_EMAIL?.toLowerCase() ?? null;
    const [u] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!owner || !u || u.email.toLowerCase() !== owner)
      throw new ProblemError('forbidden', 'Only the owner can manage setters.');
    return owner;
  }

  async list(userId: string): Promise<SetterGrantList> {
    const owner = await this.assertOwner(userId);
    const rows = await this.db
      .select({
        email: setterGrants.email,
        grantedBy: setterGrants.grantedBy,
        createdAt: setterGrants.createdAt,
        userId: users.id,
      })
      .from(setterGrants)
      .leftJoin(users, eq(users.email, setterGrants.email))
      .orderBy(asc(setterGrants.createdAt));
    return {
      owner,
      max: MAX_SETTERS,
      grants: rows.map((r) => ({
        email: r.email,
        grantedBy: r.grantedBy ? owner : null,
        createdAt: r.createdAt.toISOString(),
        signedUp: r.userId !== null,
      })),
    };
  }

  async add(userId: string, rawEmail: string): Promise<void> {
    return tracer.startActiveSpan('admin.setter.add', async (span) => {
      try {
        const owner = await this.assertOwner(userId);
        const email = rawEmail.toLowerCase();
        if (email === owner)
          throw new ProblemError('conflict', 'That is your own address: you are always admin.');
        await this.db.transaction(async (tx) => {
          const [total] = await tx.select({ n: count() }).from(setterGrants);
          if ((total?.n ?? 0) >= MAX_SETTERS)
            throw new ProblemError('validation', `At most ${MAX_SETTERS} addresses can be listed.`);
          const inserted = await tx
            .insert(setterGrants)
            .values({ email, grantedBy: userId })
            .onConflictDoNothing()
            .returning({ email: setterGrants.email });
          if (inserted.length === 0)
            throw new ProblemError('conflict', 'That address is already listed.');
          // An existing ordinary account is a setter now; an admin or a setter keeps what it has.
          await tx
            .update(users)
            .set({ role: 'setter' })
            .where(and(eq(users.email, email), eq(users.role, 'user')));
          await tx.insert(auditLog).values({
            actorId: userId,
            action: 'setter.add',
            targetType: 'email',
            targetId: email,
          });
        });
        actions.add(1, { action: 'add' });
        this.log.info({ event: 'admin.setter.add', by: userId, email }, 'setter address added');
      } finally {
        span.end();
      }
    });
  }

  async remove(userId: string, rawEmail: string): Promise<void> {
    return tracer.startActiveSpan('admin.setter.remove', async (span) => {
      try {
        await this.assertOwner(userId);
        const email = rawEmail.toLowerCase();
        await this.db.transaction(async (tx) => {
          const gone = await tx
            .delete(setterGrants)
            .where(eq(setterGrants.email, email))
            .returning({ email: setterGrants.email });
          if (gone.length === 0) throw new ProblemError('not-found', 'That address is not listed.');
          // A setter goes back to an ordinary user; an admin is not lowered here (that is the admin list's job).
          await tx
            .update(users)
            .set({ role: 'user' })
            .where(and(eq(users.email, email), eq(users.role, 'setter')));
          await tx.insert(auditLog).values({
            actorId: userId,
            action: 'setter.remove',
            targetType: 'email',
            targetId: email,
          });
        });
        actions.add(1, { action: 'remove' });
        this.log.info(
          { event: 'admin.setter.remove', by: userId, email },
          'setter address removed',
        );
      } finally {
        span.end();
      }
    });
  }
}
