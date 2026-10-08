#!/usr/bin/env node
// O-03 burst driver: 500 submissions in 2 minutes while 200 browsers watch the contest board.
//
//   node tests/load/burst.mjs run   --api https://api.… --seed seed.json --judges 1 --out run-1.json
//   node tests/load/burst.mjs watch --api https://api.… --seed seed.json --out scale.json
//
// `seed.json` comes from `load-cli seed` (fake users with refresh tokens). Server-side numbers
// (queue wait, time to verdict, service time) come from `load-cli report`; this script records
// what a client sees: accept latency, rejections, SSE connections and events, queue depth over time.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPool, pick, rng, schedule, summarize, userOrder } from './lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const api = (arg('api', process.env.LOAD_API ?? 'http://localhost:4000') ?? '').replace(/\/$/, '');
const seedFile = arg('seed');
const out = arg('out');
if (!['run', 'watch'].includes(cmd) || !seedFile) {
  console.error(
    'usage: burst.mjs <run|watch> --api URL --seed FILE [--out FILE] [--judges N] [--submissions 500] [--window 120] [--listeners 200] [--seed-number 1] [--drain-timeout 2400]',
  );
  process.exit(2);
}
const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
const csrf = randomBytes(32).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** fetch that waits out a 429 (Retry-After) up to `tries` times. */
async function call(method, path, { token, body, cookie, tries = 6 } = {}) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${api}/api${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        cookie: `ca_csrf=${csrf}${cookie ? `; ${cookie}` : ''}`,
        'x-csrf-token': csrf,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && i < tries) {
      await sleep((Number(res.headers.get('retry-after') ?? 1) + 0.2) * 1000);
      continue;
    }
    return res;
  }
}

/** Refresh-token → access token (the refresh limiter is per IP: 120/min, so the pool is gentle). */
async function login(u) {
  const res = await call('POST', '/auth/refresh', { cookie: `ca_rt=${u.refreshToken}` });
  if (!res.ok) throw new Error(`login ${u.handle}: HTTP ${res.status}`);
  u.token = (await res.json()).accessToken;
  u.tokenAt = now();
}
async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: size }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

async function adminToken() {
  if (!seed.admin.token || now() - seed.admin.tokenAt > 10 * 60_000) await login(seed.admin);
  return seed.admin.token;
}
async function ops() {
  const res = await call('GET', '/admin/ops/summary', { token: await adminToken() });
  if (!res.ok) throw new Error(`ops summary: HTTP ${res.status}`);
  return res.json();
}

/** One SSE listener on the contest board. Counts events; reconnects are counted, not hidden. */
async function listen(u, topic, stats, stop) {
  while (!stop.done) {
    const t0 = now();
    try {
      const tr = await call('POST', '/realtime/ticket', {
        token: u.token,
        body: { topics: [topic] },
      });
      if (!tr.ok) throw new Error(`ticket HTTP ${tr.status}`);
      const { ticket } = await tr.json();
      const res = await fetch(
        `${api}/api/sse?ticket=${ticket}&topics=${encodeURIComponent(topic)}`,
        {
          headers: { accept: 'text/event-stream' },
        },
      );
      if (!res.ok || !res.body) throw new Error(`sse HTTP ${res.status}`);
      stats.connected++;
      stats.connectMs.push(now() - t0);
      let buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event:/m.test(frame)) stats.events++;
        }
        if (stop.done) break;
      }
      stats.connected--;
      if (!stop.done) stats.drops++;
    } catch (e) {
      if (stop.done) return;
      stats.errors++;
      stats.lastError = String(e.message ?? e);
    }
    if (!stop.done) await sleep(2000);
  }
}

