import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIX,
  parseSolutions,
  percentile,
  pick,
  rng,
  schedule,
  summarize,
  userOrder,
} from './lib.mjs';

test('O-03: percentile interpolates like percentile_cont', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(percentile([4, 1, 3, 2], 0.95) - 3.85) < 1e-9);
  const s = summarize([2, 4]);
  assert.deepEqual([s.n, s.mean, s.p50, s.max], [2, 3, 3, 4]);
  assert.ok(Math.abs(s.p95 - 3.9) < 1e-9);
});

test('O-03: the same seed gives the same burst', () => {
  const a = schedule(20, 10_000, rng(7));
  const b = schedule(20, 10_000, rng(7));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, schedule(20, 10_000, rng(8)));
});

test('O-03: schedule spreads n submissions across the window, in the window', () => {
  const s = schedule(500, 120_000, rng(1));
  assert.equal(s.length, 500);
  assert.ok(Math.min(...s) >= 0 && Math.max(...s) < 120_000);
  const firstHalf = s.filter((t) => t < 60_000).length;
  assert.ok(firstHalf > 230 && firstHalf < 270, `got ${firstHalf}`);
});

test('O-03: parseSolutions reads problem.yaml entries and ignores other lines', () => {
  const y = `slug: x\nsolutions:\n- {file: main.cpp, expected: AC}\n  - {file: alt.py, expected: AC}\n- {file: tle.cpp, expected: TLE}\nlimits: {timeMs: 1}`;
  assert.deepEqual(parseSolutions(y), [
    { file: 'main.cpp', expected: 'AC' },
    { file: 'alt.py', expected: 'AC' },
    { file: 'tle.cpp', expected: 'TLE' },
  ]);
});

test('O-03: pick follows the mix (≈70% AC, 20% WA, 7% TLE, 3% RE)', () => {
  const pool = Object.keys(MIX).map((expected) => ({ expected, language: 'cpp17' }));
  const random = rng(42);
  const counts = {};
  for (let i = 0; i < 10_000; i++) {
    const e = pick(pool, random).expected;
    counts[e] = (counts[e] ?? 0) + 1;
  }
  for (const [k, share] of Object.entries(MIX)) {
    assert.ok(Math.abs(counts[k] / 10_000 - share) < 0.03, `${k}: ${counts[k]}`);
  }
});

test('O-03: pick falls back to the whole pool when a class has no solution', () => {
  const pool = [{ expected: 'AC' }];
  const random = rng(3);
  for (let i = 0; i < 50; i++) assert.equal(pick(pool, random).expected, 'AC');
});

test('O-03: userOrder gives every user a near-equal share', () => {
  const o = userOrder(150, 500, rng(5));
  assert.equal(o.length, 500);
  const per = new Map();
  for (const u of o) per.set(u, (per.get(u) ?? 0) + 1);
  assert.equal(per.size, 150);
  assert.ok([...per.values()].every((c) => c === 3 || c === 4));
});
