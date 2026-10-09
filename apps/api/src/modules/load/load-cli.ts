/**
 * O-03 load-test data, run next to the API (it needs the database):
 *
 *   LOAD_TEST=on tsx load-cli.ts seed --users 150 --out /tmp/load-seed.json   (--out - = stdout)
 *   LOAD_TEST=on tsx load-cli.ts report <contest-slug> [--out report.json]
 *   tsx load-cli.ts contest-report <contest-slug> [--out FILE]   (W-00: read-only numbers of any contest; no flag needed)
 *   LOAD_TEST=on tsx load-cli.ts verify <contest-slug> [--expect-jobs-dlq N]   (O-06: exits 1 if an invariant is broken)
 *   LOAD_TEST=on tsx load-cli.ts poison <contest-slug> --source - [--label C]   (O-06: a job that cannot run yet; source on stdin)
 *   LOAD_TEST=on tsx load-cli.ts poison-repair <contest-slug> [--label C]       (O-06: the testset its job names now exists)
 *   LOAD_TEST=on tsx load-cli.ts cleanup
 *
 * `LOAD_TEST=on` is required (the staging-only flag): it makes running this against the live
 * database a deliberate act. The seed file holds refresh tokens of fake users: keep it private
 * (written 0600) and delete it after the run. Reads DATABASE_URL from the environment.
 */
import { writeFileSync } from 'node:fs';
import pino from 'pino';
import { connect } from '../../db/client';
import { readFileSync } from 'node:fs';
import { S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { cleanupLoad, hasLoadData, reportLoad, seedLoad } from './load-test';
import { createPoison, removePoisonObjects, repairPoison } from './poison';
import { contestReport } from './contest-report';
import { verifyContest } from './verify';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const usage = () => {
  console.error(
    'usage: load-cli <seed --users N [--problems a,b,c] --out FILE|- | report SLUG [--out FILE] | contest-report SLUG [--out FILE] | verify SLUG [--expect-jobs-dlq N] | poison SLUG --source - | poison-repair SLUG | cleanup>',
  );
  process.exit(2);
};

// `contest-report` only reads, so it may run against the live database without the flag.
if (process.env.LOAD_TEST !== 'on' && cmd !== 'contest-report') {
  console.error('refused: set LOAD_TEST=on to run load-test commands');
  process.exit(1);
}

const { pool, db } = connect();
const objectStore = () =>
  new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'codearena',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'codearena-dev',
    },
  });
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
  } else if (cmd === 'contest-report') {
    const slug = rest[0];
    if (!slug) usage();
    const redis = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, {
          connectTimeout: 5000,
          maxRetriesPerRequest: 2,
          retryStrategy: () => null,
        })
      : null;
    redis?.on('error', () => undefined);
    try {
      const json = JSON.stringify(
        await contestReport(db, redis, slug!, { prefix: process.env.QUEUE_KEY_PREFIX ?? '' }),
        null,
        2,
      );
      const out = flag('out');
      if (out) writeFileSync(out, json);
      else console.log(json);
    } finally {
      redis?.disconnect();
    }
  } else if (cmd === 'verify') {
    const slug = rest[0];
    if (!slug) usage();
    // Reads Redis too (REDIS_URL, QUEUE_KEY_PREFIX): the results stream and the dead-letter streams.
    // Gives up quickly instead of waiting for a Redis that is not there: a drill must not hang on its own check.
    const redis = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, {
          connectTimeout: 5000,
          maxRetriesPerRequest: 2,
          retryStrategy: () => null,
        })
      : null;
    redis?.on('error', () => undefined);
    try {
      const v = await verifyContest(db, redis, slug!, {
        expectJobsDlq: Number(flag('expect-jobs-dlq') ?? 0),
        prefix: process.env.QUEUE_KEY_PREFIX ?? '',
      });
      console.log(JSON.stringify(v, null, 2));
      if (!v.ok) process.exitCode = 1;
    } finally {
      redis?.disconnect();
    }
  } else if (cmd === 'poison') {
    const slug = rest[0];
    if (!slug || flag('source') !== '-') usage();
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    redis.on('error', () => undefined);
    try {
      const out = await createPoison(db, redis, objectStore(), slug!, readFileSync(0, 'utf8'), {
        label: flag('label'),
        prefix: process.env.QUEUE_KEY_PREFIX ?? '',
      });
      console.log(JSON.stringify(out));
    } finally {
      redis.disconnect();
    }
  } else if (cmd === 'poison-repair') {
    const slug = rest[0];
    if (!slug) usage();
    const s3 = objectStore();
    console.log(JSON.stringify(await repairPoison(db, s3, slug!, { label: flag('label') })));
  } else if (cmd === 'cleanup') {
    const c = await cleanupLoad(db);
    let objects = 0;
    try {
      objects = await removePoisonObjects(
        objectStore(),
        process.env.S3_BUCKET_TESTS ?? 'codearena',
      );
    } catch {
      /* best effort: the objects are small and only under testsets/chaos-poison/lt-* */
    }
    console.log(
      `removed ${c.users} users, ${c.contests} contests, ${c.submissions} submissions` +
        (objects ? `, ${objects} poison object(s)` : ''),
    );
  } else usage();
} finally {
  await pool.end();
}
