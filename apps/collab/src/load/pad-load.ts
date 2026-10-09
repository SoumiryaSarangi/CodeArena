/**
 * CP-08 (NFR-PERF-06): load test of the interview pad's collab tier. N rooms with 2 to 4 simulated typists each, real
 * browsers replaced by real Hocuspocus clients, against real collab processes on the Compose Postgres and Redis. It
 * measures how long a keystroke takes to appear at the other typists (p50 / p95 / p99), the memory and CPU of each collab
 * instance, how long joining takes, and that every room ended with identical documents on all its clients.
 *
 *   pnpm --filter @codearena/collab pad-load -- --rooms 10 --typists 3 --seconds 30 --out /tmp/pad.json --label "10 rooms × 3"
 *
 * The clients are in this one process, so its own load is reported too (CPU and event-loop delay): if those are high,
 * the latencies include the driver's slowness and the number is a ceiling, not the server's. Everything runs on the same
 * machine, so there is no network time in the numbers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import type { CollabIdentity } from '@codearena/contracts';
import { HocuspocusProvider } from '@hocuspocus/provider';
import pg from 'pg';
import * as Y from 'yjs';
import { createTestDatabase } from '../../../api/src/test/db';
import { SERVICE_TOKEN, startApi } from '../test-support';
import {
  cpuPercent,
  decodeMarker,
  encodeMarker,
  instanceFor,
  MARKER_SPAN,
  parseArgs,
  parseProc,
  rng,
  summarize,
  type Config,
} from './pad-load-lib';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://admin:codearena-dev@localhost:6379';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
const portOpen = (port: number) =>
  new Promise<boolean>((r) => {
    const s = createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      r(true);
    });
    s.on('error', () => r(false));
  });

interface Typist {
  room: number;
  ord: number;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  keystrokes: number;
}

interface Sample {
  t: number;
  ticks: number;
  rss: number;
}
const readProc = (pid: number) =>
  parseProc(readFileSync(`/proc/${pid}/stat`, 'utf8'), readFileSync(`/proc/${pid}/statm`, 'utf8'));

export async function main(cfg: Config & { out?: string; label?: string }) {
  const startedAt = new Date().toISOString();
  const random = rng(cfg.seed);
  const t = await createTestDatabase();
  const sql = new pg.Pool({ connectionString: t.url, max: 4 });
  const api = await startApi();
  const procs: ChildProcess[] = [];
  const ports: number[] = [];
  const clients: Typist[] = [];
  const latencies: number[] = [];
  const joinMs: number[] = [];
  const closes = { unexpected: 0 };
  let received = 0;
  let sent = 0;

  try {
    // ---- instances
    for (let i = 0; i < cfg.instances; i++) {
      const port = await freePort();
      ports.push(port);
      procs.push(
        spawn('node', ['--import', 'tsx', 'src/main.ts'], {
          cwd: resolve(import.meta.dirname, '../..'),
          env: {
            ...process.env,
            PORT: String(port),
            DATABASE_URL: t.url,
            REDIS_URL,
            API_URL: api.url,
            COLLAB_SERVICE_TOKEN: SERVICE_TOKEN,
            COLLAB_INSTANCE: `load${i}`,
          },
          stdio: 'ignore',
        }),
      );
    }
    for (const p of ports) {
      for (let i = 0; i < 150 && !(await portOpen(p)); i++) await sleep(100);
      if (!(await portOpen(p))) throw new Error(`a collab instance did not start on port ${p}`);
    }
    await sleep(2000); // let start-up work settle before the baseline
    const pids = procs.map((p) => p.pid!);
    const baseline = pids.map((pid) => readProc(pid).rssBytes);

    // ---- rooms and people
    const rooms: { id: string; typists: number }[] = [];
    for (let r = 0; r < cfg.rooms; r++) {
      const id = randomUUID();
      const owner = randomUUID();
      await sql.query('insert into users (id, email, handle) values ($1, $2, $3)', [
        owner,
        `${owner}@example.test`,
        `o${owner.slice(0, 8)}`,
      ]);
      await sql.query(
        `insert into rooms (id, owner_id, language, duration_min) values ($1, $2, 'cpp17', 45)`,
        [id, owner],
      );
      rooms.push({
        id,
        typists: cfg.typistsMin + Math.floor(random() * (cfg.typistsMax - cfg.typistsMin + 1)),
      });
    }

    // when each typed character was sent: [room][typist][slot] in ms of performance.now()
    const sentAt = rooms.map(() =>
      Array.from({ length: 4 }, () => new Float64Array(MARKER_SPAN).fill(NaN)),
    );

    // real typists are real users: the update log and the document store refer to them by id
    const people = new Map<string, CollabIdentity>();
    for (let r = 0; r < rooms.length; r++)
      for (let o = 0; o < rooms[r]!.typists; o++) {
        const who: CollabIdentity = {
          userId: randomUUID(),
          name: `t${r}-${o}`,
          role: o === 0 ? 'interviewer' : 'candidate',
          readOnly: false,
          expiresAt: Date.now() + 3_600_000,
          colorIndex: 0,
        };
        people.set(`${r}:${o}`, who);
        await sql.query('insert into users (id, email, handle) values ($1, $2, $3)', [
          who.userId,
          `${who.userId}@example.test`,
          `p${who.userId.slice(0, 8)}`,
        ]);
      }

    const connect = (room: number, ord: number): Promise<Typist> =>
      new Promise((res, rej) => {
        const doc = new Y.Doc();
        const me = people.get(`${room}:${ord}`)!;
        const started = performance.now();
        let done = false;
        const provider = new HocuspocusProvider({
          url: `ws://127.0.0.1:${ports[instanceFor(rooms[room]!.id, cfg.instances)]}`,
          name: `room:${rooms[room]!.id}`,
          document: doc,
          token: async () => {
            const ticket = `t-${randomUUID()}`;
            api.tickets.set(ticket, me);
            return ticket;
          },
          onSynced: () => {
            if (done) return;
            done = true;
            joinMs.push(performance.now() - started);
            res({ room, ord, doc, provider, keystrokes: 0 });
          },
          onClose: ({ event }) => {
            if (done && event.code !== 1000) closes.unexpected++;
          },
        });
        // an observer of what the others type: each foreign marker's age is a propagation latency
        doc.getText('code').observe((ev, txn) => {
          if (txn.local) return;
          const now = performance.now();
          for (const d of ev.delta) {
            if (typeof d.insert !== 'string') continue;
            for (const ch of d.insert) {
              const m = decodeMarker(ch);
              if (!m || m.typist === ord) continue;
              const at = sentAt[room]![m.typist]![m.slot]!;
              if (Number.isNaN(at)) continue;
              latencies.push(now - at);
              received++;
            }
          }
        });
        setTimeout(
          () => !done && rej(new Error(`room ${room} typist ${ord} did not sync in 30 s`)),
          30_000,
        );
      });

    // ---- connect, a few at a time (a contest-day crowd would also arrive over minutes, not in one instant)
    const jobs: [number, number][] = [];
    for (let r = 0; r < rooms.length; r++)
      for (let o = 0; o < rooms[r]!.typists; o++) jobs.push([r, o]);
    for (let i = 0; i < jobs.length; i += 20)
      clients.push(...(await Promise.all(jobs.slice(i, i + 20).map(([r, o]) => connect(r, o)))));
    await sleep(1000);

    // ---- sampling
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const samples: Sample[][] = pids.map(() => []);
    const driverStart = process.cpuUsage();
    const driverWall = performance.now();
    const sampler = setInterval(() => {
      pids.forEach((pid, i) => {
        try {
          const r = readProc(pid);
          samples[i]!.push({ t: performance.now(), ticks: r.ticks, rss: r.rssBytes });
        } catch {
          /* the process is gone: the missing samples show in the report */
        }
      });
    }, 1000);
    pids.forEach((pid, i) => {
      const r = readProc(pid);
      samples[i]!.push({ t: performance.now(), ticks: r.ticks, rss: r.rssBytes });
    });

    // ---- typing
    const deadline = performance.now() + cfg.seconds * 1000;
    const timers = clients.map(
      (c) =>
        new Promise<void>((done) => {
          const gap = 1000 / cfg.rate;
          const tick = () => {
            if (performance.now() >= deadline) return done();
            const text = c.doc.getText('code');
            const slot = c.keystrokes % MARKER_SPAN;
            sentAt[c.room]![c.ord]![slot] = performance.now();
            // typists work near the end of the code, as people do, not at random places
            const at = Math.max(0, text.length - Math.floor(random() * 40));
            text.insert(Math.min(at, text.length), encodeMarker(c.ord, c.keystrokes));
            if (cfg.awareness)
              c.provider.setAwarenessField('cursor', { index: at, n: c.keystrokes });
            c.keystrokes++;
            sent++;
            setTimeout(tick, gap * (0.7 + random() * 0.6));
          };
          setTimeout(tick, random() * gap);
        }),
    );
    await Promise.all(timers);
    await sleep(3000); // let the last updates arrive and be stored
    clearInterval(sampler);
    loop.disable();
    const driverCpu = process.cpuUsage(driverStart);
    const driverSeconds = (performance.now() - driverWall) / 1000;

    // ---- did every room end the same everywhere, and did the server keep it?
    let diverged = 0;
    for (let r = 0; r < rooms.length; r++) {
      const mine = clients.filter((c) => c.room === r).map((c) => c.doc.getText('code').toString());
      if (new Set(mine).size !== 1) diverged++;
    }
    await sleep(3000); // the document is stored a couple of seconds after the last change
    const logRows = Number((await sql.query('select count(*) from room_updates')).rows[0].count);
    const docRows = Number((await sql.query('select count(*) from room_docs')).rows[0].count);

    const instances = pids.map((pid, i) => {
      const s = samples[i]!;
      const cpu: number[] = [];
      for (let k = 1; k < s.length; k++)
        cpu.push(cpuPercent(s[k - 1]!.ticks, s[k]!.ticks, (s[k]!.t - s[k - 1]!.t) / 1000));
      const rss = s.map((x) => x.rss);
      const mb = (b: number) => b / 1048576;
      return {
        rooms: rooms.filter((r) => instanceFor(r.id, cfg.instances) === i).length,
        rssBaselineMb: mb(baseline[i]!),
        rssPeakMb: mb(Math.max(...rss)),
        rssEndMb: mb(rss.at(-1) ?? 0),
        cpuMeanPct: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0,
        cpuPeakPct: cpu.length ? Math.max(...cpu) : 0,
      };
    });
    // every keystroke should reach every other typist of its room
    const typistsIn = (r: number) => rooms[r]!.typists;
    const expectedDeliveries = clients.reduce(
      (n, c) => n + c.keystrokes * (typistsIn(c.room) - 1),
      0,
    );
    const grew = instances.reduce((a, i) => a + (i.rssPeakMb - i.rssBaselineMb), 0);

    const result = {
      label:
        cfg.label ??
        `${cfg.rooms} rooms × ${cfg.typistsMin === cfg.typistsMax ? cfg.typistsMin : `${cfg.typistsMin}-${cfg.typistsMax}`}`,
      startedAt,
      config: cfg,
      clients: clients.length,
      host: { cpus: cpus().length, memGb: Math.round(totalmem() / 2 ** 30), node: process.version },
      keystrokes: { sent, received, expectedDeliveries },
      latencyMs: summarize(latencies),
      joinMs: summarize(joinMs),
      instances,
      memoryPerRoomMb: cfg.rooms > 0 ? grew / cfg.rooms : null,
      driver: {
        cpuMeanPct: cpuPercent(0, (driverCpu.user + driverCpu.system) / 1e4, driverSeconds),
        eventLoopDelayP95Ms: loop.percentile(95) / 1e6,
        eventLoopDelayMaxMs: loop.max / 1e6,
      },
      consistency: { rooms: rooms.length, diverged },
      stored: { updateRows: logRows, docRows },
      unexpectedCloses: closes.unexpected,
    };
    if (cfg.out) writeFileSync(cfg.out, JSON.stringify(result, null, 2));
    return result;
  } finally {
    for (const c of clients) c.provider.destroy();
    for (const p of procs) p.kill('SIGTERM');
    await sleep(500);
    for (const p of procs) p.kill('SIGKILL');
    await api.close().catch(() => undefined);
    await sql.end();
    await t.drop();
  }
}

if (process.argv[1]?.endsWith('pad-load.ts')) {
  main(parseArgs(process.argv.slice(2))).then(
    (r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
