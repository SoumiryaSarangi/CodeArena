import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  keyOf,
  renderDrills,
  renderContest,
  renderRun,
  summaryTable,
  update,
  updateContest,
  updateDrills,
  upsertBlock,
} from './metrics-report.mjs';

const stat = (p50, p95, max, mean = p50) => ({ n: 10, mean, p50, p95, max });
const run = (judges) => ({
  judges,
  api: 'https://api.example',
  startedAt: '2026-10-09T18:30:00.000Z',
  submissions: 500,
  windowSeconds: 120,
  byStatus: { 201: 500 },
  acceptLatencyMs: stat(80, 200, 400),
  peakQueue: 440,
  maxDlq: 0,
  sse: { wanted: 200, peakConnected: 200, events: 1200, drops: 0, errors: 0 },
});
const report = (drain) => ({
  submissions: 500,
  judged: 500,
  byVerdict: { AC: 350, WA: 100 },
  queueWait: stat(300, 800, 880),
  timeToVerdict: stat(305, 805, 890),
  serviceTime: { cpp17: stat(1.2, 3, 5, 1.4), python3: stat(2, 4, 6, 2.2) },
  workers: [{ id: 'judge-1', runs: 500, firstStartSeconds: 0.4 }],
  submitWindowSeconds: 120,
  drainSeconds: drain,
  throughputPerSecond: 0.55,
});

test('O-03: a run block has the numbers the card asks for', () => {
  const b = renderRun({ run: run(1), report: report(780), label: 'judges=1' });
  assert.match(b, /Queue wait p50 \/ p95 \/ max \| 300\.0 \/ 800\.0 \/ 880\.0 s/);
  assert.match(b, /Time to verdict p50 \/ p95 \/ max \| 305\.0 \/ 805\.0 \/ 890\.0 s/);
  assert.match(b, /Burst drain \(last submit → last verdict\) \| 13 min 0 s/);
  assert.match(b, /\| cpp17 \| 10 \| 1\.40 s/);
  assert.match(b, /<!-- load:judges=1 -->/);
});

test('O-03: scale-out times appear when a watcher file is given', () => {
  const b = renderRun({
    run: run(3),
    report: report(200),
    label: 'judges=3',
    scale: { workers: [{ id: 'j2', firstSeenSeconds: 245 }] },
  });
  assert.match(b, /j2 after 4 min 5 s/);
});

test('O-03: the same label replaces its block; a new label adds one; the doc keeps its other text', () => {
  const first = update('# Metrics\n\nMy notes.\n\n## Other\n\nkeep me\n', {
    run: run(1),
    report: report(780),
    label: 'judges=1',
  });
  assert.match(first, /keep me/);
  const second = update(first, { run: run(1), report: report(600), label: 'judges=1' });
  assert.equal(second.match(/<!-- load:judges=1 -->/g).length, 1);
  assert.match(second, /10 min 0 s/);
  assert.doesNotMatch(second, /13 min 0 s/);
  const third = update(second, { run: run(3), report: report(200), label: 'judges=3' });
  assert.equal(third.match(/<!-- load:/g).length, 2);
  assert.match(third, /My notes\./);
});

test('O-03: the comparison table sorts by judge count and shows the SD-§2.3 prediction', () => {
  let doc = update('', { run: run(6), report: report(50), label: 'judges=6' });
  doc = update(doc, { run: run(1), report: report(780), label: 'judges=1' });
  const t = summaryTable(doc);
  assert.ok(t.indexOf('judges=1') < t.indexOf('judges=6'));
  assert.match(t, /judges=1 \| 1 \|.*\| 15 min 0 s \|/);
  assert.match(t, /judges=6 \| 6 \|.*\| 47 s \|/);
});

test('O-03: upsertBlock leaves other keys untouched and keyOf makes safe markers', () => {
  assert.equal(keyOf('judges = 3 (D2s)'), 'judges-=-3-D2s-');
  const doc = upsertBlock('# x\n', 'a', '<!-- load:a -->\nA\n<!-- /load:a -->');
  const doc2 = upsertBlock(doc, 'b', '<!-- load:b -->\nB\n<!-- /load:b -->');
  assert.match(upsertBlock(doc2, 'a', '<!-- load:a -->\nA2\n<!-- /load:a -->'), /A2[\s\S]*B/);
});

