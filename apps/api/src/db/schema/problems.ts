import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns';
import { problemVisibility, runStatus, validationStatus, verdict } from './enums';
import { users } from './identity';

export const problems = pgTable('problems', {
  id: id(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  difficulty: integer('difficulty').notNull(),
  visibility: problemVisibility('visibility').notNull().default('private'),
  // Points at problem_versions.id; no FK because the two tables reference each other.
  currentVersionId: uuid('current_version_id'),
  authorId: uuid('author_id').references(() => users.id),
  practicePoints: integer('practice_points'),
  createdAt: createdAt(),
});

export const problemVersions = pgTable(
  'problem_versions',
  {
    id: id(),
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    version: integer('version').notNull(),
    statementMd: text('statement_md').notNull(),
    editorialMd: text('editorial_md'),
    /** `{timeMs, memMb, outputKb, wallMultiplier}` */
    limits: jsonb('limits').notNull(),
    /** `{kind: 'exact'|'tokens'|'float'|'testlib', eps?, sourceUri?}` */
    checker: jsonb('checker').notNull(),
    testsetHash: text('testset_hash'),
    testsetUri: text('testset_uri'),
    /** `s3://<bucket>/validators/<sha256>.cpp`: the testlib validator, run on every input by a validation run (FR-PROB-04). Null for versions imported before UI-04. */
    validatorUri: text('validator_uri'),
    testsCount: integer('tests_count').notNull().default(0),
    /** AI-02: `{"1": [terms], "2": [terms]}`: words a hint of that level or lower must not use (setter-defined). */
    avoidSet: jsonb('avoid_set').notNull().default({}),
    samples: jsonb('samples').notNull().default([]),
    validationStatus: validationStatus('validation_status').notNull().default('pending'),
    validatedAt: ts('validated_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.problemId, t.version)],
);

export const problemTags = pgTable(
  'problem_tags',
  {
    problemId: uuid('problem_id')
      .notNull()
      .references(() => problems.id),
    tag: text('tag').notNull(),
  },
  (t) => [primaryKey({ columns: [t.problemId, t.tag] })],
);

export const packageSolutions = pgTable('package_solutions', {
  id: id(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => problemVersions.id),
  name: text('name').notNull(),
  language: text('language').notNull(),
  expectedVerdict: verdict('expected_verdict').notNull(),
  sourceUri: text('source_uri').notNull(),
});

export const validationRuns = pgTable(
  'validation_runs',
  {
    id: id(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => problemVersions.id),
    status: runStatus('status').notNull().default('queued'),
    results: jsonb('results'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index().on(t.versionId)],
);

/**
 * One judge job of a validation run (UI-04): a package solution, or the validator. `id` is the
 * `submissionId` of the job sent to the judge, so the results consumer finds the item from the
 * result alone (same idea as `custom_runs`). Only a `queued` item can be completed.
 */
export const validationItems = pgTable(
  'validation_items',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => validationRuns.id),
    /** `solution` or `validator`. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    language: text('language').notNull(),
    expectedVerdict: verdict('expected_verdict'),
    status: runStatus('status').notNull().default('queued'),
    /** `{verdict, timeMs, memKb, tests, compileLog?, message?, workerId?}` once done. */
    result: jsonb('result'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index().on(t.runId)],
);