async function run() {
  const n = Number(arg('submissions', 500));
  const windowSec = Number(arg('window', 120));
  const listeners = Number(arg('listeners', 200));
  const random = rng(Number(arg('seed-number', 1)));
  const problemsDir = fileURLToPath(new URL('../../problems/', import.meta.url));
  const poolOfSolutions = loadPool(problemsDir, seed.contest.problems);
  if (poolOfSolutions.length === 0) throw new Error('no solutions found for the contest problems');

  log(`logging in ${seed.users.length} users (gently: the refresh limiter is per IP)…`);
  await pool(seed.users, 4, login);
  log('logged in');

  const stop = { done: false };
  const sse = { connected: 0, events: 0, drops: 0, errors: 0, connectMs: [], lastError: '' };
  const topic = `contest:${seed.contest.id}:board`;
  const listenerTasks = Array.from({ length: listeners }, (_, i) =>
    sleep(i * 40).then(() => listen(seed.users[i % seed.users.length], topic, sse, stop)),
  );
  const deadline = now() + 90_000;
  while (sse.connected < listeners && now() < deadline) await sleep(500);
  log(`SSE listeners connected: ${sse.connected}/${listeners}`);

  const offsets = schedule(n, windowSec * 1000, random);
  const order = userOrder(seed.users.length, n, random);
  const results = [];
  const depth = [];
  const tBurst = now();
  const startedAt = new Date().toISOString();
  let ticking = true;
  const sampler = (async () => {
    while (ticking) {
      try {
        const s = await ops();
        depth.push({
          t: (now() - tBurst) / 1000,
          contest: s.lanes.find((l) => l.lane === 'contest')?.depth ?? 0,
          busy: s.workers.reduce((a, w) => a + w.busy, 0),
          workers: s.workers.length,
          dlq: s.dlq,
        });
      } catch (e) {
        depth.push({ t: (now() - tBurst) / 1000, error: String(e.message) });
      }
      await sleep(2000);
    }
  })();

  log(`burst: ${n} submissions over ${windowSec}s`);
  offsets.sort((a, b) => a - b);
  const inflight = [];
  for (let i = 0; i < n; i++) {
    await sleep(Math.max(0, offsets[i] - (now() - tBurst)));
    const u = seed.users[order[i]];
    const s = pick(poolOfSolutions, random);
    const t0 = now();
    inflight.push(
      call('POST', '/submissions', {
        token: u.token,
        tries: 0,
        body: {
          contestSlug: seed.contest.slug,
          label: s.label,
          language: s.language,
          source: s.source,
        },
      })
        .then(async (res) => {
          const body = res.ok ? await res.json() : null;
          results.push({
            status: res.status,
            ms: now() - t0,
            expected: s.expected,
            language: s.language,
            id: body?.id,
          });
        })
        .catch((e) => results.push({ status: 0, ms: now() - t0, error: String(e.message) })),
    );
  }
  await Promise.all(inflight);
  const submitSeconds = (now() - tBurst) / 1000;
  const accepted = results.filter((r) => r.status === 201).length;
  log(`burst sent in ${submitSeconds.toFixed(1)}s: ${accepted} accepted of ${n}`);

  const drainTimeout = Number(arg('drain-timeout', 2400)) * 1000;
  let quiet = 0;
  let drained = false;
  while (now() - tBurst < drainTimeout + windowSec * 1000) {
    await sleep(2000);
    const last = depth.at(-1);
    quiet = last && last.contest === 0 && last.busy === 0 ? quiet + 1 : 0;
    if (quiet >= 3) {
      drained = true;
      break;
    }
    if (depth.length % 15 === 0 && last)
      log(`queue ${last.contest}, busy ${last.busy}, workers ${last.workers}`);
  }
  // The first of the last three quiet samples is when the queue actually emptied.
  const drainedSeconds = drained ? depth.at(-3).t : null;
  ticking = false;
  stop.done = true;
  await sampler;
  log(
    drained
      ? `drained ${drainedSeconds.toFixed(0)}s after the burst started`
      : 'DID NOT DRAIN before the timeout',
  );

  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const record = {
    kind: 'burst',
    judges: Number(arg('judges', 0)) || null,
    api,
    startedAt,
    contest: seed.contest.slug,
    submissions: n,
    windowSeconds: windowSec,
    sentSeconds: submitSeconds,
    byStatus,
    acceptLatencyMs: summarize(results.filter((r) => r.status === 201).map((r) => r.ms)),
    drained,
    drainedSeconds,
    drainAfterBurstSeconds: drained ? Math.max(0, drainedSeconds - windowSec) : null,
    peakQueue: Math.max(0, ...depth.map((d) => d.contest ?? 0)),
    maxWorkers: Math.max(0, ...depth.map((d) => d.workers ?? 0)),
    maxDlq: Math.max(0, ...depth.map((d) => d.dlq ?? 0)),
    sse: {
      wanted: listeners,
      peakConnected: Math.max(sse.connected, 0),
      events: sse.events,
      drops: sse.drops,
      errors: sse.errors,
      lastError: sse.lastError,
      connectMs: summarize(sse.connectMs),
    },
    depth,
  };
  void listenerTasks;
  if (out) writeFileSync(out, JSON.stringify(record, null, 2));
  log('done', out ? `→ ${out}` : '');
  // Listeners may be parked in a read; exit explicitly.
  process.exit(drained && byStatus[201] === n ? 0 : 1);
}

/** Records when judge workers appear (start it just before `terraform apply` to time a scale-out). */
async function watch() {
  const t0 = now();
  const seen = new Map();
  const timeoutSec = Number(arg('timeout', 1800));
  log('watching workers; Ctrl-C to stop');
  const finish = () => {
    const rec = {
      kind: 'scale',
      api,
      workers: [...seen].map(([id, sec]) => ({ id, firstSeenSeconds: sec })),
    };
    if (out) writeFileSync(out, JSON.stringify(rec, null, 2));
    log('saved', out ?? '(no --out)');
    process.exit(0);
  };
  process.on('SIGINT', finish);
  while (now() - t0 < timeoutSec * 1000) {
    try {
      for (const w of (await ops()).workers) {
        if (!seen.has(w.id)) {
          seen.set(w.id, (now() - t0) / 1000);
          log(`worker ${w.id} appeared after ${((now() - t0) / 1000).toFixed(0)}s`);
        }
      }
    } catch (e) {
      log('ops error', e.message);
    }
    await sleep(3000);
  }
  finish();
}

await (cmd === 'run' ? run() : watch());
