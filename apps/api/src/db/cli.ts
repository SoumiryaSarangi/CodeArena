import { sql } from 'drizzle-orm';
import { connect, databaseUrl } from './client';
import { runMigrations } from './migrate';
import { seed } from './seed';

const commands = ['migrate', 'seed', 'reset'] as const;
const cmd = process.argv[2];
if (!commands.includes(cmd as (typeof commands)[number])) {
  console.error(`usage: db <${commands.join('|')}>`);
  process.exit(2);
}

const url = databaseUrl();
if (cmd === 'reset') {
  // reset drops everything: only ever against a local database.
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`db reset refused: ${host} is not a local database`);
    process.exit(1);
  }
}

const { pool, db } = connect(url);
try {
  if (cmd === 'reset') {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
  }
  if (cmd !== 'seed') await runMigrations(db);
  if (cmd !== 'migrate') await seed(db);
  console.log(`db ${cmd}: ok`);
} finally {
  await pool.end();
}