const drill = (scenario, pass, over = {}) => ({
  scenario,
  title: `Drill ${scenario}`,
  fault: 'kill -9',
  pass,
  detectSeconds: 4.2,
  healthySeconds: 0.1,
  recoverSeconds: 27.6,
  tailSeconds: 2.5,
  submissions: { sent: 60, accepted: 60, refusedDuringFault: 0 },
  checks: pass
    ? []
    : [
        {
          name: 'the board equals the rebuild from Postgres',
          ok: false,
          detail: 'u1: score 5 before, 4 after',
        },
      ],
  notes: [],
  ...over,
});

test('O-06: a drills block has a row per drill with the three timings and the result', () => {
  const b = renderDrills({
    environment: 'local',
    at: '2026-10-08T15:00:00Z',
    results: [drill('kill-worker', true), drill('kill-api', true, { detectSeconds: null })],
  });
  assert.match(b, /<!-- drills:local -->/);
  assert.match(
    b,
    /\| Drill kill-worker \| kill -9 \| 4\.2 s \| 0\.1 s \| 27\.6 s \| 2\.5 s \| 60 \/ 0 \| ✓ pass \|/,
  );
  assert.match(b, /\| Drill kill-api \|.*no signal/);
  assert.doesNotMatch(b, /What failed/);
});

test('O-06: a failed drill says which check failed, and a note is kept', () => {
  const b = renderDrills({
    environment: 'production',
    at: '2026-10-08T15:00:00Z',
    results: [drill('kill-worker', false, { notes: ['killed judge-0'] })],
  });
  assert.match(b, /✗ FAIL/);
  assert.match(
    b,
    /kill-worker: the board equals the rebuild from Postgres \(u1: score 5 before, 4 after\)/,
  );
  assert.match(b, /- kill-worker: killed judge-0/);
});

