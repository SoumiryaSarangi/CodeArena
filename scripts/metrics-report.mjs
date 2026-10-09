#!/usr/bin/env node
// Writes measured numbers into docs/METRICS.md (PLAN §O-03). Each load run is one block keyed by its
// label; running again with the same label replaces that block, a new label adds one, and the
// comparison table at the top is rebuilt from the blocks.
//
//   node scripts/metrics-report.mjs --run run.json --report report.json --label "judges=1" [--scale scale.json]
//        [--out docs/METRICS.md]
//   node scripts/metrics-report.mjs --drills drills.json [--out docs/METRICS.md]       (O-06 failure drills)
//   node scripts/metrics-report.mjs --contest contest.json [--out docs/METRICS.md]     (W-00: a real contest's numbers)
//   node scripts/metrics-report.mjs --pad pad.json [--out docs/METRICS.md]             (CP-08: interview pad load test)
//
// run.json    from tests/load/burst.mjs run     (what a client saw)
// report.json from load-cli report              (what the database recorded)
// scale.json  from tests/load/burst.mjs watch   (when each new worker appeared)
// pad.json    from `pnpm --filter @codearena/collab pad-load -- … --out pad.json` (apps/collab/src/load/pad-load.ts)
// contest.json from `load-cli contest-report SLUG` (tests/load/prod.sh contest-report SLUG FILE): read-only, any contest
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HEADER = `# Metrics

Measured numbers, not estimates. Sections are written by scripts (\`scripts/metrics-report.mjs\` for the load
test) and replaced when the same run is repeated, so edit the text around them, not inside the markers.
Capacity maths and the predictions each result is compared with are in SYSTEM_DESIGN §2.3.
`;

/** SD-§2.3 predictions: burst drain after the 2-minute window, in seconds, by judge count. */
export const PREDICTED_DRAIN = { 1: 15 * 60, 3: 210, 6: 47 };

const s1 = (v, d = 1) => (v === null || v === undefined ? '–' : Number(v).toFixed(d));
const dur = (sec) => {
  if (sec === null || sec === undefined) return '–';
  if (sec < 90) return `${Math.round(sec)} s`;
  return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
};

const SLUG = /[^a-z0-9=_.-]+/gi;
export const keyOf = (label) => label.replace(SLUG, '-');

