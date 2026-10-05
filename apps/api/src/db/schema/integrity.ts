import {
  bigserial,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns';
import { decisionKind, runStatus, signalKind } from './enums';
import { users } from './identity';
import { problems } from './problems';
import { contests } from './contests';

export const plagRuns = pgTable('plag_runs', {
  id: id(),
  contestId: uuid('contest_id')
    .notNull()
    .references(() => contests.id),
  params: jsonb('params'),
  status: runStatus('status').notNull().default('queued'),
  metrics: jsonb('metrics'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
});

export const plagPairs = pgTable(
  'plag_pairs',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => plagRuns.id),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    subA: uuid('sub_a').notNull(),
    subB: uuid('sub_b').notNull(),
    fpScore: real('fp_score'),
    embScore: real('emb_score'),
    combined: real('combined').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.subA, t.subB] })],
);

export const plagClusters = pgTable('plag_clusters', {
  id: id(),
  runId: uuid('run_id')
    .notNull()
    .references(() => plagRuns.id),
  problemId: uuid('problem_id')
    .notNull()
    .references(() => problems.id),
  submissionIds: uuid('submission_ids').array().notNull(),
  maxScore: real('max_score').notNull(),
});

export const reviewDecisions = pgTable('review_decisions', {
  id: id(),
  clusterId: uuid('cluster_id')
    .notNull()
    .references(() => plagClusters.id),
  decision: decisionKind('decision').notNull(),
  note: text('note').notNull(),
  reviewerId: uuid('reviewer_id')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

/** Purged 30 days after contest end (SD-§6.4). */
export const editorSignals = pgTable('editor_signals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  contestId: uuid('contest_id')
    .notNull()
    .references(() => contests.id),
  problemId: uuid('problem_id')
    .notNull()
    .references(() => problems.id),
  kind: signalKind('kind').notNull(),
  size: integer('size'),
  at: ts('at').notNull().defaultNow(),
});
