import {
  boolean,
  char,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns';
import { contestStatus } from './enums';
import { users } from './identity';
import { problems, problemVersions } from './problems';

export const contests = pgTable('contests', {
  id: id(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  /** Shown on the contest page (Markdown-free plain text). */
  description: text('description').notNull().default(''),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  freezeAt: ts('freeze_at'),
  /** `{penaltyMinutes, ceCountsAsAttempt, langMultipliers, rated, lateRegistration}` */
  rules: jsonb('rules').notNull(),
  status: contestStatus('status').notNull().default('draft'),
  createdBy: uuid('created_by').references(() => users.id),
  finalizedAt: ts('finalized_at'),
});

export const contestProblems = pgTable(
  'contest_problems',
  {
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id),
    label: char('label', { length: 1 }).notNull(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => problemVersions.id),
    position: integer('position').notNull(),
    /** Pulled from the contest (C-07): not shown, not accepted, not on the board. */
    hidden: boolean('hidden').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.contestId, t.label] })],
);

export const participants = pgTable(
  'participants',
  {
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    registeredAt: ts('registered_at').notNull().defaultNow(),
    finalRank: integer('final_rank'),
    /** Exam mode (C-10): the participant ended their test (`self`) or it ended for them (`left-window`). */
    finishedAt: ts('finished_at'),
    finishReason: text('finish_reason'),
    /** Times the window was left while the test ran; the third finishes it. */
    leaveCount: integer('leave_count').notNull().default(0),
    lastLeaveAt: ts('last_leave_at'),
  },
  (t) => [primaryKey({ columns: [t.contestId, t.userId] })],
);

export const clarifications = pgTable('clarifications', {
  id: id(),
  contestId: uuid('contest_id')
    .notNull()
    .references(() => contests.id),
  problemLabel: char('problem_label', { length: 1 }),
  askerId: uuid('asker_id')
    .notNull()
    .references(() => users.id),
  question: text('question').notNull(),
  answer: text('answer'),
  answeredBy: uuid('answered_by').references(() => users.id),
  isPublic: boolean('is_public').notNull().default(false),
  createdAt: createdAt(),
  answeredAt: ts('answered_at'),
});

export const announcements = pgTable('announcements', {
  id: id(),
  contestId: uuid('contest_id')
    .notNull()
    .references(() => contests.id),
  body: text('body').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
});

export const ratingChanges = pgTable(
  'rating_changes',
  {
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    oldRating: integer('old_rating').notNull(),
    newRating: integer('new_rating').notNull(),
    delta: integer('delta').notNull(),
    seed: numeric('seed'),
    rank: integer('rank').notNull(),
  },
  (t) => [primaryKey({ columns: [t.contestId, t.userId] })],
);
