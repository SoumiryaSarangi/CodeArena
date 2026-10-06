/**
 * Throwaway-database helper for tests/chaos/kill-worker.sh (CHAOS_POSTGRES=1):
 *   create            -> prints {"url","userId"} of a new migrated database
 *   seed <url> <userId> <id>   -> inserts a waiting custom run with that id
 *   status <url> <id> -> prints {"status","verdict"} of that custom run
 *   drop <url>        -> drops the database
 */
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { connect } from '../../db/client';
import { customRuns, users } from '../../db/schema';
import { adminUrl, createTestDatabase } from '../../test/db';

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'create': {
      const t = await createTestDatabase(); // never dropped here: `drop` does it
      const [u] = await t.db.insert(users).values({ email: 'chaos@example.com' }).returning();
      console.log(JSON.stringify({ url: t.url, userId: u!.id }));
      break;
    }
    case 'seed': {
      const [url, userId, id] = args;
      const { pool, db } = connect(url);
      await db
        .insert(customRuns)
        .values({ id, userId: userId!, language: 'c', source: 'x', input: '' });
      await pool.end();
      break;
    }
    case 'status': {
      const [url, id] = args;
      const { pool, db } = connect(url);
      const [row] = await db.select().from(customRuns).where(eq(customRuns.id, id!));
      console.log(
        JSON.stringify({
          status: row?.status,
          verdict: (row?.result as { verdict?: string } | null)?.verdict ?? null,
        }),
      );
      await pool.end();
      break;
    }
    case 'drop': {
      const name = new URL(args[0]!).pathname.slice(1);
      if (!/^test_[0-9a-f]+$/.test(name)) throw new Error(`refusing to drop ${name}`);
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
      break;
    }
    default:
      throw new Error(
        'usage: chaos-db.ts create | seed <url> <userId> <id> | status <url> <id> | drop <url>',
      );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
