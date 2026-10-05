import { boolean, integer, jsonb, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns';
import { reviewStatus } from './enums';
import { users } from './identity';
import { problems } from './problems';
import { submissions } from './judging';
import { contests } from './contests';

export const hintRequests = pgTable('hint_requests', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  problemId: uuid('problem_id')
    .notNull()
    .references(() => problems.id),
  level: smallint('level').notNull(),
  submissionId: uuid('submission_id').references(() => submissions.id),
  promptVersion: text('prompt_version'),
  models: jsonb('models'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  response: text('response'),
  leakFlag: boolean('leak_flag').notNull().default(false),
  blockedReason: text('blocked_reason'),
  helpful: boolean('helpful'),
  createdAt: createdAt(),
});

export const reviews = pgTable('reviews', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  contestId: uuid('contest_id')
    .notNull()
    .references(() => contests.id),
  problemId: uuid('problem_id')
    .notNull()
    .references(() => problems.id),
  submissionId: uuid('submission_id')
    .notNull()
    .unique()
    .references(() => submissions.id),
  status: reviewStatus('status').notNull().default('pending'),
  contentMd: text('content_md'),
  promptVersion: text('prompt_version'),
  model: text('model'),
  tokens: integer('tokens'),
  createdAt: createdAt(),
  readyAt: ts('ready_at'),
});
