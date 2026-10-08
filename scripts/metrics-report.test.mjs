import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyOf, renderRun, summaryTable, update, upsertBlock } from './metrics-report.mjs';

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
