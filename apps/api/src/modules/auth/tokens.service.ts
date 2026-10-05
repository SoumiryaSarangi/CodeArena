import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@codearena/contracts';
import { metrics } from '@opentelemetry/api';
import { and, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { ProblemError } from '../../common/problem';
import { DB, type Db } from '../../db/db.module';
import { refreshTokens, users } from '../../db/schema';
import { uuidv7 } from '../../db/uuid';
import { LOGGER } from '../../telemetry/logger';
import { REFRESH_TTL_MS } from './cookies';

/** A token rotated this recently is a concurrent-tab race, not theft (see F-06 plan, decision 5). */
export const ROTATION_GRACE_MS = 5_000;

export const authEvents = metrics
  .getMeter('api')
  .createCounter('ca_auth_events_total', { description: 'Auth events by kind' });

/** Thrown for the concurrent-tab case so the controller keeps the (newer) cookie. */
export class RefreshRaceError extends ProblemError {
  constructor() {
    super('unauthorized', 'Session was refreshed in another tab; retry');
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest();

export interface IssuedRefresh {
  token: string;
  expiresAt: Date;
  familyId: string;
}

export interface Rotated extends IssuedRefresh {
  userId: string;
  role: Role;
}

type RotateOutcome =
  | { kind: 'ok'; value: Rotated }
  | { kind: 'reused'; userId: string; familyId: string }
  | { kind: 'race' }
  | { kind: 'invalid' };

@Injectable()
export class TokensService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /** New refresh token; a new family unless one is given. Only the SHA-256 is stored (FR-AUTH-04). */
  async issue(
    userId: string,
    userAgent?: string,
    familyId: string = uuidv7(),
  ): Promise<IssuedRefresh> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await this.db.insert(refreshTokens).values({
      userId,
      familyId,
      tokenHash: hash(token),
      expiresAt,
      userAgent: userAgent?.slice(0, 256),
    });
    return { token, expiresAt, familyId };
  }

  /**
   * FR-AUTH-05. Rotates inside one transaction with the presented row locked, so two concurrent
   * refreshes cannot both succeed. Presenting an already-rotated token revokes the whole family.
   */
  async rotate(raw: string, userAgent?: string): Promise<Rotated> {
    const outcome = await this.db.transaction(async (tx): Promise<RotateOutcome> => {
      const [row] = await tx
        .select({ token: refreshTokens, role: users.role, deletedAt: users.deletedAt })
        .from(refreshTokens)
        .innerJoin(users, eq(users.id, refreshTokens.userId))
        .where(eq(refreshTokens.tokenHash, hash(raw)))
        .for('update', { of: refreshTokens });
      if (!row) return { kind: 'invalid' };
      const t = row.token;
      const now = new Date();

      if (t.revokedAt) {
        if (!t.replacedBy) return { kind: 'invalid' }; // revoked by logout or family revocation
        if (now.getTime() - t.revokedAt.getTime() <= ROTATION_GRACE_MS) return { kind: 'race' };
        await tx
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(and(eq(refreshTokens.familyId, t.familyId), isNull(refreshTokens.revokedAt)));
        return { kind: 'reused', userId: t.userId, familyId: t.familyId };
      }
      if (t.expiresAt <= now || row.deletedAt) return { kind: 'invalid' };

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS);
      const id = uuidv7();
      await tx.insert(refreshTokens).values({
        id,
        userId: t.userId,
        familyId: t.familyId,
        tokenHash: hash(token),
        expiresAt,
        userAgent: userAgent?.slice(0, 256),
      });
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now, replacedBy: id })
        .where(eq(refreshTokens.id, t.id));
      return {
        kind: 'ok',
        value: { token, expiresAt, familyId: t.familyId, userId: t.userId, role: row.role },
      };
    });

    switch (outcome.kind) {
      case 'ok':
        authEvents.add(1, { event: 'refresh' });
        return outcome.value;
      case 'reused':
        // The revocation above is committed before we answer.
        authEvents.add(1, { event: 'reuse_detected' });
        this.log.warn(
          { userId: outcome.userId, familyId: outcome.familyId },
          'refresh token reuse: family revoked',
        );
        throw new ProblemError(
          'token-reused',
          'This session was ended for your safety. Sign in again.',
        );
      case 'race':
        throw new RefreshRaceError();
      case 'invalid':
        throw new ProblemError('unauthorized', 'Session expired. Sign in again.');
    }
  }

  /** Ends the session the presented refresh token belongs to; unknown tokens are ignored. */
  async revokeByToken(raw: string): Promise<void> {
    const [row] = await this.db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash(raw)));
    if (row) await this.revokeFamily(row.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  /** FR-AUTH-08: sign out everywhere. */
  async revokeAll(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}
