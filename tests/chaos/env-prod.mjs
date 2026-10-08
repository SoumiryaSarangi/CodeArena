// The drills' production environment: ssh to the API VM and the judges, az for a judge VM. It only ever
// works on fake `lt-*` data (removed afterwards), refuses to start while a real contest is running, and
// puts back whatever a drill broke (API, Redis, judge) before it returns. Needs 2 judges
// (`scripts/scale-judges.sh up 1`), an ssh key for the deploy user and `az login`.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sleep, waitUntil } from './lib.mjs';

const HOST = process.env.API_SSH ?? 'codearena@40.83.75.34';
const KEY = process.env.API_SSH_KEY ?? join(homedir(), '.ssh', 'codearena_deploy');
const API = process.env.API_URL ?? 'https://api.40-83-75-34.sslip.io';
const RG = process.env.AZ_RG ?? 'rg-codearena-prod';
const JUDGES = (process.env.JUDGE_IPS ?? '10.20.2.4 10.20.2.5').split(' ');
const VM = (i) => `vm-codearena-prod-judge-${i}`;
const SSH_OPTS = ['-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15'];

const run = (cmd, args, input) => spawnSync(cmd, args, { encoding: 'utf8', input });
const must = (r, what) => {
  if (r.status !== 0)
    throw new Error(`${what} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  return r.stdout;
};
const ssh = (cmd, input) => run('ssh', [...SSH_OPTS, HOST, cmd], input);
const judge = (ip, cmd) => run('ssh', [...SSH_OPTS, '-J', HOST, `codearena@${ip}`, cmd]);
const compose = (args) =>
  `cd /opt/codearena && export API_IMAGE=$(cat state/current) && docker compose --env-file prod.env -f docker-compose.yml ${args}`;
const cli = (args, input) => ssh(compose(`--profile tools run --rm -T loadtest ${args}`), input);

const getJson = async (path) =>
  (await fetch(`${API}${path}`, { signal: AbortSignal.timeout(8000) })).json();
const judgesReporting = async () => {
  try {
    const s = await getJson('/api/status');
    const detail = s.components.find((c) => c.id === 'judges')?.detail ?? '';
    return Number(/^(\d+) judge/.exec(detail)?.[1] ?? 0);
  } catch {
    return 0;
  }
};
const ready = async () => {
  try {
    return (
      (await fetch(`${API}/api/health/ready`, { signal: AbortSignal.timeout(3000) })).status === 200
    );
  } catch {
    return false;
  }
};
const containerId = (service) => ssh(compose(`ps -q ${service}`)).stdout.trim();

export async function prodEnv({ minJudges = 2 } = {}) {
  let judgeCount = minJudges;
  const env = {
    name: 'production',
    apiUrl: API,

    /** Refuses to start unless it is safe: no real contest running and both judges reporting. */
    async start() {
      const list = await getJson('/api/contests');
      const real = list.items.filter((c) => c.state === 'running' && !c.slug.startsWith('lt-'));
      if (real.length > 0)
        throw new Error(
          `a real contest is running (${real.map((c) => c.slug).join(', ')}): not drilling`,
        );
      const n = await judgesReporting();
      if (n < minJudges) {
        throw new Error(
          `${n} judge(s) report; these drills need ${minJudges} (run scripts/scale-judges.sh up 1 first)`,
        );
      }
      judgeCount = n;
      if (run('az', ['account', 'show']).status !== 0) throw new Error('az is not logged in');
    },

    async seed(users) {
      await env.start(); // checked again before every scenario
      return JSON.parse(must(cli(`seed --users ${users} --out -`), 'seed'));
    },
    async verify(slug, { expectJobsDlq = 0 } = {}) {
      return JSON.parse(cli(`verify ${slug} --expect-jobs-dlq ${expectJobsDlq}`).stdout);
    },
    async poison(slug, source) {
      return JSON.parse(must(cli(`poison ${slug} --source -`, source), 'poison'));
    },
    async repair(slug) {
      return JSON.parse(must(cli(`poison-repair ${slug}`), 'poison-repair'));
    },
    /** Removes the fake data and puts back everything a drill may have stopped. */
    async cleanup() {
      must(cli('cleanup'), 'cleanup');
      ssh(
        compose(
          'exec -T redis sh -c \'redis-cli --user admin --pass "$REDIS_ADMIN_PASSWORD" --no-auth-warning DEL jobs:dlq results:dlq\'',
        ),
      );
      if (!(await ready())) {
        ssh(compose('up -d redis api'));
        await waitUntil(ready, { timeoutMs: 90_000, everyMs: 1000 });
      }
      for (let i = 0; i < judgeCount; i++) {
        const state = run('az', [
          'vm',
          'get-instance-view',
          '-g',
          RG,
          '-n',
          VM(i),
          '--query',
          'instanceView.statuses[1].displayStatus',
          '-o',
          'tsv',
        ]).stdout.trim();
        if (state !== 'VM running') run('az', ['vm', 'start', '-g', RG, '-n', VM(i), '-o', 'none']);
        judge(
          JUDGES[i],
          'systemctl is-active codearena-worker || sudo systemctl start codearena-worker',
        );
      }
      await waitUntil(async () => (await judgesReporting()) >= judgeCount, {
        timeoutMs: 180_000,
        everyMs: 3000,
      });
    },

    // ---- faults -------------------------------------------------------------------------------
    async killWorker() {
      must(judge(JUDGES[0], 'sudo systemctl kill -s SIGKILL codearena-worker'), 'kill the worker');
      return VM(0);
    },
    /** The judge VM stops (deallocated: no heartbeat, no lease refresh). */
    async freezeJudge() {
      must(run('az', ['vm', 'deallocate', '-g', RG, '-n', VM(1), '--no-wait']), 'deallocate');
      return VM(1);
    },
    /** Starts it again and returns how long it took until the judge reports to the queue. */
    async thawJudge(id) {
      await waitUntil(
        () =>
          run('az', [
            'vm',
            'get-instance-view',
            '-g',
            RG,
            '-n',
            id,
            '--query',
            'instanceView.statuses[1].displayStatus',
            '-o',
            'tsv',
          ]).stdout.trim() === 'VM deallocated',
        { timeoutMs: 300_000, everyMs: 5000 },
      );
      const t0 = performance.now();
      must(run('az', ['vm', 'start', '-g', RG, '-n', id, '-o', 'none']), 'start the VM');
      const up = await waitUntil(async () => (await judgesReporting()) >= judgeCount, {
        timeoutMs: 300_000,
        everyMs: 3000,
      });
      if (!up.ok) throw new Error('the judge did not report again after the VM started');
      return performance.now() - t0;
    },
    async killApi() {
      // A crash, not `docker kill`: Docker treats a manual kill as a stop and never restarts the container
      // (measured: still down after 90 s), while a process that dies is restarted by `unless-stopped`.
      must(
        ssh(`sudo -n kill -9 $(docker inspect -f '{{.State.Pid}}' ${containerId('api')})`),
        'kill the API process',
      );
      // If it does not come back within 30 s, do what an operator would.
      const up = await waitUntil(ready, { timeoutMs: 30_000, everyMs: 500 });
      if (!up.ok) ssh(compose('up -d api'));
    },
    async restartRedis({ hard }) {
      const id = containerId('redis');
      if (hard) {
        ssh(`docker kill ${id}`);
        await sleep(5000);
        const running =
          ssh(`docker inspect -f '{{.State.Running}}' ${id}`).stdout.trim() === 'true';
        if (!running) ssh(compose('up -d redis'));
      } else {
        must(ssh(`docker restart ${id}`), 'restart redis');
      }
    },
  };
  return env;
}
