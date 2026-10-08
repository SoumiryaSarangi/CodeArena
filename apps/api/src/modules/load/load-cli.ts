/**
 * O-03 load-test data, run next to the API (it needs the database):
 *
 *   LOAD_TEST=on tsx load-cli.ts seed --users 150 --out /tmp/load-seed.json   (--out - = stdout)
 *   LOAD_TEST=on tsx load-cli.ts report <contest-slug> [--out report.json]
 *   LOAD_TEST=on tsx load-cli.ts cleanup
 *
 * `LOAD_TEST=on` is required (the staging-only flag): it makes running this against the live
 * database a deliberate act. The seed file holds refresh tokens of fake users: keep it private
 * (written 0600) and delete it after the run. Reads DATABASE_URL from the environment.
 */
import { writeFileSync } from 'node:fs';
import pino from 'pino';
import { connect } from '../../db/client';
import { cleanupLoad, hasLoadData, reportLoad, seedLoad } from './load-test';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const usage = () => {
  console.error(
    'usage: load-cli <seed --users N [--problems a,b,c] --out FILE|- | report SLUG [--out FILE] | cleanup>',
  );
  process.exit(2);
};

if (process.env.LOAD_TEST !== 'on') {
  console.error('refused: set LOAD_TEST=on to run load-test commands');
  process.exit(1);
}

const { pool, db } = connect();
const log = pino({ level: 'silent' });
try {
  if (cmd === 'seed') {
    const count = Number(flag('users') ?? 150);
    const out = flag('out');
    if (!out || !Number.isInteger(count) || count < 1 || count > 2000) usage();
    if (await hasLoadData(db)) {
      console.error('load-test data already exists: run `cleanup` first');
      process.exit(1);
    }
    const seed = await seedLoad(db, log, {
      count,
      problems: flag('problems')?.split(','),
    });
    // `--out -` writes the JSON to stdout (for `docker compose run -T … > file` on a server).
    if (out === '-') process.stdout.write(JSON.stringify(seed));
    else writeFileSync(out!, JSON.stringify(seed), { mode: 0o600 });
    console.error(`seeded ${count} users in contest ${seed.contest.slug} → ${out}`);
  } else if (cmd === 'report') {
    const slug = rest[0];
    if (!slug) usage();
    const json = JSON.stringify(await reportLoad(db, slug!), null, 2);
    const out = flag('out');
    if (out) writeFileSync(out, json);
    else console.log(json);
  } else if (cmd === 'cleanup') {
    const c = await cleanupLoad(db);
    console.log(`removed ${c.users} users, ${c.contests} contests, ${c.submissions} submissions`);
  } else usage();
} finally {
  await pool.end();
}
