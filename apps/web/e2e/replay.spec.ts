import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { addShape } from '../lib/whiteboard';
import { stubApi } from './stub-api';

/**
 * CP-06: the replay in a real browser, fed by stubbed endpoints that serve a REAL Yjs update log in the server's binary
 * format (checkpoints every 20 updates), so what is shown is genuinely rebuilt from checkpoints and updates.
 */
const ROOM = randomUUID();
const START = Date.UTC(2026, 9, 10, 14, 0, 0);
const EVERY = 20;
const PHRASE = 'def solve(n):\n    return n * 2\n\nprint(solve(21))\n'; // typed one character every 100 ms

interface Rec {
  kind: number;
  seq: number;
  ts: number;
  bytes: Uint8Array;
}
function recorded() {
  const src = new Y.Doc({ gc: false });
  const log: Rec[] = [];
  let now = START;
  src.on('update', (u: Uint8Array) =>
    log.push({ kind: 1, seq: log.length + 1, ts: now, bytes: u }),
  );
  const text = src.getText('code');
  for (const ch of PHRASE) {
    now += 100;
    text.insert(text.length, ch);
  }
  now += 200;
  src.getMap('meta').set('language', 'python3');
  // the board is used at the very end (CP-10): a rectangle, then an arrow
  now += 300;
  addShape(src, { k: 'rect', c: 1, x: 100, y: 100, w: 200, h: 120 });
  now += 300;
  addShape(src, { k: 'arrow', c: 2, x1: 300, y1: 160, x2: 600, y2: 160 });
  const end = now + 500;
  const cks = new Map<number, Uint8Array>();
  const d = new Y.Doc({ gc: false });
  for (const r of log) {
    Y.applyUpdate(d, r.bytes);
    if (r.seq % EVERY === 0) cks.set(r.seq, Y.encodeStateAsUpdate(d));
  }
  return { log, cks, end };
}
const S = recorded();
const textAt = (t: number) => {
  const d = new Y.Doc({ gc: false });
  for (const r of S.log) if (r.ts <= t) Y.applyUpdate(d, r.bytes);
  return d.getText('code').toString();
};
const FINAL = textAt(S.end);

function frame(records: Rec[]) {
  const parts: Buffer[] = [];
  for (const r of records) {
    const h = Buffer.alloc(17);
    h.writeUInt8(r.kind, 0);
    h.writeUInt32BE(r.seq, 1);
    h.writeDoubleBE(r.ts, 5);
    h.writeUInt32BE(r.bytes.length, 13);
    parts.push(h, Buffer.from(r.bytes));
  }
  return Buffer.concat(parts);
}
/** The server's logic, on the recorded log. */
function slice(q: URLSearchParams) {
  const fromSeq = q.get('fromSeq');
  const recs: Rec[] = [];
  let after = 0;
  let upTo: number;
  if (q.get('toTs'))
    upTo = S.log.filter((r) => r.ts <= Date.parse(q.get('toTs')!)).at(-1)?.seq ?? 0;
  else upTo = q.get('toSeq') ? Number(q.get('toSeq')) : Number.MAX_SAFE_INTEGER;
  if (fromSeq === null) {
    const ck = [...S.cks.keys()].filter((k) => k <= upTo).at(-1);
    if (ck) {
      recs.push({ kind: 0, seq: ck, ts: S.log[ck - 1]!.ts, bytes: S.cks.get(ck)! });
      after = ck;
    }
  } else after = Number(fromSeq);
  const ups = S.log.filter((r) => r.seq > after && r.seq <= upTo).slice(0, 1000);
  recs.push(...ups);
  return { body: frame(recs), from: after, to: ups.at(-1)?.seq ?? after };
}

