/**
 * CP-08: the pure parts of the pad load driver (`pad-load.ts`), so they can be tested without starting anything.
 */

/** p in [0,1], linear interpolation between ranks (the same as Postgres' percentile_cont and `tests/load/lib.mjs`). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const rank = (v.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo]! + (v[hi]! - v[lo]!) * (rank - lo);
}

export interface Summary {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function summarize(values: number[]): Summary {
  if (values.length === 0) return { n: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  let sum = 0;
  let max = -Infinity;
  for (const x of values) {
    sum += x;
    if (x > max) max = x;
  }
  return {
    n: values.length,
    mean: sum / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max,
  };
}

/** A small seeded generator, so a run can be repeated exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every typed character is a unique private-use character that says who typed it and which keystroke it was, so a
 * receiver can look up when it was sent. 4 typists × 1,500 keystrokes fit in the private-use block (6,400 characters).
 */
export const MARKER_BASE = 0xe000;
export const MARKER_SPAN = 1500;
export const MAX_TYPISTS = 4;

export const encodeMarker = (typist: number, keystroke: number): string =>
  String.fromCodePoint(MARKER_BASE + typist * MARKER_SPAN + (keystroke % MARKER_SPAN));

export function decodeMarker(ch: string): { typist: number; slot: number } | null {
  const cp = ch.codePointAt(0)!;
  const off = cp - MARKER_BASE;
  if (off < 0 || off >= MAX_TYPISTS * MARKER_SPAN) return null;
  return { typist: Math.floor(off / MARKER_SPAN), slot: off % MARKER_SPAN };
}

/** CPU use of a process between two samples of `utime + stime` (clock ticks), as a percentage of one core. */
export function cpuPercent(
  ticksBefore: number,
  ticksAfter: number,
  seconds: number,
  hz = 100,
): number {
  return seconds > 0 ? (100 * (ticksAfter - ticksBefore)) / hz / seconds : 0;
}

/** `utime + stime` in clock ticks and the resident set in bytes, from the text of `/proc/<pid>/stat` and `statm`. */
export function parseProc(stat: string, statm: string, pageSize = 4096) {
  // the process name may contain spaces and parentheses, so count fields after the last ")"
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(statm.split(' ')[1]);
  if (![utime, stime, rssPages].every(Number.isFinite)) throw new Error('unreadable /proc data');
  return { ticks: utime + stime, rssBytes: rssPages * pageSize };
}

/** Chooses the instance of a room the way an edge routing by URI hash does: always the same one for one room. */
export function instanceFor(roomId: string, instances: number): number {
  let h = 2166136261;
  for (let i = 0; i < roomId.length; i++) {
    h ^= roomId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % instances;
}

export interface Config {
  rooms: number;
  typistsMin: number;
  typistsMax: number;
  /** Keystrokes per second per typist. */
  rate: number;
  seconds: number;
  instances: number;
  seed: number;
  awareness: boolean;
}

/** `--rooms 10 --typists 2-4 …`, with the defaults of the SRS point (NFR-PERF-06: 10 rooms × 3 users). */
export function parseArgs(argv: string[]): Config & { out?: string; label?: string } {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, dflt: number) => {
    const v = get(name);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
    return n;
  };
  const t = get('typists') ?? '3';
  const m = /^(\d+)(?:-(\d+))?$/.exec(t);
  if (!m) throw new Error('--typists is N or MIN-MAX');
  const typistsMin = Number(m[1]);
  const typistsMax = Number(m[2] ?? m[1]);
  if (typistsMin < 1 || typistsMax < typistsMin || typistsMax > MAX_TYPISTS)
    throw new Error(`--typists must be between 1 and ${MAX_TYPISTS}`);
  const rate = num('rate', 4);
  const seconds = num('seconds', 30);
  if (rate * seconds > MARKER_SPAN)
    throw new Error(`rate × seconds must be at most ${MARKER_SPAN}`);
  return {
    rooms: Math.floor(num('rooms', 10)),
    typistsMin,
    typistsMax,
    rate,
    seconds,
    instances: Math.floor(num('instances', 2)),
    seed: Math.floor(num('seed', 1)),
    awareness: !argv.includes('--no-awareness'),
    ...(get('out') ? { out: get('out') } : {}),
    ...(get('label') ? { label: get('label') } : {}),
  };
}
