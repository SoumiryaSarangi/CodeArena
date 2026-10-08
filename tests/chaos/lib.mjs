// Pure helpers for the O-06 failure drills: timing, the board comparison, and the verdict on a drill.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();
export const secs = (ms) => (ms === null || ms === undefined ? null : Math.round(ms / 100) / 10);

/** Polls `fn` until it returns something truthy; `{ok, ms, value}` with ms from the start of the wait. */
export async function waitUntil(fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const t0 = now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch {
      value = undefined; // a probe that throws is "not yet", e.g. the API refusing connections
    }
    if (value) return { ok: true, ms: now() - t0, value };
    if (now() - t0 >= timeoutMs) return { ok: false, ms: now() - t0, value: undefined };
    await sleep(everyMs);
  }
}

/**
 * Compares two board snapshots by what a contestant sees: who is where, with which score and cells.
 * `version` and `serverNow` differ by design (a rebuild bumps the version), so they are ignored.
 */
export function boardsEqual(a, b) {
  const differences = [];
  const rowsA = a?.rows ?? [];
  const rowsB = b?.rows ?? [];
  if (rowsA.length !== rowsB.length)
    differences.push(`${rowsA.length} rows before, ${rowsB.length} after`);
  const byUser = new Map(rowsB.map((r) => [r.userId, r]));
  rowsA.forEach((r, i) => {
    const other = byUser.get(r.userId);
    if (!other) return differences.push(`${r.handle ?? r.userId} is missing after the rebuild`);
    const j = rowsB.indexOf(other);
    if (i !== j)
      differences.push(`${r.handle ?? r.userId}: position ${i + 1} before, ${j + 1} after`);
    for (const key of ['solved', 'penalty', 'lastAcMinute', 'score']) {
      if (r[key] !== other[key])
        differences.push(`${r.handle ?? r.userId}: ${key} ${r[key]} before, ${other[key]} after`);
    }
    if (JSON.stringify(r.cells) !== JSON.stringify(other.cells)) {
      differences.push(`${r.handle ?? r.userId}: cells differ`);
    }
  });
  return { equal: differences.length === 0, differences: differences.slice(0, 10) };
}

/**
 * The verdict on one drill: the invariants every drill shares (NFR-REL-01, FR-BOARD-03) plus what the
 * scenario said must be visible. Each check is `{name, ok, detail}`; the drill passes if all are ok.
 */
export function evaluate({
  accepted,
  extraSubmissions = 0,
  verification,
  board,
  expect = {},
  observed = {},
}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  add(
    'every accepted submission was judged, once',
    verification.submissions === accepted + extraSubmissions &&
      verification.withVerdict === verification.submissions,
    `${accepted + extraSubmissions} accepted, ${verification.submissions} stored, ${verification.withVerdict} with a verdict`,
  );
  add(
    'no lost or duplicated verdict, nothing stuck (verify)',
    verification.ok,
    verification.ok ? '' : verification.problems.join('; '),
  );
  add('the board equals the rebuild from Postgres', board.equal, board.differences.join('; '));
  if (expect.visible !== undefined) {
    add(
      'the fault was visible to an operator',
      expect.visible ? observed.detectMs !== null : true,
      observed.detectMs === null
        ? 'no signal appeared (see notes)'
        : `after ${secs(observed.detectMs)} s`,
    );
  }
  if (expect.sseResumed) {
    // The stream may stay up (the server reconnects to Redis by itself) or drop and be re-opened by the
    // browser; either way events must keep arriving after the fault.
    add(
      'the live-update stream kept delivering events after the fault',
      observed.sseEventsAfter > 0,
      `${observed.sseEventsAfter} event(s) after, ${observed.sseReconnects} reconnect(s)`,
    );
  }
  for (const c of observed.extraChecks ?? []) add(c.name, c.ok, c.detail);
  return { pass: checks.every((c) => c.ok), checks };
}
