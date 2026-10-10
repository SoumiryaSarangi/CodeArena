import { Inject, Injectable } from '@nestjs/common';
import {
  HANDLE_RE,
  RESERVED_HANDLES,
  type HandleAvailability,
  type Me,
  type PatchMe,
} from '@codearena/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { DB, type Db } from '../../db/db.module';
import { adminGrants, oauthAccounts, setterGrants, users } from '../../db/schema';

export interface OAuthProfile {
  provider: 'google' | 'github';
  providerUserId: string;
  /** Always verified: providers refuse unverified addresses before this point. */
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

const RESERVED = new Set<string>(RESERVED_HANDLES);

const isUniqueViolation = (e: unknown, constraint: string) => {
  const cause =
    (e as { cause?: { code?: string; constraint?: string } }).cause ??
    (e as { code?: string; constraint?: string });
  return cause?.code === '23505' && cause.constraint === constraint;
};

const toMe = (u: typeof users.$inferSelect, isOwner: boolean): Me => ({
  id: u.id,
  handle: u.handle,
  name: u.name,
  email: u.email,
  avatarUrl: u.avatarUrl,
  role: u.role,
  rating: u.rating,
  defaultLanguage: (u.defaultLanguage as Me['defaultLanguage']) ?? null,
  isOwner,
});

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** FR-AUTH-12: the server's OWNER_EMAIL account (case-insensitive). Unset: nobody is owner. */
  isOwnerEmail(email: string): boolean {
    const owner = this.config.OWNER_EMAIL;
    return !!owner && owner.toLowerCase() === email.toLowerCase();
  }

  private meOf(u: typeof users.$inferSelect): Me {
    return toMe(u, this.isOwnerEmail(u.email));
  }

  /**
   * Login: existing provider identity → its user; else a user with the same (verified) email gets
   * this identity linked; else a new user without a handle (FR-AUTH-02). Deleted users cannot log in.
   */
  async upsertFromOAuth(p: OAuthProfile): Promise<typeof users.$inferSelect> {
    return this.db.transaction(async (tx) => {
      const [linked] = await tx
        .select({ user: users })
        .from(oauthAccounts)
        .innerJoin(users, eq(users.id, oauthAccounts.userId))
        .where(
          and(
            eq(oauthAccounts.provider, p.provider),
            eq(oauthAccounts.providerUserId, p.providerUserId),
          ),
        );
      let user = linked?.user;

      if (!user) {
        [user] = await tx.select().from(users).where(eq(users.email, p.email));
        if (!user) {
          [user] = await tx
            .insert(users)
            .values({ email: p.email, name: p.name, avatarUrl: p.avatarUrl })
            .onConflictDoNothing({ target: users.email })
            .returning();
          // Lost a race with a concurrent first login for the same email: use that row.
          if (!user) [user] = await tx.select().from(users).where(eq(users.email, p.email));
        }
        if (!user) throw new Error('user upsert failed');
        await tx
          .insert(oauthAccounts)
          .values({ userId: user.id, provider: p.provider, providerUserId: p.providerUserId })
          .onConflictDoNothing();
      }
      if (user.deletedAt) throw new ProblemError('forbidden', 'This account has been deleted');
      // FR-AUTH-12: the owner and every listed address are admin from sign-in on. This only ever
      // raises a role; removing a grant lowers it (AdminGrantsService).
      if (user.role !== 'admin') {
        const [granted] = this.isOwnerEmail(user.email)
          ? [true]
          : await tx
              .select({ email: adminGrants.email })
              .from(adminGrants)
              .where(eq(adminGrants.email, user.email));
        if (granted) {
          [user] = await tx
            .update(users)
            .set({ role: 'admin' })
            .where(eq(users.id, user.id))
            .returning();
        }
      }
      // FR-AUTH-15: a listed setter address is a setter from sign-in on (never lowers an admin).
      if (user?.role === 'user') {
        const [listed] = await tx
          .select({ email: setterGrants.email })
          .from(setterGrants)
          .where(eq(setterGrants.email, user.email));
        if (listed) {
          [user] = await tx
            .update(users)
            .set({ role: 'setter' })
            .where(eq(users.id, user.id))
            .returning();
        }
      }
      return user!;
    });
  }

  async me(userId: string): Promise<Me> {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u || u.deletedAt) throw new ProblemError('unauthorized');
    return this.meOf(u);
  }

  async hasHandle(userId: string): Promise<boolean> {
    const [u] = await this.db
      .select({ handle: users.handle })
      .from(users)
      .where(eq(users.id, userId));
    return Boolean(u?.handle);
  }

  /** FR-AUTH-03. Uniqueness is case-insensitive because the column is citext. */
  async handleAvailability(handle: string): Promise<HandleAvailability> {
    if (!HANDLE_RE.test(handle)) return { available: false, reason: 'invalid' };
    if (RESERVED.has(handle.toLowerCase())) return { available: false, reason: 'reserved' };
    const [taken] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle));
    return taken ? { available: false, reason: 'taken' } : { available: true };
  }

  async update(userId: string, patch: PatchMe): Promise<Me> {
    if (patch.handle !== undefined && RESERVED.has(patch.handle.toLowerCase())) {
      throw new ProblemError('validation', 'That handle is reserved', {
        errors: [{ path: 'handle', message: 'That handle is reserved.' }],
      });
    }
    try {
      const [u] = await this.db
        .update(users)
        .set({
          ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
          ...(patch.defaultLanguage !== undefined
            ? { defaultLanguage: patch.defaultLanguage }
            : {}),
        })
        .where(and(eq(users.id, userId), sql`${users.deletedAt} is null`))
        .returning();
      if (!u) throw new ProblemError('unauthorized');
      return this.meOf(u);
    } catch (e) {
      if (isUniqueViolation(e, 'users_handle_unique'))
        throw new ProblemError('handle-taken', 'That handle is taken');
      throw e;
    }
  }
}
