import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connect, databaseUrl, type Db } from '../db/client';
import { runMigrations } from '../db/migrate';

export const adminUrl = databaseUrl();

export const postgresReachable = () =>
  new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1500 })
    .connect()
    .then(() => true)
    .catch(() => false);

/** A migrated throwaway database on the Compose Postgres; `drop()` removes it. */
export async function createTestDatabase(): Promise<{
  url: string;
  db: Db;
  drop: () => Promise<void>;
}> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const conn = connect(url.toString());
  await runMigrations(conn.db);
  return {
    url: url.toString(),
    db: conn.db,
    drop: async () => {
      await conn.pool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
