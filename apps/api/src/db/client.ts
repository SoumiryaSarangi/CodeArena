import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

/** Dev default matches docker-compose.yml; every other environment sets DATABASE_URL. */
export const DEV_DATABASE_URL = 'postgres://codearena:codearena-dev@localhost:5432/codearena';

export const databaseUrl = () => process.env.DATABASE_URL ?? DEV_DATABASE_URL;

/**
 * `onIdleError` hears about a connection that died while it sat unused in the pool (a database restart, a dropped
 * network). node-postgres removes that client and the next query opens a new one, but it reports the failure as an
 * `error` event on the pool, and an event with no listener is an uncaught exception: without this the API process
 * would crash on a Postgres restart. The default is to say nothing (tests, scripts); the API passes its logger.
 */
export function connect(url: string = databaseUrl(), onIdleError: (e: Error) => void = () => {}) {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', onIdleError);
  return { pool, db: drizzle(pool, { schema }) };
}

export type Db = ReturnType<typeof connect>['db'];
