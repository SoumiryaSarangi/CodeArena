import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { desc } from 'drizzle-orm';
import { createdAt, id, ts } from './columns';
import { lane, runReason, runStatus, submissionStatus, verdict } from './enums';
import { users } from './identity';
import { problemVersions } from './problems';
import { contests } from './contests';
import { rooms } from './pad';

export const submissions = pgTable(
  'submissions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    problemVersionId: uuid('problem_version_id')
      .notNull()
      .references(() => problemVersions.id),
    contestId: uuid('contest_id').references(() => contests.id),
    language: text('language').notNull(),
    source: text('source').notNull(),
    sourceBytes: integer('source_bytes').notNull(),
    lane: lane('lane').notNull(),
    status: submissionStatus('status').notNull().default('queued'),
    verdict: verdict('verdict'),
    timeMs: integer('time_ms'),
    memKb: integer('mem_kb'),
    failedTest: integer('failed_test'),
    currentRunVersion: integer('current_run_version').notNull().default(1),
    contestMinute: integer('contest_minute'),
    afterFreeze: boolean('after_freeze').notNull().default(false),
    disqualified: boolean('disqualified').notNull().default(false),
    createdAt: createdAt(),
    judgedAt: ts('judged_at'),
  },
  (t) => [
    index('submissions_user_created_idx').on(t.userId, desc(t.createdAt)),
    index().on(t.contestId, t.createdAt),
    index().on(t.problemVersionId, t.verdict),
  ],
);

export const judgeRuns = pgTable(
  'judge_runs',
  {
    id: id(),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id),
    runVersion: integer('run_version').notNull(),
    reason: runReason('reason').notNull().default('initial'),
    workerId: text('worker_id'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    verdict: verdict('verdict'),
    timeMs: integer('time_ms'),
    memKb: integer('mem_kb'),
    compileLog: text('compile_log'),
    /** When each phase began, from the worker's progress events: `{steps: [{phase, at (epoch ms)}]}` (US-3.3). */
    journey: jsonb('journey'),
  },
  // FR-QUEUE-06: idempotent result processing hangs on this constraint.
  (t) => [unique('judge_runs_submission_run_version_uq').on(t.submissionId, t.runVersion)],
);

export const testResults = pgTable(
  'test_results',
  {
    judgeRunId: uuid('judge_run_id')
      .notNull()
      .references(() => judgeRuns.id),
    testNo: integer('test_no').notNull(),
    verdict: verdict('verdict').notNull(),
    timeMs: integer('time_ms'),
    memKb: integer('mem_kb'),
    checkerMsg: varchar('checker_msg', { length: 256 }),
  },
  (t) => [primaryKey({ columns: [t.judgeRunId, t.testNo] })],
);

export const customRuns = pgTable('custom_runs', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  roomId: uuid('room_id').references(() => rooms.id),
  problemVersionId: uuid('problem_version_id').references(() => problemVersions.id),
  language: text('language').notNull(),
  source: text('source').notNull(),
  input: text('input'),
  status: runStatus('status').notNull().default('queued'),
  result: jsonb('result'),
  createdAt: createdAt(),
});
