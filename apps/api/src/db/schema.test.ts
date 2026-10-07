import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresReachable } from '../test/db';
import type { Db } from './client';
import { seed } from './seed';
import { judgeRuns, problems, submissions, users } from './schema';

// Uses the compose Postgres (pnpm dev stack). A throwaway database is created per run.
const reachable = await postgresReachable();

// In CI the stack must be up: an unreachable database is a failure, not a skip.
if (process.env.CI && !reachable) throw new Error('CI requires the dev stack (scripts/dev-up.sh)');

describe.skipIf(!reachable)('F-04: database schema', () => {
  let db: Db;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ db, drop } = await createTestDatabase());
  });

  afterAll(() => drop());

  it('F-04: migrations apply from empty and create every §6.2 table (+ validation_items, UI-04)', async () => {
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(Number(rows.rows[0]!.n)).toBe(38);
  });

  it('F-04: seed runs and is idempotent', async () => {
    await seed(db);
    await seed(db);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(problems)).toHaveLength(3);
  });

  it('FR-QUEUE-06: (submission_id, run_version) is unique on judge_runs', async () => {
    const [user] = await db.select().from(users);
    const [problem] = await db.select().from(problems);
    const versionRows = await db.execute<{ id: string }>(
      sql`select id from problem_versions limit 1`,
    );
    const [sub] = await db
      .insert(submissions)
      .values({
        userId: user!.id,
        problemVersionId: versionRows.rows[0]!.id,
        language: 'cpp17',
        source: 'int main(){}',
        sourceBytes: 12,
        lane: 'practice',
      })
      .returning();
    expect(problem).toBeDefined();
    await db.insert(judgeRuns).values({ submissionId: sub!.id, runVersion: 1 });
    const dup = await db
      .insert(judgeRuns)
      .values({ submissionId: sub!.id, runVersion: 1 })
      .then(
        () => null,
        (e: { cause?: { constraint?: string } }) => e,
      );
    expect(dup?.cause?.constraint).toBe('judge_runs_submission_run_version_uq');
    await db.insert(judgeRuns).values({ submissionId: sub!.id, runVersion: 2, reason: 'rejudge' });
  });
});
