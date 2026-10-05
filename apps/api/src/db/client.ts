import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

/** Dev default matches docker-compose.yml; every other environment sets DATABASE_URL. */
export const DEV_DATABASE_URL = 'postgres://codearena:codearena-dev@localhost:5432/codearena';

export const databaseUrl = () => process.env.DATABASE_URL ?? DEV_DATABASE_URL;

export function connect(url: string = databaseUrl()) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Db = ReturnType<typeof connect>['db'];
