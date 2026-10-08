// The drills' local environment: the real API (from source), two real isolate workers, a throwaway Redis
// (append-only, like production) and a throwaway database on the Compose Postgres. Nothing of the dev
// database or the dev Redis is touched. Needs docker, isolate (scripts/setup-isolate-wsl.sh), go and node.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitUntil } from './lib.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const API_DIR = join(ROOT, 'apps/api');
const PG = { user: 'codearena', password: 'codearena-dev', host: 'localhost', port: 5432 };
const PROBLEM_SLUGS = ['sum-two-numbers', 'stair-climb', 'rainfall-totals'];

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const must = (r, what) => {
  if (r.status !== 0)
    throw new Error(`${what} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
  return r.stdout;
};

/** A port nothing listens on, so a leftover process can never answer for the API under test. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

export async function localEnv() {
  const port = await freePort();
  const tag = randomBytes(3).toString('hex');
  const tmp = mkdtempSync(join(tmpdir(), 'chaos-'));
  const redisName = `chaos-redis-${tag}`;
  const dbName = `chaos_${tag}`;
  const apiUrl = `http://localhost:${port}`;
  const procs = { api: null, workers: new Map() };
  // A fixed host port: a published random port changes on every restart, and the stack would dial a dead one.
  const redisPort = await freePort();
  const seedFile = join(tmp, 'seed.json');

  const dbUrl = `postgres://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${dbName}`;
  // The same signing key for every API start, or an API restart would end every session.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwt = {
    JWT_PRIVATE_KEY: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
      .replaceAll('\n', '\\n'),
    JWT_PUBLIC_KEY: publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString()
      .replaceAll('\n', '\\n'),
  };
  const redisUrl = () => `redis://127.0.0.1:${redisPort}`;
  const baseEnv = () => ({
    ...process.env,
    DATABASE_URL: dbUrl,
    REDIS_URL: redisUrl(),
    LOAD_TEST: 'on',
    LOG_LEVEL: 'warn',
  });
  const redisCli = (...args) =>
    must(run('docker', ['exec', redisName, 'redis-cli', ...args]), `redis-cli ${args[0]}`).trim();
  const cli = (args, input) =>
    run('node', ['--import', 'tsx', 'src/modules/load/load-cli.ts', ...args], {
      cwd: API_DIR,
      env: baseEnv(),
      input,
    });

  function startWorker(id, boxBase, core) {
    const log = join(tmp, `${id}.log`);
    const child = spawn(join(tmp, 'worker'), [], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        REDIS_URL: redisUrl(),
        S3_ENDPOINT: 'http://localhost:8333',
        S3_BUCKET: 'codearena',
        S3_ACCESS_KEY: 'codearena',
        S3_SECRET_KEY: 'codearena-dev',
        WORKER_ID: id,
        WORKER_LANES: 'contest,practice,rejudge',
        WORKER_CONCURRENCY: '1',
        WORKER_BOX_BASE: String(boxBase),
        WORKER_CORES: String(core),
        WORKER_CACHE_DIR: join(tmp, `cache-${id}`),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => undefined);
    void log;
    procs.workers.set(id, { child, boxBase, core, pid: child.pid });
  }
  function startApi() {
    const child = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
      cwd: API_DIR,
      env: {
        ...baseEnv(),
        PORT: String(port),
        NODE_ENV: 'development',
        RATE_LIMIT_DEFAULT_PER_MIN: '100000',
        ...jwt,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => undefined);
    procs.api = child;
  }
  const alive = (child) => child && child.exitCode === null && child.signalCode === null;
  const waitReady = (ms = 90_000) =>
    waitUntil(
      async () =>
        (await fetch(`${apiUrl}/api/health/ready`, { signal: AbortSignal.timeout(2000) }))
          .status === 200,
      { timeoutMs: ms, everyMs: 500 },
    );

  const env = {
    name: 'local',
    apiUrl,

    async start() {
      for (const [cmd, args] of [
        ['docker', ['info']],
        ['go', ['version']],
        ['isolate', ['--version']],
      ]) {
        if (run(cmd, args).status !== 0) throw new Error(`${cmd} is needed for the local drills`);
      }
      must(
        run('docker', ['compose', 'up', '-d', '--wait', 'postgres', 's3'], { cwd: ROOT }),
        'docker compose up',
      );
      must(
        run('docker', [
          'run',
          '-d',
          '--name',
          redisName,
          '-p',
          `127.0.0.1:${redisPort}:6379`,
          'redis:7',
          'redis-server',
          '--appendonly',
          'yes',
        ]),
        'start redis',
      );
      await waitUntil(
        () => run('docker', ['exec', redisName, 'redis-cli', 'ping']).stdout.includes('PONG'),
        { timeoutMs: 20_000, everyMs: 200 },
      );
      must(
        run(
          'docker',
          [
            'compose',
            'exec',
            '-T',
            'postgres',
            'psql',
            '-U',
            PG.user,
            '-d',
            'codearena',
            '-c',
            `create database ${dbName}`,
          ],
          { cwd: ROOT },
        ),
        'create database',
      );
      must(
        run('pnpm', ['--filter', '@codearena/api', 'db:migrate'], { cwd: ROOT, env: baseEnv() }),
        'migrate',
      );
      must(
        run(
          'pnpm',
          [
            '--filter',
            '@codearena/api',
            'exec',
            'tsx',
            'src/modules/problems/import-cli.ts',
            '--publish',
            ...PROBLEM_SLUGS.map((s) => join(ROOT, 'problems', s)),
          ],
          { cwd: ROOT, env: baseEnv() },
        ),
        'import problems',
      );
      must(
        run('go', ['build', '-o', join(tmp, 'worker'), '.'], { cwd: join(ROOT, 'apps/worker') }),
        'build the worker',
      );
      startWorker('chaos-a', 700, 0);
      startWorker('chaos-b', 720, 1);
      startApi();
      const r = await waitReady();
      if (!r.ok) throw new Error('the API did not become ready');
    },

    async seed(users) {
      must(cli(['seed', '--users', String(users), '--out', seedFile]), 'seed');
      return JSON.parse(readFileSync(seedFile, 'utf8'));
    },
    async verify(slug, { expectJobsDlq = 0 } = {}) {
      const r = cli(['verify', slug, '--expect-jobs-dlq', String(expectJobsDlq)]);
      return JSON.parse(r.stdout);
    },
    async poison(slug, source) {
      return JSON.parse(must(cli(['poison', slug, '--source', '-'], source), 'poison'));
    },
    async repair(slug) {
      return JSON.parse(must(cli(['poison-repair', slug]), 'poison-repair'));
    },
    async cleanup() {
      cli(['cleanup']);
      // Dead letters a drill left behind must not leak into the next one (the groups and streams stay).
      redisCli('DEL', 'jobs:dlq', 'results:dlq');
      for (const [id, w] of procs.workers) {
        if (!alive(w.child)) startWorker(id, w.boxBase, w.core);
        else {
          try {
            process.kill(w.pid, 'SIGCONT');
          } catch {
            /* gone */
          }
        }
      }
      if (!alive(procs.api)) startApi();
      await waitReady();
    },

    // ---- faults -------------------------------------------------------------------------------
    /** The worker that holds a pending contest job right now, or any live one. */
    async killWorker() {
      const owner = (() => {
        try {
          return redisCli('XPENDING', 'jobs:contest', 'judges', '-', '+', '1').split('\n')[1] ?? '';
        } catch {
          return '';
        }
      })();
      const id = procs.workers.has(owner) ? owner : [...procs.workers.keys()][0];
      process.kill(procs.workers.get(id).pid, 'SIGKILL');
      return id;
    },
    async freezeJudge() {
      const id = [...procs.workers.keys()][0];
      process.kill(procs.workers.get(id).pid, 'SIGSTOP');
      env._frozen = id;
      return id;
    },
    async thawJudge(id) {
      // Past the takeover time (10 s) and the heartbeat expiry, then let it carry on.
      await sleep(25_000);
      const t0 = performance.now();
      process.kill(procs.workers.get(id).pid, 'SIGCONT');
      return performance.now() - t0;
    },
    async killApi() {
      procs.api.kill('SIGKILL');
      await sleep(3000); // what the restart policy would do: bring it back a few seconds later
      startApi();
    },
    async restartRedis({ hard }) {
      if (hard) {
        must(run('docker', ['kill', redisName]), 'kill redis');
        await sleep(1500);
        must(run('docker', ['start', redisName]), 'start redis');
      } else {
        must(run('docker', ['restart', redisName]), 'restart redis');
      }
    },

    async stop() {
      for (const w of procs.workers.values()) w.child.kill('SIGKILL');
      procs.api?.kill('SIGKILL');
      run('docker', ['rm', '-f', redisName]);
      run(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          PG.user,
          '-d',
          'codearena',
          '-c',
          `drop database if exists ${dbName} with (force)`,
        ],
        { cwd: ROOT },
      );
      try {
        run('chmod', ['-R', 'u+rwX', tmp]);
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* temp files */
      }
    },
  };
  void writeFileSync;
  return env;
}