/** The markdown block for one run. */
export function renderRun({ run, report, scale, label }) {
  const k = keyOf(label);
  const lines = [];
  lines.push(`<!-- load:${k} -->`);
  lines.push(`### Burst — ${label}`);
  lines.push('');
  lines.push(
    `${run.startedAt.slice(0, 16).replace('T', ' ')} UTC · ${run.submissions} submissions in ${run.windowSeconds} s · ` +
      `${run.judges ?? '?'} judge VM(s) · ${run.sse.wanted} SSE listeners · client: ${run.api.startsWith('http://localhost') ? 'same machine' : 'remote'}`,
  );
  lines.push('');
  lines.push('| What | Value |');
  lines.push('|---|---|');
  lines.push(
    `| Accepted (HTTP 201) | ${run.byStatus['201'] ?? 0} of ${run.submissions}${Object.keys(run.byStatus).length > 1 ? ` (other: ${JSON.stringify(run.byStatus)})` : ''} |`,
  );
  lines.push(`| Judged with a verdict | ${report.judged} of ${report.submissions} |`);
  lines.push(
    `| Accept latency p50 / p95 | ${s1(run.acceptLatencyMs.p50, 0)} / ${s1(run.acceptLatencyMs.p95, 0)} ms |`,
  );
  lines.push(
    `| Queue wait p50 / p95 / max | ${s1(report.queueWait.p50)} / ${s1(report.queueWait.p95)} / ${s1(report.queueWait.max)} s |`,
  );
  lines.push(
    `| Time to verdict p50 / p95 / max | ${s1(report.timeToVerdict.p50)} / ${s1(report.timeToVerdict.p95)} / ${s1(report.timeToVerdict.max)} s |`,
  );
  lines.push(`| Burst drain (last submit → last verdict) | ${dur(report.drainSeconds)} |`);
  lines.push(`| Throughput while judging | ${s1(report.throughputPerSecond, 2)} submissions/s |`);
  lines.push(`| Peak queue depth (contest lane) | ${run.peakQueue} |`);
  lines.push(
    `| Workers seen | ${report.workers.length} (${report.workers.map((w) => `${w.id}: ${w.runs}`).join(', ')}) |`,
  );
  lines.push(`| Dead-letter entries | ${run.maxDlq} |`);
  lines.push(
    `| SSE | ${run.sse.peakConnected}/${run.sse.wanted} connected, ${run.sse.events} events, ${run.sse.drops} drops, ${run.sse.errors} errors |`,
  );
  lines.push('');
  lines.push(
    'Verdicts: ' +
      Object.entries(report.byVerdict)
        .map(([k2, v]) => `${k2} ${v}`)
        .join(' · '),
  );
  lines.push('');
  lines.push('| Language | Runs | Mean service time | p50 | p95 |');
  lines.push('|---|---|---|---|---|');
  for (const [lang, st] of Object.entries(report.serviceTime)) {
    lines.push(
      `| ${lang} | ${st.n} | ${s1(st.mean, 2)} s | ${s1(st.p50, 2)} s | ${s1(st.p95, 2)} s |`,
    );
  }
  if (scale?.workers?.length) {
    lines.push('');
    lines.push(
      'Scale-out (from the moment the watcher started, just before `terraform apply`): ' +
        scale.workers.map((w) => `${w.id} after ${dur(w.firstSeenSeconds)}`).join(' · '),
    );
  }
  const data = {
    label,
    judges: run.judges,
    accepted: run.byStatus['201'] ?? 0,
    submissions: run.submissions,
    judged: report.judged,
    queueWaitP50: report.queueWait.p50,
    queueWaitP95: report.queueWait.p95,
    ttvP50: report.timeToVerdict.p50,
    ttvP95: report.timeToVerdict.p95,
    drainSeconds: report.drainSeconds,
    throughput: report.throughputPerSecond,
    mean: Object.fromEntries(Object.entries(report.serviceTime).map(([l, st]) => [l, st.mean])),
    scaleSeconds: scale?.workers?.map((w) => w.firstSeenSeconds) ?? null,
  };
  lines.push(`<!--data ${JSON.stringify(data)} -->`);
  lines.push(`<!-- /load:${k} -->`);
  return lines.join('\n');
}

const BLOCK = /<!-- load:([^ ]+) -->[\s\S]*?<!-- \/load:\1 -->/g;
const SUMMARY = /<!-- load-summary -->[\s\S]*?<!-- \/load-summary -->\n?/;

/** Adds or replaces the block of this key. */
export function upsertBlock(doc, key, block) {
  let found = false;
  const next = doc.replace(BLOCK, (m, k) => {
    if (k !== key) return m;
    found = true;
    return block;
  });
  if (found) return next;
  const heading = '## Load test (O-03)';
  const base = next.includes(heading)
    ? next
    : `${next.trimEnd()}\n\n${heading}\n\n<!-- load-summary -->\n<!-- /load-summary -->\n`;
  return `${base.trimEnd()}\n\n${block}\n`;
}

/** The comparison table, rebuilt from the data comments of every block. */
export function summaryTable(doc) {
  const rows = [];
  for (const m of doc.matchAll(/<!--data (\{.*?\}) -->/g)) rows.push(JSON.parse(m[1]));
  rows.sort((a, b) => (a.judges ?? 99) - (b.judges ?? 99) || a.label.localeCompare(b.label));
  const out = [
    '<!-- load-summary -->',
    '| Run | Judges | Queue wait p50 / p95 | Time to verdict p50 / p95 | Burst drain | Predicted (SD-§2.3) | Throughput |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const pred = PREDICTED_DRAIN[r.judges];
    out.push(
      `| ${r.label} | ${r.judges ?? '?'} | ${s1(r.queueWaitP50)} / ${s1(r.queueWaitP95)} s | ${s1(r.ttvP50)} / ${s1(r.ttvP95)} s | ${dur(r.drainSeconds)} | ${pred ? dur(pred) : '–'} | ${s1(r.throughput, 2)}/s |`,
    );
  }
  out.push('<!-- /load-summary -->', '');
  return out.join('\n');
}

