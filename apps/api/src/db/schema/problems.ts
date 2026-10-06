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
    testsCount: integer('tests_count').notNull().default(0),
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