const timeline = {
  startedAt: new Date(START - 1000).toISOString(),
  endedAt: new Date(S.end).toISOString(),
  durationMs: S.end - START + 1000,
  updates: S.log.length,
  lastSeq: S.log.length,
  checkpointEvery: EVERY,
  eventsCut: false,
  events: [
    { seq: 1, ts: new Date(START - 1000).toISOString(), kind: 'join', by: 'meera' },
    { seq: 2, ts: new Date(START + 500).toISOString(), kind: 'join', by: 'asha' },
    {
      seq: 3,
      ts: new Date(START + 2000).toISOString(),
      kind: 'run',
      by: 'asha',
      mode: 'run',
      verdict: 'AC',
      runId: randomUUID(),
    },
    {
      seq: 4,
      ts: new Date(START + 3000).toISOString(),
      kind: 'language',
      by: 'meera',
      language: 'python3',
    },
    {
      seq: 5,
      ts: new Date(START + 4000).toISOString(),
      kind: 'run',
      by: 'meera',
      mode: 'submit',
      verdict: 'WA',
      runId: randomUUID(),
    },
    { seq: 6, ts: new Date(S.end).toISOString(), kind: 'leave', by: 'asha' },
  ],
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function open(page: Page, role: 'interviewer' | 'candidate' = 'interviewer') {
  await stubApi(page, { handle: role === 'interviewer' ? 'meera' : 'asha' });
  const calls: string[] = [];
  await page.route(`**/api/rooms/${ROOM}`, (r) =>
    r.fulfill(
      json({
        id: ROOM,
        role,
        status: 'closed',
        language: 'cpp17',
        durationMin: 45,
        problem: { slug: 'chai-bill', title: 'Chai Bill' },
        createdAt: new Date(START - 5000).toISOString(),
        expiresAt: new Date(START + 9e6).toISOString(),
        memberCount: 2,
        members: [],
      }),
    ),
  );
  await page.route(`**/api/rooms/${ROOM}/timeline`, (r) => {
    calls.push('timeline');
    return r.fulfill(json(timeline));
  });
  await page.route(`**/api/rooms/${ROOM}/playback?**`, (r) => {
    const q = new URL(r.request().url()).searchParams;
    calls.push(`playback?${q}`);
    const s = slice(q);
    return r.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      headers: { 'X-Playback-From-Seq': String(s.from), 'X-Playback-To-Seq': String(s.to) },
      body: s.body,
    });
  });
  await page.route(`**/api/rooms/${ROOM}/notes`, (r) =>
    r.fulfill(
      json({
        body: 'Strong start. Asked about edge cases late.',
        updatedAt: '2026-10-10T14:30:00.000Z',
      }),
    ),
  );
  await page.goto(`/r/${ROOM}/replay`);
  return calls;
}
const shown = async (page: Page) =>
  norm(await page.locator('.monaco-editor .view-lines').first().innerText());
