// Pure helpers for the O-03 burst driver (no network, no files except reading problem packages).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** p in [0,1], linear interpolation between ranks (same as Postgres percentile_cont). */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const rank = (v.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo] + (v[hi] - v[lo]) * (rank - lo);
}

export function summarize(values) {
  if (values.length === 0) return { n: 0, mean: null, p50: null, p95: null, max: null };
  return {
    n: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

/** mulberry32: a small seeded generator so a run can be repeated exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LANGUAGE = { '.cpp': 'cpp17', '.py': 'python3' };
export const languageOf = (file) => LANGUAGE[file.slice(file.lastIndexOf('.'))];

/** `{file, expected}` entries of problem.yaml's `solutions:` (same reading as scripts/stress-test.py). */
export function parseSolutions(yaml) {
  const out = [];
  for (const line of yaml.split('\n')) {
    const m = /^\s*-\s*\{\s*file:\s*([^,\s]+)\s*,\s*expected:\s*([A-Z]+)\s*\}/.exec(line);
    if (m) out.push({ file: m[1], expected: m[2] });
  }
  return out;
}

/**
 * Share of submissions per expected verdict, and per language within AC. Failures stop at the first
 * failing test, so WA/RE are cheap and TLE costs the time limit once.
 */
export const MIX = { AC: 0.7, WA: 0.2, TLE: 0.07, RE: 0.03 };

/** Every usable solution of the given problems: {label, slug, language, expected, source}. */
export function loadPool(problemsDir, problems) {
  const pool = [];
  for (const { label, slug } of problems) {
    const dir = join(problemsDir, slug);
    for (const s of parseSolutions(readFileSync(join(dir, 'problem.yaml'), 'utf8'))) {
      const language = languageOf(s.file);
      if (!language || !(s.expected in MIX)) continue;
      pool.push({
        label,
        slug,
        language,
        expected: s.expected,
        source: readFileSync(join(dir, 'solutions', s.file), 'utf8'),
      });
    }
  }
  return pool;
}

/** The i-th submission of the burst: a verdict class by MIX, then a pool entry of that class. */
export function pick(pool, random) {
  const r = random();
  let acc = 0;
  let want = 'AC';
  for (const [k, share] of Object.entries(MIX)) {
    acc += share;
    if (r < acc) {
      want = k;
      break;
    }
  }
  const of = pool.filter((s) => s.expected === want);
  const from = of.length > 0 ? of : pool;
  return from[Math.floor(random() * from.length)];
}

/** Millisecond offsets (from the start) for `n` submissions spread over `windowMs`, with jitter. */
export function schedule(n, windowMs, random) {
  const step = windowMs / n;
  return Array.from({ length: n }, (_, i) => Math.round(i * step + random() * step * 0.8));
}

/** Round-robin over a shuffled copy, so 500 submissions over 150 users hit everyone ~3 times. */
export function userOrder(count, n, random) {
  const idx = Array.from({ length: count }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return Array.from({ length: n }, (_, i) => idx[i % count]);
}
