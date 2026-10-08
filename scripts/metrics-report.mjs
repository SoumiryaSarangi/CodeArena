#!/usr/bin/env node
// Writes measured numbers into docs/METRICS.md (PLAN §O-03). Each load run is one block keyed by its
// label; running again with the same label replaces that block, a new label adds one, and the
// comparison table at the top is rebuilt from the blocks.
//
//   node scripts/metrics-report.mjs --run run.json --report report.json --label "judges=1" [--scale scale.json]
//        [--out docs/METRICS.md]
//
// run.json    from tests/load/burst.mjs run     (what a client saw)
// report.json from load-cli report              (what the database recorded)
// scale.json  from tests/load/burst.mjs watch   (when each new worker appeared)
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

function main() {
  const rest = process.argv.slice(2);
  const arg = (n) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
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
