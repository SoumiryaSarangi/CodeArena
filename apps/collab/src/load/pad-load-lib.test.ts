import { describe, expect, it } from 'vitest';
import {
  cpuPercent,
  decodeMarker,
  encodeMarker,
  instanceFor,
  MARKER_SPAN,
  MAX_TYPISTS,
  parseArgs,
  parseProc,
  percentile,
  rng,
  summarize,
} from './pad-load-lib';

describe('NFR-PERF-06: the pad load driver measures what it says it measures', () => {
  it('NFR-PERF-06: percentiles interpolate like Postgres percentile_cont and an empty set has none', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5); // order does not matter
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 0.95)).toBeCloseTo(95.05, 5);
    const s = summarize(hundred);
    expect(s).toMatchObject({ n: 100, mean: 50.5, p50: 50.5, max: 100 });
    expect(s.p99).toBeCloseTo(99.01, 5);
    expect(summarize([])).toEqual({ n: 0, mean: null, p50: null, p95: null, p99: null, max: null });
  });

  it('NFR-PERF-06: every typist and keystroke gets its own character, and it decodes back', () => {
    const seen = new Set<string>();
    for (let t = 0; t < MAX_TYPISTS; t++)
      for (let k = 0; k < MARKER_SPAN; k++) {
        const ch = encodeMarker(t, k);
        expect(seen.has(ch)).toBe(false);
        seen.add(ch);
        expect(decodeMarker(ch)).toEqual({ typist: t, slot: k });
      }
    expect(encodeMarker(1, MARKER_SPAN + 5)).toBe(encodeMarker(1, 5)); // slots wrap per typist
    expect(decodeMarker('a')).toBeNull();
    expect(decodeMarker('日')).toBeNull();
    expect(decodeMarker('\n')).toBeNull();
  });

  it('NFR-PERF-06: CPU is the share of one core used between two samples', () => {
    expect(cpuPercent(1000, 1100, 1)).toBe(100); // 100 ticks in one second at 100 Hz
    expect(cpuPercent(1000, 1050, 2)).toBe(25);
    expect(cpuPercent(0, 0, 1)).toBe(0);
    expect(cpuPercent(5, 9, 0)).toBe(0);
  });

  it('NFR-PERF-06: /proc stat and statm are read even when the process name has spaces and brackets', () => {
    const stat =
      '4242 (node (collab) x) S 1 4242 4242 0 -1 4194560 100 0 0 0 350 150 0 0 20 0 11 0 1000 1 2 3';
    const r = parseProc(stat, '300000 25600 3000 100 0 4000 0');
    expect(r.ticks).toBe(500);
    expect(r.rssBytes).toBe(25600 * 4096);
    expect(() => parseProc('garbage', '')).toThrow();
  });

  it('NFR-PERF-06: a room always maps to the same instance and rooms spread over all of them', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `room-${i}-${i * 7919}`);
    for (const id of ids) expect(instanceFor(id, 3)).toBe(instanceFor(id, 3));
    const counts = [0, 0];
    for (const id of ids) counts[instanceFor(id, 2)]!++;
    expect(counts[0]).toBeGreaterThan(120);
    expect(counts[1]).toBeGreaterThan(120);
    expect(instanceFor('x', 1)).toBe(0);
  });

  it('NFR-PERF-06: the seeded generator repeats exactly', () => {
    const a = rng(7);
    const b = rng(7);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(rng(7)()).not.toBe(rng(8)());
  });

  it('NFR-PERF-06: the defaults are the SRS point (10 rooms of 3, two instances); bad numbers are refused', () => {
    expect(parseArgs([])).toMatchObject({
      rooms: 10,
      typistsMin: 3,
      typistsMax: 3,
      rate: 4,
      seconds: 30,
      instances: 2,
      awareness: true,
    });
    expect(
      parseArgs(['--rooms', '50', '--typists', '2-4', '--no-awareness', '--out', 'x.json']),
    ).toMatchObject({
      rooms: 50,
      typistsMin: 2,
      typistsMax: 4,
      awareness: false,
      out: 'x.json',
    });
    expect(() => parseArgs(['--rooms', '0'])).toThrow();
    expect(() => parseArgs(['--rooms', 'many'])).toThrow();
    expect(() => parseArgs(['--typists', '5'])).toThrow();
    expect(() => parseArgs(['--typists', '4-2'])).toThrow();
    expect(() => parseArgs(['--typists', 'x'])).toThrow();
    expect(() => parseArgs(['--rate', '10', '--seconds', '200'])).toThrow(); // more keystrokes than distinct markers
  });
});