export function update(doc, parts) {
  const base = doc.trim() === '' ? HEADER : doc;
  const withBlock = upsertBlock(base, keyOf(parts.label), renderRun(parts));
  return withBlock.replace(SUMMARY, summaryTable(withBlock));
}

const DRILL_HEADING = '## Failure drills (O-06)';
const DRILL_INTRO = `Each drill judges a real contest of fake users, injects one fault and waits until every accepted
submission has a verdict. **Detected** = the first signal an operator would see (a judge gone from the ops
summary, a failed health check, a dead letter); **healthy** = the API answers again; **all judged** = the
fault until every accepted submission had its verdict; **after the last submit** = how long the last verdict took once submissions stopped (the lag the fault left behind). A drill passes only if every verdict exists exactly
once, nothing is stuck and the board equals the rebuild from Postgres (NFR-REL-01, FR-BOARD-03).`;
const sec = (v) => (v === null || v === undefined ? 'no signal' : `${v} s`);

/** The block for one environment's drills. */
export function renderDrills({ environment, at, results }) {
  const key = keyOf(environment);
  const lines = [
    `<!-- drills:${key} -->`,
    `### ${environment}`,
    '',
    `Run ${String(at).slice(0, 16).replace('T', ' ')} UTC.`,
    '',
  ];
  lines.push(
    '| Drill | Fault | Detected after | Healthy after | All judged after | After the last submit | Accepted / refused | Result |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const subs = r.submissions
      ? `${r.submissions.accepted} / ${r.submissions.refusedDuringFault}`
      : '–';
    lines.push(
      `| ${r.title} | ${r.fault ?? ''} | ${sec(r.detectSeconds)} | ${sec(r.healthySeconds ?? null)} | ${sec(r.recoverSeconds ?? null)} | ${sec(r.tailSeconds ?? null)} | ${subs} | ${r.pass ? '✓ pass' : '✗ FAIL'} |`,
    );
  }
  const bad = results.filter((r) => !r.pass);
  if (bad.length > 0) {
    lines.push('', 'What failed:');
    for (const r of bad) {
      for (const c of r.checks.filter((x) => !x.ok))
        lines.push(`- ${r.scenario}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
      if (r.error) lines.push(`- ${r.scenario}: ${r.error.split('\n')[0]}`);
    }
  }
  const notes = results.flatMap((r) => (r.notes ?? []).map((n) => `${r.scenario}: ${n}`));
  if (notes.length > 0) lines.push('', ...notes.map((n) => `- ${n}`));
  lines.push(`<!-- /drills:${key} -->`);
  return lines.join('\n');
}

/** Adds or replaces the drill block of this environment under the drills heading. */
export function updateDrills(doc, drills) {
  const base = doc.trim() === '' ? HEADER : doc;
  const key = keyOf(drills.environment);
  const block = renderDrills(drills);
  const re = new RegExp(`<!-- drills:${key} -->[\\s\\S]*?<!-- /drills:${key} -->`);
  if (re.test(base)) return base.replace(re, block);
  const withHeading = base.includes(DRILL_HEADING)
    ? base
    : `${base.trimEnd()}\n\n${DRILL_HEADING}\n\n${DRILL_INTRO}\n`;
  return `${withHeading.trimEnd()}\n\n${block}\n`;
}

const CONTEST_HEADING = '## Contest reports (W-00)';
const CONTEST_INTRO = `One block per contest, read from the database after it ended (\`tests/load/prod.sh contest-report SLUG FILE\`, then
\`node scripts/metrics-report.mjs --contest FILE\`). Running it again for the same contest replaces its block. The targets
are PRD §6.3 (M1 to M4); a missing number is shown as "–", never as a pass.`;

const pctOf = (n, d) => (d > 0 ? `${Math.round((100 * n) / d)} %` : '–');
const mark = (ok) => (ok === null ? '–' : ok ? '✓ met' : '✗ NOT met');

/** The block for one real contest, with the PRD targets next to the numbers. */
export function renderContest(r) {
  const k = keyOf(r.contest.slug);
  const p = r.participants;
  const sub = r.submissions;
  const solvedShare = p.registered > 0 ? p.solvedOne / p.registered : null;
  const lines = [
    `<!-- contest:${k} -->`,
    `### ${r.contest.title} (${r.contest.slug})`,
    '',
    `${r.contest.startsAt.slice(0, 16).replace('T', ' ')} to ${r.contest.endsAt.slice(0, 16).replace('T', ' ')} UTC · report made ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC`,
    '',
    '| PRD target | Result | |',
    '|---|---|---|',
    `| M1 participants ≥ 20 | ${p.registered} registered, ${p.submitted} submitted | ${mark(p.registered >= 20)} |`,
    `| M2 at least one AC ≥ 80 % | ${p.solvedOne} of ${p.registered} (${pctOf(p.solvedOne, p.registered)}) | ${mark(solvedShare === null ? null : solvedShare >= 0.8)} |`,
    `| M3 lost or duplicated verdicts = 0 | ${r.integrity.ok ? 'every verdict stored once, nothing stuck' : r.integrity.problems.join('; ')}${r.integrity.notChecked.length ? ` (not checked: ${r.integrity.notChecked.join('; ')})` : ''} | ${mark(r.integrity.ok)} |`,
    `| M4 p95 time to verdict ≤ 15 s | p50 ${s1(r.timeToVerdict.p50)} s, p95 ${s1(r.timeToVerdict.p95)} s, max ${s1(r.timeToVerdict.max)} s over ${r.timeToVerdict.n} verdicts | ${mark(r.timeToVerdict.p95 === null ? null : r.timeToVerdict.p95 <= 15)} |`,
    '',
    '| What | Value |',
    '|---|---|',
    `| Submissions | ${sub.total} (${sub.judged} judged) |`,
    `| Busiest minute | ${sub.peakPerMinute} submissions${sub.peakMinuteAt ? ` at ${sub.peakMinuteAt.slice(11, 16)} UTC` : ''}; mean ${s1(sub.meanPerMinute, 2)} per minute over the contest |`,
    `| Queue wait p50 / p95 / max | ${s1(r.queueWait.p50)} / ${s1(r.queueWait.p95)} / ${s1(r.queueWait.max)} s |`,
    `| Verdict mix | ${
      Object.entries(sub.byVerdict)
        .map(([v, n]) => `${v} ${n}`)
        .join(' · ') || '–'
    } |`,
    `| Languages | ${
      Object.entries(sub.byLanguage)
        .map(([v, n]) => `${v} ${n}`)
        .join(' · ') || '–'
    } |`,
    `| Judge workers | ${r.workers.length === 0 ? '–' : r.workers.map((w) => `${w.id}: ${w.runs}`).join(', ')} |`,
    `| Dead letters (jobs / results) | ${r.deadLetters.jobs ?? 'not read'} / ${r.deadLetters.results ?? 'not read'} |`,
    `| Plagiarism | ${
      r.plagiarism.latest
        ? `${r.plagiarism.runs} run(s); latest ${r.plagiarism.latest.status}, ${r.plagiarism.latest.clusters} cluster(s) flagged: ${r.plagiarism.latest.open} open, ${r.plagiarism.latest.cleared} cleared, ${r.plagiarism.latest.confirmed} confirmed, ${r.plagiarism.latest.discuss} to discuss`
        : 'not run'
    } |`,
    `| AI reviews | ${r.reviews.total} (${
      Object.entries(r.reviews.byStatus)
        .map(([v, n]) => `${v} ${n}`)
        .join(', ') || '–'
    }); ${r.reviews.tokens} tokens${
      Object.keys(r.reviews.models).length
        ? ` on ${Object.entries(r.reviews.models)
            .map(([m, n]) => `${m} ×${n}`)
            .join(', ')}`
        : ''
    }; rated helpful ${r.reviews.helpful.yes}, not helpful ${r.reviews.helpful.no}; cost $0 (free provider tiers) |`,
    `<!-- /contest:${k} -->`,
  ];
  return lines.join('\n');
}

/** Adds or replaces the block of this contest under the contest-reports heading. */
export function updateContest(doc, report) {
  const base = doc.trim() === '' ? HEADER : doc;
  const key = keyOf(report.contest.slug);
  const block = renderContest(report);
  const re = new RegExp(`<!-- contest:${key} -->[\\s\\S]*?<!-- /contest:${key} -->`);
  if (re.test(base)) return base.replace(re, block);
  const withHeading = base.includes(CONTEST_HEADING)
    ? base
    : `${base.trimEnd()}\n\n${CONTEST_HEADING}\n\n${CONTEST_INTRO}\n`;
  return `${withHeading.trimEnd()}\n\n${block}\n`;
}

const PAD_HEADING = '## Interview pad load test (CP-08)';
const PAD_INTRO = `N rooms with 2 to 4 simulated typists, real Hocuspocus clients against real collab processes on Postgres and Redis
(\`pnpm --filter @codearena/collab pad-load\`, then \`node scripts/metrics-report.mjs --pad FILE\`). The target is SRS
NFR-PERF-06: a keystroke reaches the other typists in at most 200 ms at the 95th percentile with 10 rooms of 3. Every run
is one block; the same label replaces its block. The client and the servers share one machine, so there is no network time,
and the clients share one process: when the driver's own load is high (its event-loop delay is shown) the latencies are an
upper bound for the server, not a measurement of it.`;

/** The 200 ms target is only claimed for the point the SRS names: 10 rooms of 3 typists. */
const isSrsPoint = (r) =>
  r.config.rooms === 10 && r.config.typistsMin === 3 && r.config.typistsMax === 3;

/** The block for one pad load run. */
export function renderPad(r) {
  const k = keyOf(r.label);
  const c = r.config;
  const typists =
    c.typistsMin === c.typistsMax ? `${c.typistsMin}` : `${c.typistsMin}-${c.typistsMax}`;
  const lat = r.latencyMs;
  const delivered = r.keystrokes.expectedDeliveries
    ? `${r.keystrokes.received} of ${r.keystrokes.expectedDeliveries} (${pctOf(r.keystrokes.received, r.keystrokes.expectedDeliveries)})`
    : `${r.keystrokes.received}`;
  const busy = r.driver.eventLoopDelayP95Ms > 50;
  const lines = [
    `<!-- pad:${k} -->`,
    `### Pad — ${r.label}`,
    '',
    `${r.startedAt.slice(0, 16).replace('T', ' ')} UTC · ${c.rooms} rooms × ${typists} typists (${r.clients} clients) · ${c.rate} keystrokes/s each for ${c.seconds} s · ${c.instances} collab instance(s) · ${c.awareness ? 'with' : 'without'} cursor awareness · ${r.host.cpus} CPUs, ${r.host.memGb} GB, Node ${r.host.node}`,
    '',
    '| What | Value |',
    '|---|---|',
  ];
  if (isSrsPoint(r))
    lines.push(
      `| NFR-PERF-06: p95 propagation ≤ 200 ms | ${s1(lat.p95)} ms: ${mark(lat.p95 === null ? null : lat.p95 <= 200)} |`,
    );
  lines.push(
    `| Edit propagation p50 / p95 / p99 / max | ${s1(lat.p50)} / ${s1(lat.p95)} / ${s1(lat.p99)} / ${s1(lat.max)} ms over ${lat.n} deliveries |`,
    `| Keystrokes sent · delivered to the others | ${r.keystrokes.sent} · ${delivered} |`,
    `| Joining (connect to synced) p50 / p95 | ${s1(r.joinMs.p50, 0)} / ${s1(r.joinMs.p95, 0)} ms |`,
    `| Memory per room (growth of the collab processes ÷ rooms) | ${s1(r.memoryPerRoomMb, 2)} MB |`,
    `| Collab instances (RSS before → peak, CPU mean / peak, rooms) | ${r.instances
      .map(
        (i, n) =>
          `#${n + 1}: ${s1(i.rssBaselineMb, 0)} → ${s1(i.rssPeakMb, 0)} MB, ${s1(i.cpuMeanPct, 0)} / ${s1(i.cpuPeakPct, 0)} % of a core, ${i.rooms} rooms`,
      )
      .join('; ')} |`,
    `| Driver (this process) | ${s1(r.driver.cpuMeanPct, 0)} % CPU, event-loop delay p95 ${s1(r.driver.eventLoopDelayP95Ms)} ms / max ${s1(r.driver.eventLoopDelayMaxMs)} ms${busy ? ' — **busy: latencies are an upper bound**' : ''} |`,
    `| Rooms whose clients ended with different text | ${r.consistency.diverged} of ${r.consistency.rooms} |`,
    `| Stored in Postgres | ${r.stored.updateRows} log rows (${r.keystrokes.sent} keystrokes), ${r.stored.docRows} documents |`,
    `| Connections closed unexpectedly | ${r.unexpectedCloses} |`,
    `<!-- /pad:${k} -->`,
  );
  return lines.join('\n');
}

/** Adds or replaces the block of this run under the pad heading. */
export function updatePad(doc, result) {
  const base = doc.trim() === '' ? HEADER : doc;
  const key = keyOf(result.label);
  const block = renderPad(result);
  const re = new RegExp(`<!-- pad:${key} -->[\\s\\S]*?<!-- /pad:${key} -->`);
  if (re.test(base)) return base.replace(re, block);
  const withHeading = base.includes(PAD_HEADING)
    ? base
    : `${base.trimEnd()}\n\n${PAD_HEADING}\n\n${PAD_INTRO}\n`;
  return `${withHeading.trimEnd()}\n\n${block}\n`;
}

function main() {
  const rest = process.argv.slice(2);
  const arg = (n) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (arg('pad')) {
    const out = arg('out') ?? 'docs/METRICS.md';
    const doc = existsSync(out) ? readFileSync(out, 'utf8') : '';
    writeFileSync(out, updatePad(doc, JSON.parse(readFileSync(arg('pad'), 'utf8'))));
    console.log(`updated ${out} (pad load test)`);
    return;
  }
  if (arg('contest')) {
    const out = arg('out') ?? 'docs/METRICS.md';
    const doc = existsSync(out) ? readFileSync(out, 'utf8') : '';
    writeFileSync(out, updateContest(doc, JSON.parse(readFileSync(arg('contest'), 'utf8'))));
    console.log(`updated ${out} (contest report)`);
    return;
  }
  if (arg('drills')) {
    const out = arg('out') ?? 'docs/METRICS.md';
    const doc = existsSync(out) ? readFileSync(out, 'utf8') : '';
    writeFileSync(out, updateDrills(doc, JSON.parse(readFileSync(arg('drills'), 'utf8'))));
    console.log(`updated ${out} (failure drills)`);
    return;
  }
  const runFile = arg('run');
  const reportFile = arg('report');
  const label = arg('label');
  if (!runFile || !reportFile || !label) {
    console.error(
      'usage: metrics-report.mjs --run run.json --report report.json --label "judges=1" [--scale scale.json] [--out docs/METRICS.md]',
    );
    process.exit(2);
  }
  const out = arg('out') ?? 'docs/METRICS.md';
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  const doc = existsSync(out) ? readFileSync(out, 'utf8') : '';
  const scaleFile = arg('scale');
  writeFileSync(
    out,
    update(doc, {
      run: read(runFile),
      report: read(reportFile),
      scale: scaleFile ? read(scaleFile) : undefined,
      label,
    }),
  );
  console.log(`updated ${out} (${label})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
