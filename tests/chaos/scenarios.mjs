// The O-06 failure drills. Each scenario injects one fault into a contest that is being judged and says what
// an operator would see; `runScenario` does the common part (traffic, waiting, checking, timing).
import { fileURLToPath } from 'node:url';
import { loadPool, pick, rng, schedule, userOrder } from '../load/lib.mjs';
import { makeClient } from './api.mjs';
import { boardsEqual, evaluate, now, secs, sleep, waitUntil } from './lib.mjs';

const PROBLEMS = fileURLToPath(new URL('../../problems/', import.meta.url));

/** Operator view of a judge: gone from the ops summary, or a heartbeat older than the console's 10 s. */
const workerGone = (admin, id) => async () => {
  const s = await admin.ops();
  if (!s) return false;
  const w = s.workers.find((x) => x.id === id);
  return !w || w.ageMs > 10_000;
};

export const SCENARIOS = {
  'kill-worker': {
    title: 'Kill a judge worker while it is judging',
    fault: 'kill -9 of the worker process',
    expect: {},
    async inject(c) {
      c.ctx.target = await c.env.killWorker();
      c.note(`killed ${c.ctx.target}`);
    },
    detectAfterInject: true,
    detect: (c) =>
      waitUntil(workerGone(c.admin, c.ctx.target ?? ''), { timeoutMs: 45_000, everyMs: 500 }),
  },
  'kill-api': {
    title: 'Kill the API while submissions arrive',
    fault: 'kill -9 of the API process (container)',
    expect: { visible: true },
    async inject(c) {
      await c.env.killApi();
    },
    detect: (c) =>
      waitUntil(async () => !(await c.client.ready()), { timeoutMs: 15_000, everyMs: 250 }),
  },
  'restart-redis-graceful': {
    title: 'Restart Redis (clean shutdown)',
    fault: 'docker restart of Redis (flushes its append-only file)',
    expect: { visible: true, sseResumed: true },
    sse: true,
    async inject(c) {
      await c.env.restartRedis({ hard: false });
    },
    detect: (c) =>
      waitUntil(async () => !(await c.client.ready()), { timeoutMs: 30_000, everyMs: 250 }),
  },
  'restart-redis-hard': {
    title: 'Kill Redis hard (up to 1 s of writes can be lost)',
    fault: 'kill -9 of Redis, then start it again',
    expect: { visible: true, sseResumed: true },
    sse: true,
    async inject(c) {
      await c.env.restartRedis({ hard: true });
    },
    detect: (c) =>
      waitUntil(async () => !(await c.client.ready()), { timeoutMs: 30_000, everyMs: 250 }),
  },
  'freeze-judge': {
    title: 'A judge VM stops (frozen, then back)',
    fault: 'the judge stops answering; later it comes back and may publish late',
    expect: { visible: true },
    async inject(c) {
      c.ctx.target = await c.env.freezeJudge();
      c.note(`stopped ${c.ctx.target}`);
    },
    detectAfterInject: true,
    detect: (c) =>
      waitUntil(workerGone(c.admin, c.ctx.target ?? ''), { timeoutMs: 60_000, everyMs: 500 }),
    async heal(c) {
      c.ctx.backMs = await c.env.thawJudge(c.ctx.target);
      c.note(`back after ${secs(c.ctx.backMs)} s`);
    },
  },
  poison: {
    title: 'A poison submission reaches the dead-letter queue',
    fault: 'a job whose testset cannot be fetched (the outage ends later)',
    expect: { visible: true },
    expectJobsDlq: 0,
    extraSubmissions: 1,
    async inject(c) {
      // A correct solution of the problem the poison job is for (the contest's last one), so that the
      // verdict after the outage is AC and a wrong answer cannot be mistaken for success.
      const label = c.seed.contest.problems.at(-1).label;
      const source = c.pool.find(
        (s) => s.label === label && s.expected === 'AC' && s.language === 'cpp17',
      ).source;
      c.ctx.poison = await c.env.poison(c.seed.contest.slug, source);
    },
    detect: (c) =>
      waitUntil(async () => ((await c.admin.ops())?.dlq ?? 0) >= 1, {
        timeoutMs: 120_000,
        everyMs: 1000,
      }),
    async heal(c) {
      const id = c.ctx.poison.submissionId;
      const first = await waitUntil(
        async () => {
          const s = await c.admin.submission(id);
          return s?.verdict ? s : null;
        },
        { timeoutMs: 60_000, everyMs: 1000 },
      );
      const se = first.value?.verdict;
      await c.env.repair(c.seed.contest.slug);
      const entry = (await c.admin.dlq()).find((e) => e.submissionId === id);
      const req = entry ? await c.admin.requeue(entry.entryId) : null;
      const final = await waitUntil(
        async () => {
          const s = await c.admin.submission(id);
          return s?.verdict === 'AC' && s.runVersion === 2 ? s : null;
        },
        { timeoutMs: 90_000, everyMs: 1000 },
      );
      c.extra.push(
        {
          name: 'the poison job first ended as SE and was dead-lettered',
          ok: se === 'SE' && Boolean(entry),
          detail: `first verdict ${se}, dead letter ${entry ? 'found' : 'missing'}`,
        },
        {
          name: 'Re-queue after the outage ended in the real verdict (run 2, AC)',
          ok: Boolean(req?.ok) && final.ok,
          detail: final.ok ? '' : 'the retry did not produce AC at run version 2',
        },
        {
          name: 'the dead-letter queue is empty afterwards',
          ok: ((await c.admin.ops())?.dlq ?? -1) === 0,
          detail: '',
        },
      );
    },
  },
};

