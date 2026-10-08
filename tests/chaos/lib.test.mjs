import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardsEqual, evaluate, secs, waitUntil } from './lib.mjs';

const row = (userId, over = {}) => ({
  userId,
  handle: userId,
  solved: 1,
  penalty: 10,
  lastAcMinute: 10,
  score: 5,
  cells: { A: { attempts: 0, acMinute: 10, pending: 0, first: false } },
  ...over,
});

test('O-06: equal boards ignore version and time', () => {
  const a = { version: 3, serverNow: 'x', rows: [row('u1'), row('u2', { solved: 0 })] };
  const b = { version: 9, serverNow: 'y', rows: [row('u1'), row('u2', { solved: 0 })] };
  assert.deepEqual(boardsEqual(a, b), { equal: true, differences: [] });
});

test('O-06: a changed score, a moved row, a missing row and different cells are all reported', () => {
  const a = { rows: [row('u1'), row('u2')] };
  assert.match(
    boardsEqual(a, { rows: [row('u1', { score: 4 }), row('u2')] }).differences[0],
    /score 5 before, 4 after/,
  );
  assert.match(
    boardsEqual(a, { rows: [row('u2'), row('u1')] }).differences[0],
    /position 1 before, 2 after/,
  );
  assert.match(
    boardsEqual(a, { rows: [row('u1')] }).differences.join(' '),
    /2 rows before, 1 after/,
  );
  assert.match(
    boardsEqual(a, { rows: [row('u1'), row('u3')] }).differences.join(' '),
    /u2 is missing/,
  );
  assert.match(
    boardsEqual(a, { rows: [row('u1', { cells: { A: { attempts: 1 } } }), row('u2')] })
      .differences[0],
    /cells differ/,
  );
});

const good = { ok: true, problems: [], submissions: 5, failedSubmissions: 0, withVerdict: 5 };

test('O-06: a clean drill passes every shared check', () => {
  const r = evaluate({ accepted: 5, verification: good, board: { equal: true, differences: [] } });
  assert.equal(r.pass, true);
  assert.equal(r.checks.length, 4);
});

test('O-06: a lost submission, a failed invariant and a different board each fail the drill', () => {
  const board = { equal: true, differences: [] };
  assert.equal(evaluate({ accepted: 6, verification: good, board }).pass, false); // one accepted submission is not stored
  assert.equal(
    evaluate({ accepted: 5, verification: { ...good, ok: false, problems: ['x'] }, board }).pass,
    false,
  );
  assert.equal(
    evaluate({ accepted: 5, verification: good, board: { equal: false, differences: ['d'] } }).pass,
    false,
  );
});

test('O-06: scenario expectations: a visible fault needs a signal, an SSE drill needs later events (a reconnect is optional)', () => {
  const base = { accepted: 5, verification: good, board: { equal: true, differences: [] } };
  assert.equal(
    evaluate({ ...base, expect: { visible: true }, observed: { detectMs: 4200 } }).pass,
    true,
  );
  assert.equal(
    evaluate({ ...base, expect: { visible: true }, observed: { detectMs: null } }).pass,
    false,
  );
  assert.equal(
    evaluate({ ...base, expect: { visible: false }, observed: { detectMs: null } }).pass,
    true,
  );
  assert.equal(
    evaluate({
      ...base,
      expect: { sseResumed: true },
      observed: { sseReconnects: 1, sseEventsAfter: 3 },
    }).pass,
    true,
  );
  assert.equal(
    evaluate({
      ...base,
      expect: { sseResumed: true },
      observed: { sseReconnects: 1, sseEventsAfter: 0 },
    }).pass,
    false,
  );
});

test('O-06: rows the API marked failed (it told the contestant) are a refusal, not a loss, but cannot exceed the refusals', () => {
  const board = { equal: true, differences: [] };
  const withFailed = { ...good, submissions: 8, failedSubmissions: 3 };
  assert.equal(
    evaluate({ accepted: 5, verification: withFailed, board, observed: { refused: 3 } }).pass,
    true,
  );
  assert.equal(
    evaluate({ accepted: 5, verification: withFailed, board, observed: { refused: 2 } }).pass,
    false,
  ); // one failed row with no error to the client
  assert.equal(evaluate({ accepted: 5, verification: withFailed, board }).pass, false);
});

test('O-06: extra submissions (the poison one) are expected to be stored too', () => {
  const r = evaluate({
    accepted: 4,
    extraSubmissions: 1,
    verification: good,
    board: { equal: true, differences: [] },
  });
  assert.equal(r.pass, true);
});

test('O-06: waitUntil returns when the probe turns truthy, treats a throwing probe as not yet, and times out', async () => {
  let n = 0;
  const ok = await waitUntil(() => ++n >= 3, { timeoutMs: 2000, everyMs: 5 });
  assert.equal(ok.ok, true);
  const flaky = await waitUntil(
    () => {
      if (++n < 6) throw new Error('refused');
      return 'up';
    },
    { timeoutMs: 2000, everyMs: 5 },
  );
  assert.deepEqual([flaky.ok, flaky.value], [true, 'up']);
  const never = await waitUntil(() => false, { timeoutMs: 50, everyMs: 10 });
  assert.equal(never.ok, false);
});

test('O-06: secs rounds to a tenth and keeps null', () => {
  assert.equal(secs(1234), 1.2);
  assert.equal(secs(null), null);
});
