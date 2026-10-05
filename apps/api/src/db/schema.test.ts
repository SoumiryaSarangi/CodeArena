import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, databaseUrl, type Db } from './client';
import { runMigrations } from './migrate';
import { seed } from './seed';
import { judgeRuns, problems, submissions, users } from './schema';

// Uses the compose Postgres (pnpm dev stack). A throwaway database is created per run.
const adminUrl = databaseUrl();
const reachable = await new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1500 })
  .connect()
  .then(() => true)
  .catch(() => false);

describe.skipIf(!reachable)('F-04: database schema', () => {
  const name = `test_${randomBytes(6).toString('hex')}`;
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const conn = connect(url.toString());
    db = conn.db;
    close = () => conn.pool.end();
    await runMigrations(db);
  });

  afterAll(async () => {
    await close();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  });

  it('F-04: migrations apply from empty and create every §6.2 table', async () => {
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(Number(rows.rows[0]!.n)).toBe(37);
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