test('O-06: each environment has its own block under one heading; a rerun replaces only its own', () => {
  let doc = updateDrills('# Metrics\n\nnotes\n', {
    environment: 'local',
    at: '2026-10-08T15:00:00Z',
    results: [drill('a', true)],
  });
  doc = updateDrills(doc, {
    environment: 'production',
    at: '2026-10-08T16:00:00Z',
    results: [drill('a', false)],
  });
  assert.equal(doc.match(/## Failure drills \(O-06\)/g).length, 1);
  assert.equal(doc.match(/<!-- drills:/g).length, 2);
  const rerun = updateDrills(doc, {
    environment: 'local',
    at: '2026-10-09T09:00:00Z',
    results: [drill('b', true)],
  });
  assert.equal(rerun.match(/<!-- drills:local -->/g).length, 1);
  assert.match(rerun, /Drill b/);
  assert.doesNotMatch(
    rerun,
    /Drill a \| kill -9 \| 4\.2 s \| 0\.1 s \| 27\.6 s \| 2\.5 s \| 60 \/ 0 \| ✓ pass/,
  );
  assert.match(rerun, /✗ FAIL/); // production untouched
  assert.match(rerun, /notes/);
});

const contest = (over = {}) => ({
  contest: {
    slug: 'warm-up-1',
    title: 'CodeArena Warm-up #1',
    startsAt: '2026-10-10T13:30:00.000Z',
    endsAt: '2026-10-10T15:30:00.000Z',
    status: 'scheduled',
  },
  generatedAt: '2026-10-10T16:00:00.000Z',
  participants: { registered: 32, submitted: 28, solvedOne: 27 },
  submissions: {
    total: 240,
    judged: 240,
    byVerdict: { AC: 120, WA: 90 },
    byLanguage: { cpp17: 150, python3: 90 },
    peakPerMinute: 21,
    peakMinuteAt: '2026-10-10T14:05:00.000Z',
    meanPerMinute: 2,
  },
  timeToVerdict: { n: 240, p50: 3.1, p95: 9.8, max: 14.2 },
  queueWait: { n: 240, p50: 0.4, p95: 2.2, max: 4 },
  workers: [
    { id: 'judge-0', runs: 130 },
    { id: 'judge-1', runs: 110 },
  ],
  deadLetters: { jobs: 0, results: 0 },
  integrity: { ok: true, problems: [], notChecked: [] },
  plagiarism: {
    runs: 1,
    latest: { status: 'done', clusters: 3, open: 1, cleared: 1, confirmed: 1, discuss: 0 },
  },
  reviews: {
    total: 28,
    byStatus: { ready: 27, failed: 1 },
    tokens: 25000,
    models: { 'gpt-oss-120b': 27 },
    helpful: { yes: 12, no: 2 },
  },
  ...over,
});

test('W-00: a contest block shows every number the card names, against the PRD targets', () => {
  const b = renderContest(contest());
  assert.match(b, /<!-- contest:warm-up-1 -->/);
  assert.match(b, /M1 participants ≥ 20 \| 32 registered, 28 submitted \| ✓ met/);
  assert.match(b, /M2 .* \| 27 of 32 \(84 %\) \| ✓ met/);
  assert.match(b, /M3 .* every verdict stored once, nothing stuck \| ✓ met/);
  assert.match(b, /M4 .* p50 3\.1 s, p95 9\.8 s, max 14\.2 s over 240 verdicts \| ✓ met/);
  assert.match(b, /Busiest minute \| 21 submissions at 14:05 UTC; mean 2\.00 per minute/);
  assert.match(b, /Verdict mix \| AC 120 · WA 90/);
  assert.match(b, /Judge workers \| judge-0: 130, judge-1: 110/);
  assert.match(b, /Dead letters \(jobs \/ results\) \| 0 \/ 0/);
  assert.match(b, /3 cluster\(s\) flagged: 1 open, 1 cleared, 1 confirmed, 0 to discuss/);
  assert.match(
    b,
    /AI reviews \| 28 \(ready 27, failed 1\); 25000 tokens on gpt-oss-120b ×27; rated helpful 12, not helpful 2; cost \$0/,
  );
});

test('W-00: targets that are missed say so, and unknown numbers are a dash, never a pass', () => {
  const bad = renderContest(
    contest({
      participants: { registered: 12, submitted: 10, solvedOne: 5 },
      timeToVerdict: { n: 100, p50: 6, p95: 18.5, max: 40 },
      integrity: { ok: false, problems: ['2 submission(s) have no final verdict'], notChecked: [] },
    }),
  );
  assert.match(bad, /M1 .* ✗ NOT met/);
  assert.match(bad, /M2 .* 5 of 12 \(42 %\) \| ✗ NOT met/);
  assert.match(bad, /M3 .* 2 submission\(s\) have no final verdict \| ✗ NOT met/);
  assert.match(bad, /M4 .* p95 18\.5 s, .* ✗ NOT met/);
  const unknown = renderContest(
    contest({
      participants: { registered: 0, submitted: 0, solvedOne: 0 },
      timeToVerdict: { n: 0, p50: null, p95: null, max: null },
      deadLetters: { jobs: null, results: null },
      plagiarism: { runs: 0, latest: null },
    }),
  );
  assert.match(unknown, /M2 .* \| 0 of 0 \(–\) \| – \|/);
  assert.match(unknown, /M4 .* p95 – s, .* \| – \|/);
  assert.doesNotMatch(unknown, /M4 .*✓ met/);
  assert.match(unknown, /Dead letters \(jobs \/ results\) \| not read \/ not read/);
  assert.match(unknown, /Plagiarism \| not run/);
});

test('W-00: one heading, one block per contest, a rerun replaces only its own block', () => {
  let doc = updateContest('# Metrics\n\nnotes\n', contest());
  doc = updateContest(
    doc,
    contest({ contest: { ...contest().contest, slug: 'warm-up-2', title: 'Warm-up #2' } }),
  );
  assert.equal(doc.match(/## Contest reports \(W-00\)/g).length, 1);
  assert.equal(doc.match(/<!-- contest:/g).length, 2);
  const again = updateContest(
    doc,
    contest({ participants: { registered: 40, submitted: 30, solvedOne: 30 } }),
  );
  assert.equal(again.match(/<!-- contest:warm-up-1 -->/g).length, 1);
  assert.match(again, /40 registered, 30 submitted/);
  const first = again.match(/<!-- contest:warm-up-1 -->[\s\S]*?<!-- \/contest:warm-up-1 -->/)[0];
  assert.doesNotMatch(first, /32 registered/);
  assert.match(again, /32 registered/); // the other contest's block is untouched
  assert.match(again, /Warm-up #2/);
  assert.match(again, /notes/);
});
