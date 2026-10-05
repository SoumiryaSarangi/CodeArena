import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export const runMigrations = (db: Db) => migrate(db, { migrationsFolder });