const position = (page: Page) => page.getByRole('slider', { name: 'Position in the session' });
/** Monaco's line text and ours differ in blank-line and trailing whitespace; compare the words and their order. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

test.describe("CP-06: the interviewer's replay", () => {
  test('FR-PAD-10: starts at the beginning, plays the typing back, and ends with the final code and its language', async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Chai Bill: replay' })).toBeVisible();
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
    expect(await shown(page)).toBe('');
    await page.getByRole('group', { name: 'Speed' }).getByRole('button', { name: '4×' }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => (await shown(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    const partial = await shown(page);
    expect(partial.length).toBeLessThan(norm(FINAL).length); // it is playing, not jumping to the end
    await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible({ timeout: 15_000 });
    expect(await shown(page)).toBe(norm(FINAL));
    await expect(page.getByLabel('Replayed code, read-only').first()).toBeAttached();
  });

  test('FR-PAD-10: clicking an event or a marker jumps there and shows the code as it was; the scrubber says the time', async ({
    page,
  }) => {
    const calls = await open(page);
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
    const ev = page.getByRole('list', { name: 'Events in order' });
    await expect(ev).toContainText('@asha joined');
    await expect(ev).toContainText('@asha ran: Accepted');
    await expect(ev).toContainText('Language changed to Python 3');
    await expect(ev).toContainText('@meera submitted: Wrong answer');
    await ev.getByRole('button', { name: /@asha ran: Accepted/ }).click();
    const at = START + 2000;
    await expect.poll(async () => await shown(page), { timeout: 5000 }).toBe(norm(textAt(at)));
    await expect(position(page)).toHaveAttribute('aria-valuetext', /^00:03 of/); // the timeline starts one second before the first edit
    // the same through a marker on the scrubber
    await page
      .getByLabel('Markers')
      .getByRole('button', { name: /00:05 @meera submitted: Wrong answer/ })
      .click();
    await expect
      .poll(async () => await shown(page), { timeout: 5000 })
      .toBe(norm(textAt(START + 4000)));
    // markers sit where their moment is on the scrubber
    const sub = page.getByLabel('Markers').getByRole('button', { name: /@meera submitted/ });
    const left = parseFloat((await sub.getAttribute('style'))!.match(/left:\s*([\d.]+)%/)![1]!);
    expect(left).toBeCloseTo((5000 / timeline.durationMs) * 100, 0);
    // a seek asks for one slice by time, not for the whole log
    const seeks = calls.filter((c) => c.includes('toTs'));
    expect(seeks.length).toBeGreaterThanOrEqual(3);
  });

  test('FR-PAD-10: the scrubber moves with the keyboard; the speed buttons say which is chosen; Space plays and pauses', async ({
    page,
  }) => {
    await open(page);
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
    await position(page).focus();
    await position(page).press('End');
    await expect.poll(async () => await shown(page), { timeout: 5000 }).toBe(norm(FINAL));
    await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible();
    await position(page).press('Home');
    await expect.poll(async () => await shown(page), { timeout: 5000 }).toBe('');
    await position(page).press('ArrowRight'); // five seconds on
    await expect(position(page)).toHaveAttribute('aria-valuetext', /^00:05 of/);
    await position(page).press('ArrowLeft');
    await expect(position(page)).toHaveAttribute('aria-valuetext', /^00:00 of/);
    const speeds = page.getByRole('group', { name: 'Speed' });
    await expect(speeds.getByRole('button', { name: '1×' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await speeds.getByRole('button', { name: '2×' }).click();
    await expect(speeds.getByRole('button', { name: '2×' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(speeds.getByRole('button', { name: '1×' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.locator('h1').click(); // focus on the page, not on a control
    await page.keyboard.press(' ');
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await page.keyboard.press(' ');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  });

  test('FR-PAD-10: 4× covers four times as much of the session as 1× in the same real time', async ({
    page,
  }) => {
    await open(page);
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
    const seconds = async () => {
      const t = (await position(page).getAttribute('aria-valuetext'))!;
      const m = /^(\d\d):(\d\d)/.exec(t)!;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Pause' }).click();
    const slow = await seconds();
    await position(page).focus();
    await position(page).press('Home');
    await expect.poll(seconds).toBe(0);
    await page.getByRole('group', { name: 'Speed' }).getByRole('button', { name: '4×' }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Pause' }).click();
    const fast = await seconds();
    expect(slow).toBeLessThanOrEqual(3);
    expect(fast).toBeGreaterThanOrEqual(Math.max(4, slow * 2.5));
  });

  test('only the interviewer replays: a candidate is told so and no replay request is made', async ({
    page,
  }) => {
    const calls = await open(page, 'candidate');
    await expect(page.getByText('Only the interviewer can replay a session.')).toBeVisible();
    await page.waitForTimeout(500);
    expect(calls).toEqual([]);
  });

  test('the notes are beside the replay, and the page is accessible and fits a phone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
    await expect(page.getByLabel('Your private notes')).toContainText('Strong start.');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    const results = await new AxeBuilder({ page }).include('#main').analyze();
    expect(results.violations).toEqual([]);
  });

  test('ending a room takes the interviewer to the replay; a closed room in the list has a Replay link', async ({
    page,
  }) => {
    await stubApi(page, { handle: 'meera' });
    const open = {
      id: ROOM,
      role: 'interviewer',
      status: 'open',
      language: 'cpp17',
      durationMin: 45,
      problem: null,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 80 * 60_000).toISOString(),
      memberCount: 1,
      members: [{ handle: 'meera', role: 'interviewer' }],
    };
    await page.route(`**/api/rooms/${ROOM}`, (r) => r.fulfill(json(open)));
    await page.route(`**/api/rooms/${ROOM}/close`, (r) => r.fulfill(json({ status: 'closed' })));
    await page.route(`**/api/rooms/${ROOM}/runs`, (r) => r.fulfill(json({ items: [] })));
    await page.route(`**/api/rooms/${ROOM}/notes`, (r) =>
      r.fulfill(json({ body: '', updatedAt: null })),
    );
    await page.route(`**/api/rooms/${ROOM}/timeline`, (r) => r.fulfill(json(timeline)));
    await page.route(`**/api/rooms/${ROOM}/playback?**`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(0) }),
    );
    // the pad's own connection is not what this test is about: keep it silent (a real collab server may be running)
    await page.routeWebSocket(/:\d+\/[0-9a-f-]{36}$/, () => undefined); // only the pad connection (room id at the end of the URL)
    await page.goto(`/r/${ROOM}`);
    await page.getByRole('button', { name: 'End room' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'End room' }).click();
    await expect(page).toHaveURL(new RegExp(`/r/${ROOM}/replay$`));

    await page.route('**/api/rooms', (r) =>
      r.fulfill(
        json({
          items: [
            { ...open, status: 'closed' },
            { ...open, id: randomUUID(), role: 'candidate', status: 'closed' },
          ],
        }),
      ),
    );
    await page.goto('/interview');
    const links = page.getByRole('link', { name: 'Replay' });
    await expect(links).toHaveCount(1); // only where the viewer was the interviewer
    await expect(links.first()).toHaveAttribute('href', `/r/${ROOM}/replay`);
  });
});

test.describe('CP-10: the whiteboard in the replay', () => {
  const board = (page: Page) => page.getByRole('region', { name: 'Replayed whiteboard' });
  const drawn = (page: Page) => board(page).locator('g[data-shape-id]');

  test('FR-PAD-15: the board appears in the replay when it was drawn, as it was at that moment, and is read-only', async ({
    page,
  }) => {
    await open(page);
    await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
    // at the start nothing had been drawn: no board section yet
    await expect(board(page)).toHaveCount(0);
    await position(page).focus();
    await position(page).press('End');
    await expect(board(page)).toBeVisible();
    await expect(drawn(page)).toHaveCount(2);
    expect(
      await drawn(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind'))),
    ).toEqual(['rect', 'arrow']);
    // back to the start: the board is empty again (the section stays so the page does not jump)
    await position(page).press('Home');
    await expect(drawn(page)).toHaveCount(0);
    // read-only: no tools, nothing to select, the canvas is not focusable
    await expect(page.getByRole('toolbar', { name: 'Whiteboard tools' })).toHaveCount(0);
    await position(page).press('End');
    await expect(drawn(page)).toHaveCount(2);
    expect(await board(page).locator('svg[data-board]').getAttribute('tabindex')).toBeNull();
    const results = await new AxeBuilder({ page }).include('#main').analyze();
    expect(results.violations).toEqual([]);
  });
});
