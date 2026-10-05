import { index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, citext, createdAt, id, ts } from './columns';
import { oauthProvider, userRole } from './enums';

export const users = pgTable('users', {
  id: id(),
  // Null until the user picks one on onboarding (FR-AUTH-02).
  handle: citext('handle').unique(),
  name: text('name'),
  email: citext('email').notNull().unique(),
  avatarUrl: text('avatar_url'),
  role: userRole('role').notNull().default('user'),
  rating: integer('rating').notNull().default(1400),
  defaultLanguage: text('default_language'),
  createdAt: createdAt(),
  deletedAt: ts('deleted_at'),
});

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: oauthProvider('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
  },
  (t) => [unique().on(t.provider, t.providerUserId)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    replacedBy: uuid('replaced_by'),
    userAgent: text('user_agent'),
  },
  (t) => [index().on(t.userId), index().on(t.familyId)],
);