const OPTIONS = {
  users: 30,
  submissions: 60,
  windowMs: 40_000,
  faultAtMs: 15_000,
  settleMs: 300_000,
};

/** Runs one scenario against an environment adapter and returns the record that goes into METRICS.md. */
export async function runScenario(env, name, overrides = {}) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown scenario ${name}`);
  const o = { ...OPTIONS, ...overrides };
  const notes = [];
  const extra = [];
  const seed = await env.seed(o.users);
  const client = makeClient(env.apiUrl);
  const admin = client.admin(seed.admin);
  let sse = null;
  try {
    await client.login(seed.admin);
    const queue = [...seed.users];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (queue.length) await client.login(queue.shift());
      }),
    );

    const pool = loadPool(PROBLEMS, seed.contest.problems);
    const random = rng(7);
    const offsets = schedule(o.submissions, o.windowMs, random).sort((a, b) => a - b);
    const order = userOrder(seed.users.length, o.submissions, random);
    const ctx = {};
    const c = { env, client, admin, seed, pool, ctx, extra, note: (t) => notes.push(t) };

    if (sc.sse) sse = client.listen(seed.users[0], `contest:${seed.contest.id}:board`);
    await sleep(1500);

    const results = [];
    const t0 = now();
    const traffic = (async () => {
      const inflight = [];
      for (let i = 0; i < o.submissions; i++) {
        await sleep(Math.max(0, offsets[i] - (now() - t0)));
        const u = seed.users[order[i]];
        const s = pick(pool, random);
        inflight.push(
          client
            .submit(u, s, seed.contest.slug)
            .then((r) => results.push({ ...r, user: u.handle })),
        );
      }
      await Promise.all(inflight);
    })();

    await sleep(Math.max(0, o.faultAtMs - (now() - t0)));
    const tFault = now();
    const eventsBefore = sse ? sse.eventTimes.length : 0;
    const injected = sc.inject(c);
    // Judge scenarios can only look for the victim once the injector has named it; the others watch at once.
    // Either way the detection time counts from the moment of the fault.
    const detecting = (async () => {
      if (sc.detectAfterInject) await injected;
      const r = await sc.detect(c);
      return r.ok ? { ok: true, ms: now() - tFault } : r;
    })();
    await injected;
    const tInjected = now();
    const healthy = await waitUntil(() => client.ready(), { timeoutMs: 120_000, everyMs: 500 });
    const tHealthy = now();
    const detection = await detecting;
    await traffic;
    const tTrafficEnd = now();
    if (sc.heal) await sc.heal(c);

    // Everything the API accepted must end with a verdict.
    const accepted = results.filter((r) => r.status === 201).map((r) => r.id);
    const want = new Set(accepted);
    const done = await waitUntil(
      async () => {
        const seen = new Set();
        for (const u of seed.users)
          for (const s of await client.mine(u)) if (s.verdict) seen.add(s.id);
        return [...want].every((id) => seen.has(id));
      },
      { timeoutMs: o.settleMs, everyMs: 3000 },
    );
    const tJudged = now();

    const verification = await env.verify(seed.contest.slug, {
      expectJobsDlq: sc.expectJobsDlq ?? 0,
    });
    const before = await admin.board(seed.contest.slug);
    await admin.rebuild(seed.contest.id);
    const after = await admin.board(seed.contest.slug);
    const board = boardsEqual(before, after);

    const observed = {
      detectMs: detection?.ok ? detection.ms : null,
      sseReconnects: sse?.reconnects ?? 0,
      sseEventsAfter: sse ? sse.eventTimes.filter((t) => t > tHealthy).length : 0,
      extraChecks: [
        ...extra,
        {
          name: 'all accepted submissions were judged before the time limit',
          ok: done.ok,
          detail: done.ok ? '' : `${o.settleMs / 1000} s passed`,
        },
      ],
    };
    void eventsBefore;
    const verdict = evaluate({
      accepted: accepted.length,
      extraSubmissions: sc.extraSubmissions ?? 0,
      verification,
      board,
      expect: sc.expect,
      observed,
    });
    return {
      scenario: name,
      title: sc.title,
      fault: sc.fault,
      environment: env.name,
      pass: verdict.pass,
      checks: verdict.checks,
      detectSeconds: secs(observed.detectMs),
      healthySeconds: healthy.ok ? secs(tHealthy - tFault) : null,
      recoverSeconds: done.ok ? secs(Math.max(tJudged, tHealthy) - tFault) : null,
      // The lag the fault left behind: from the last submission accepted to the last verdict.
      tailSeconds: done.ok ? secs(tJudged - tTrafficEnd) : null,
      injectSeconds: secs(tInjected - tFault),
      submissions: {
        sent: results.length,
        accepted: accepted.length,
        refusedDuringFault: results.filter((r) => r.status !== 201).length,
      },
      verification: {
        submissions: verification.submissions,
        byVerdict: verification.byVerdict,
        resultEntries: verification.resultEntries,
      },
      notes,
    };
  } finally {
    if (sse) sse.stop = true;
    await env.cleanup().catch(() => undefined);
  }
}
