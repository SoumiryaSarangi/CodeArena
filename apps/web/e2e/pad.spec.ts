import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { emit, sseUrls, stubApi } from './stub-api';

/**
 * CP-02: the real collab server (apps/collab) and the real web app in real browsers; only the REST API is stubbed.
 * A stand-in for `POST /api/internal/rooms/{id}/authorize` recognises the tickets the stubbed ticket route hands out.
 */
const PORT = Number(process.env.COLLAB_E2E_PORT ?? 1299);
const SERVICE_TOKEN = 'e'.repeat(40);
const ROOM = randomUUID();
const DOC_CAP = 8_000;

type Role = 'interviewer' | 'candidate' | 'observer';
interface Identity {
  userId: string;
  name: string;
  role: Role;
  readOnly: boolean;
  expiresAt: number;
  colorIndex: number;
}
const tickets = new Map<string, Identity>();
let authApi: Server;
let collab: ChildProcess;

const portOpen = (port: number) =>
  new Promise<boolean>((r) => {
    const s = createConnection({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      r(true);
    });
    s.on('error', () => r(false));
  });

test.beforeAll(async () => {
  authApi = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const ticket = (JSON.parse(raw || '{}') as { ticket?: string }).ticket ?? '';
      const who = tickets.get(ticket);
      if (!who || req.headers['x-service-token'] !== SERVICE_TOKEN)
        return void res.writeHead(401).end();
      tickets.delete(ticket);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(who));
    });
  });
  await new Promise<void>((r) => authApi.listen(0, '127.0.0.1', r));
  const apiPort = (authApi.address() as { port: number }).port;
  collab = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
    cwd: resolve(__dirname, '../../collab'),
    env: {
      ...process.env,
      PORT: String(PORT),
      API_URL: `http://127.0.0.1:${apiPort}`,
      COLLAB_SERVICE_TOKEN: SERVICE_TOKEN,
      // the browser tests need no database: documents live in memory (never allowed in production)
      COLLAB_MEMORY: '1',
      // FR-PAD-13 without pasting 2 MB: the cap is lowered for the browser tests
      COLLAB_MAX_DOC_BYTES: String(DOC_CAP),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100 && !(await portOpen(PORT)); i++)
    await new Promise((r) => setTimeout(r, 100));
  expect(await portOpen(PORT)).toBe(true);
});
test.afterAll(async () => {
  collab?.kill();
  await new Promise((r) => authApi?.close(r));
});

let colour = 0;
/** What each page asked of the notes endpoint (CP-05). */
const notesLog = new WeakMap<Page, { method: string; body: Record<string, unknown> | null }[]>();
function roomJson(role: Role, status = 'open', withProblem = false, suggestions = true) {
  const now = Date.now();
  return {
    id: ROOM,
    role,
    status,
    language: 'cpp17',
    durationMin: 45,
    suggestions,
    problem: withProblem ? { slug: 'chai-bill', title: 'Chai Bill' } : null,
    createdAt: new Date(now - 5 * 60_000).toISOString(),
    expiresAt: new Date(now + 85 * 60_000).toISOString(),
    memberCount: 2,
    members: [
      { handle: 'meera', role: 'interviewer' },
      { handle: 'asha', role: 'candidate' },
      { handle: 'ravi', role: 'observer' },
    ],
  };
}

/** A door the test can shut on the pad's WebSocket and open again, to cut the connection to the room (CP-09). */
interface WsGate {
  blocked: boolean;
  open: { close: () => unknown }[];
}
const newGate = (): WsGate => ({ blocked: false, open: [] });
const cutOff = (g: WsGate) => {
  g.blocked = true;
  for (const ws of g.open.splice(0)) void ws.close();
};

/** A signed-in person in a room: their own browser context, the stubbed REST API, a ticket per connection. */
async function enter(
  context: BrowserContext,
  handle: string,
  role: Role,
  status = 'open',
  opts: {
    problem?: boolean;
    /** Lets the test cut and restore this page's connection to the room (CP-09). */
    gate?: WsGate;
    /** This browser keeps no local data (a private window): IndexedDB is not there (CP-09). */
    noStorage?: boolean;
    /** The room was created with code suggestions off (ED-01). */
    suggestionsOff?: boolean;
    /** What the stubbed API answers to a settings change; records it. */
    settings?: (body: Record<string, unknown>) => { status: number; body: unknown };
    notes?: (body: Record<string, unknown>) => { status: number; body: unknown };
    runs?: (body: Record<string, unknown>) => { status: number; body: unknown };
    restore?: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
  } = {},
): Promise<Page> {
  const page = await context.newPage();
  const colorIndex = colour++ % 8;
  await stubApi(page, { handle });
  await page.route(`**/api/rooms/${ROOM}`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(roomJson(role, status, opts.problem, !opts.suggestionsOff)),
    }),
  );
  await page.route('**/api/problems/chai-bill', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        slug: 'chai-bill',
        title: 'Chai Bill',
        statementMd: '# Chai Bill\n\nPrint the bill.\n',
      }),
    }),
  );
  // CP-05: the interviewer's notes. Every request is recorded: a candidate or an observer must make none.
  const log: { method: string; body: Record<string, unknown> | null }[] = [];
  notesLog.set(page, log);
  let saves = 0;
  await page.route(`**/api/rooms/${ROOM}/notes`, (r) => {
    const method = r.request().method();
    const body = method === 'PUT' ? (r.request().postDataJSON() as Record<string, unknown>) : null;
    log.push({ method, body });
    const answer =
      method === 'GET'
        ? { status: 200, body: { body: '', updatedAt: null } }
        : (opts.notes?.(body!) ?? {
            status: 200,
            body: {
              body: body!.body,
              updatedAt: new Date(Date.UTC(2026, 9, 10, 14, 0, ++saves)).toISOString(),
            },
          });
    return r.fulfill({
      status: answer.status,
      contentType: answer.status >= 400 ? 'application/problem+json' : 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  // CP-04: the runs endpoint. The history is empty; a run is answered by the test's handler.
  await page.route(`**/api/rooms/${ROOM}/runs`, (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    }
    const answer = (opts.runs ?? ((b) => ({ status: 202, body: { runId: b.runId } })))(
      r.request().postDataJSON() as Record<string, unknown>,
    );
    return r.fulfill({
      status: answer.status,
      contentType: answer.status >= 400 ? 'application/problem+json' : 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  // ED-01: the interviewer's suggestions switch.
  await page.route(`**/api/rooms/${ROOM}/settings`, (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    const answer = opts.settings?.(body) ?? { status: 200, body };
    return r.fulfill({
      status: answer.status,
      contentType: answer.status >= 400 ? 'application/problem+json' : 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  // CP-07: restore. The test's handler plays the API, and may forward to the real collab server.
  await page.route(`**/api/rooms/${ROOM}/restore`, async (r) => {
    const answer = (await opts.restore?.(
      r.request().postDataJSON() as Record<string, unknown>,
    )) ?? {
      status: 404,
      body: { type: 'about:blank', title: 'Not found', status: 404, code: 'not-found' },
    };
    return r.fulfill({
      status: answer.status,
      contentType: answer.status >= 400 ? 'application/problem+json' : 'application/json',
      body: JSON.stringify(answer.body),
    });
  });
  await page.route('**/api/realtime/ticket', (r) => {
    const ticket = `t-${randomUUID()}`;
    tickets.set(ticket, {
      userId: randomUUID(),
      name: handle,
      role,
      readOnly: role === 'observer',
      expiresAt: Date.now() + 60 * 60_000,
      colorIndex,
    });
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket, expiresAt: Date.now() + 60_000 }),
    });
  });
  if (opts.noStorage)
    await page.addInitScript(() =>
      Object.defineProperty(window, 'indexedDB', { value: undefined }),
    );
  if (opts.gate) {
    const gate = opts.gate;
    // only the pad's connection (the room id is at the end of its URL)
    await page.routeWebSocket(/:\d+\/[0-9a-f-]{36}$/, (ws) => {
      if (gate.blocked) return void ws.close();
      ws.connectToServer(); // everything else passes through unchanged
      gate.open.push(ws);
    });
  }
  await page.goto(`/r/${ROOM}`);
  return page;
}
const editorText = async (page: Page) =>
  (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/\u00a0/g, ' ');
const ready = async (page: Page) => {
  await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
  await expect(page.getByText('Joining the room')).toHaveCount(0);
};
const type = async (page: Page, text: string) => {
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.type(text);
};

test.describe('CP-02: the interview pad (real collab server, stubbed REST API)', () => {
  test("two people see each other's edits and named, coloured cursors; names come from the server", async ({
    browser,
  }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const meera = await enter(a, 'meera', 'interviewer');
    const asha = await enter(b, 'asha', 'candidate');
    await ready(meera);
    await ready(asha);

    await type(meera, 'hello');
    await expect.poll(() => editorText(asha), { timeout: 10_000 }).toContain('hello');
    await type(asha, ' world');
    await expect.poll(() => editorText(meera), { timeout: 10_000 }).toContain('world');

    // who is here: names and roles in words, "(you)" for oneself
    const here = meera.getByRole('list', { name: 'People in the room' });
    await expect(here).toContainText('meera (you)');
    await expect(here).toContainText('asha');
    await expect(here).toContainText('Candidate');
    await expect(asha.getByRole('list', { name: 'People in the room' })).toContainText(
      'Interviewer',
    );

    // the other person's cursor, with their name on the flag
    await type(asha, '!');
    const flag = meera.locator('[class*="yRemoteSelectionHead-"]').first();
    await expect(flag).toBeAttached({ timeout: 10_000 });
    await expect
      .poll(() => flag.evaluate((el) => getComputedStyle(el, '::after').content), {
        timeout: 10_000,
      })
      .toBe('"asha"');
    expect(await meera.locator('style[data-presence]').innerText()).toContain('var(--presence-');
    await a.close();
    await b.close();
  });

  test("the language is shared; an observer is read-only, sees the others' edits, and cannot change the language", async ({
    browser,
  }) => {
    const [ca, cb, cc] = [
      await browser.newContext(),
      await browser.newContext(),
      await browser.newContext(),
    ];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate');
    const ravi = await enter(cc, 'ravi', 'observer');
    for (const p of [meera, asha, ravi]) await ready(p);

    await expect(ravi.getByText("You're observing")).toBeVisible();
    await expect(ravi.getByLabel('Language')).toBeDisabled();
    await expect(meera.getByLabel('Language')).toBeEnabled();

    await meera.getByLabel('Language').selectOption('python3');
    await expect(asha.getByLabel('Language')).toHaveValue('python3');
    await expect(ravi.getByLabel('Language')).toHaveValue('python3');

    await type(meera, 'x = 1');
    await expect.poll(() => editorText(ravi), { timeout: 10_000 }).toContain('x = 1');
    await ravi.locator('.monaco-editor').first().click();
    await ravi.keyboard.type('EVIL');
    await new Promise((r) => setTimeout(r, 600));
    expect(await editorText(ravi)).not.toContain('EVIL'); // the observer's own editor does not even take the keys
    expect(await editorText(meera)).not.toContain('EVIL');
    expect(await editorText(asha)).not.toContain('EVIL');
    await Promise.all([ca.close(), cb.close(), cc.close()]);
  });

  test('a closed room says so, and a person who is not in the room is told how to get in', async ({
    browser,
  }) => {
    const c1 = await browser.newContext();
    const closed = await enter(c1, 'meera', 'interviewer', 'closed');
    await expect(closed.getByText('This room has ended.')).toBeVisible();
    await c1.close();

    const c2 = await browser.newContext();
    const page = await c2.newPage();
    await stubApi(page, { handle: 'zed' });
    await page.route(`**/api/rooms/${ROOM}`, (r) =>
      r.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          title: 'Not found',
          status: 404,
          code: 'not-found',
          detail: 'No such room',
        }),
      }),
    );
    await page.goto(`/r/${ROOM}`);
    await expect(
      page.getByText('Ask the interviewer for an invite link.', { exact: false }),
    ).toBeVisible();
    await c2.close();
  });

  test('a guest is asked to sign in and comes back to the room', async ({ page }) => {
    await stubApi(page, { signedIn: false });
    await page.goto(`/r/${ROOM}`);
    await expect(page.getByText('Sign in to join this room.')).toBeVisible();
    await expect(page.locator('#main').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/signin?returnTo=${encodeURIComponent(`/r/${ROOM}`)}`,
    );
  });

  test('the room page is accessible and fits a phone', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await enter(ctx, 'meera', 'interviewer');
    await ready(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    const results = await new AxeBuilder({ page }).include('#main').analyze();
    expect(results.violations).toEqual([]);
    await ctx.close();
  });
});

test.describe('CP-02: rooms list, invite links', () => {
  test('creating a room posts the choices and opens it; the list shows my rooms with my role', async ({
    page,
  }) => {
    await stubApi(page, { handle: 'meera' });
    const posts: unknown[] = [];
    await page.route('**/api/rooms', (r) => {
      if (r.request().method() === 'POST') {
        posts.push(r.request().postDataJSON());
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(roomJson('interviewer')),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { ...roomJson('interviewer'), problem: { slug: 'chai-bill', title: 'Chai Bill' } },
            { ...roomJson('candidate', 'closed'), id: randomUUID() },
          ],
        }),
      });
    });
    await page.route(`**/api/rooms/${ROOM}`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(roomJson('interviewer', 'closed')),
      }),
    );
    await page.goto('/interview');
    await expect(page.getByRole('heading', { name: 'Interview rooms', level: 1 })).toBeVisible();
    const mine = page.getByRole('list').last();
    await expect(mine).toContainText('Chai Bill');
    await expect(mine).toContainText('Interviewer');
    await expect(mine).toContainText('Candidate');
    await expect(mine).toContainText('Ended');
    await page.getByLabel('Language').selectOption('python3');
    await page.getByLabel('Duration').selectOption('60');
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(page).toHaveURL(new RegExp(`/r/${ROOM}$`));
    expect(posts).toEqual([{ language: 'python3', durationMin: 60, suggestions: true }]);
  });

  test('FR-EDIT-03: the new-room form has the suggestions box, ticked, and unticking it is posted', async ({
    page,
  }) => {
    await stubApi(page, { handle: 'meera' });
    const posts: unknown[] = [];
    await page.route('**/api/rooms', (r) => {
      if (r.request().method() === 'POST') {
        posts.push(r.request().postDataJSON());
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(roomJson('interviewer', 'open', false, false)),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });
    await page.route(`**/api/rooms/${ROOM}`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(roomJson('interviewer', 'closed')),
      }),
    );
    await page.goto('/interview');
    const box = page.getByLabel(/Code suggestions in the editor/);
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByRole('button', { name: 'Create room' }).click();
    await expect(page).toHaveURL(new RegExp(`/r/${ROOM}$`));
    expect(posts).toEqual([{ language: 'cpp17', durationMin: 45, suggestions: false }]);
  });

  test('an invite link joins and opens the room; a bad one says it is not valid; a guest signs in first', async ({
    page,
  }) => {
    await stubApi(page, { handle: 'asha' });
    let answer: 'ok' | 'bad' = 'ok';
    await page.route('**/api/rooms/join', (r) => {
      expect((r.request().postDataJSON() as { token: string }).token).toBe('tok'.repeat(10));
      return answer === 'ok'
        ? r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ roomId: ROOM, role: 'candidate' }),
          })
        : r.fulfill({
            status: 404,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              title: 'Not found',
              status: 404,
              code: 'not-found',
              detail: 'This invite is not valid any more',
            }),
          });
    });
    await page.route(`**/api/rooms/${ROOM}`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(roomJson('candidate', 'closed')),
      }),
    );
    await page.goto(`/r/join?token=${'tok'.repeat(10)}`);
    await expect(page).toHaveURL(new RegExp(`/r/${ROOM}$`));
    answer = 'bad';
    await page.goto(`/r/join?token=${'tok'.repeat(10)}`);
    await expect(page.getByText('This invite is not valid any more')).toBeVisible();
    await page.goto('/r/join');
    await expect(page.getByText('This invite link is incomplete.')).toBeVisible();
  });

  test('a guest with an invite link is sent to sign in and returned to the link', async ({
    page,
  }) => {
    await stubApi(page, { signedIn: false });
    await page.goto(`/r/join?token=${'tok'.repeat(10)}`);
    await expect(page.locator('#main').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/signin?returnTo=${encodeURIComponent(`/r/join?token=${'tok'.repeat(10)}`)}`,
    );
  });
});

/** The room's event stream is open (the page asks for a ticket first, so it is not instant). */
const listening = (page: Page) =>
  expect
    .poll(async () => decodeURIComponent((await sseUrls(page)).join(' ')), { timeout: 10_000 })
    .toContain(`room:${ROOM}`);

const view = (over: object = {}) => ({
  runId: '88888888-8888-4888-8888-888888888881',
  mode: 'run',
  by: 'meera',
  language: 'python3',
  status: 'queued',
  verdict: null,
  timeMs: null,
  memKb: null,
  output: null,
  stderr: null,
  compileLog: null,
  truncated: false,
  tests: [],
  createdAt: new Date().toISOString(),
  ...over,
});

test.describe('CP-04: run and submit from the pad', () => {
  test('FR-PAD-08: Run sends the shared code, language and input; everyone sees who ran it and the same output', async ({
    browser,
  }) => {
    const sent: Record<string, unknown>[] = [];
    const [ca, cb, cc] = [
      await browser.newContext(),
      await browser.newContext(),
      await browser.newContext(),
    ];
    const meera = await enter(ca, 'meera', 'interviewer', 'open', {
      runs: (b) => (sent.push(b), { status: 202, body: { runId: b.runId } }),
    });
    const asha = await enter(cb, 'asha', 'candidate');
    const ravi = await enter(cc, 'ravi', 'observer');
    for (const p of [meera, asha, ravi]) await ready(p);

    // they are listening on the room's topic
    await listening(meera);

    await type(meera, 'print(42)');
    await expect.poll(() => editorText(asha), { timeout: 10_000 }).toContain('print(42)');
    await meera.getByLabel('Input for Run').fill('21\n');
    await meera.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({
      mode: 'run',
      language: 'cpp17',
      source: 'print(42)',
      input: '21\n',
    });
    expect(String(sent[0]!.runId)).toMatch(/^[0-9a-f-]{36}$/);

    // the server tells all three, first "waiting", then the result
    const id = String(sent[0]!.runId);
    for (const p of [meera, asha, ravi]) {
      await emit(p, ROOM, 'room.run', 'e1', view({ runId: id, language: 'cpp17' }), `room:${ROOM}`);
    }
    for (const p of [meera, asha, ravi])
      await expect(p.getByText('Waiting for a judge')).toBeVisible();
    for (const p of [meera, asha, ravi]) {
      await emit(
        p,
        ROOM,
        'room.run',
        'e2',
        view({
          runId: id,
          language: 'cpp17',
          status: 'done',
          verdict: 'AC',
          timeMs: 14,
          output: '42\n',
        }),
        `room:${ROOM}`,
      );
    }
    for (const p of [meera, asha, ravi]) {
      const item = p
        .getByRole('list', { name: 'Runs, newest first' })
        .getByRole('listitem')
        .first();
      await expect(item).toContainText('@meera');
      await expect(item).toContainText('ran');
      await expect(item).toContainText('AC');
      await expect(item).toContainText('14 ms');
      await expect(item.getByText('42')).toBeVisible();
      await expect(p.getByText('Waiting for a judge')).toHaveCount(0); // replaced, not duplicated
      await expect(
        p.getByRole('list', { name: 'Runs, newest first' }).getByRole('listitem'),
      ).toHaveCount(1);
    }
    await Promise.all([ca.close(), cb.close(), cc.close()]);
  });

  test('an observer can read the output but cannot run; Submit needs a problem', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const ravi = await enter(ctx, 'ravi', 'observer');
    await ready(ravi);
    await expect(ravi.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await expect(ravi.getByRole('button', { name: 'Submit' })).toBeDisabled();
    await expect(
      ravi.getByText('you can read the output but not run code', { exact: false }),
    ).toBeVisible();
    await ctx.close();
    const c2 = await browser.newContext();
    const meera = await enter(c2, 'meera', 'interviewer');
    await ready(meera);
    await expect(meera.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    await expect(meera.getByRole('button', { name: 'Submit' })).toBeDisabled();
    await expect(meera.getByText('this room has none attached', { exact: false })).toBeVisible();
    await c2.close();
  });

  test('Submit (with a problem) sends no input and shows per-test verdicts', async ({
    browser,
  }) => {
    const sent: Record<string, unknown>[] = [];
    const ctx = await browser.newContext();
    const asha = await enter(ctx, 'asha', 'candidate', 'open', {
      problem: true,
      runs: (b) => (sent.push(b), { status: 202, body: { runId: b.runId } }),
    });
    await ready(asha);
    await type(asha, 'x');
    await asha.getByRole('button', { name: 'Submit' }).click();
    await expect.poll(() => sent.length).toBe(1);
    await listening(asha);
    expect(sent[0]).toMatchObject({ mode: 'submit' });
    expect(sent[0]).not.toHaveProperty('input');
    await emit(
      asha,
      ROOM,
      'room.run',
      'e3',
      view({
        runId: String(sent[0]!.runId),
        mode: 'submit',
        by: 'asha',
        language: 'cpp17',
        status: 'done',
        verdict: 'WA',
        timeMs: 20,
        tests: [
          { no: 1, verdict: 'AC', timeMs: 3 },
          { no: 2, verdict: 'WA', timeMs: 5 },
        ],
      }),
      `room:${ROOM}`,
    );
    const item = asha
      .getByRole('list', { name: 'Runs, newest first' })
      .getByRole('listitem')
      .first();
    await expect(item).toContainText('submitted');
    await expect(item.getByRole('list', { name: 'Tests' })).toContainText('Test 2 WA');
    await ctx.close();
  });

  test('a run pressed too soon says to wait, and the room can try again', async ({ browser }) => {
    const ctx = await browser.newContext();
    const meera = await enter(ctx, 'meera', 'interviewer', 'open', {
      runs: () => ({
        status: 429,
        body: {
          title: 'Too many requests',
          status: 429,
          code: 'rate-limited',
          detail: 'One run every 2 seconds per room',
        },
      }),
    });
    await ready(meera);
    await meera.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(
      meera.getByText('One run every 2 seconds in this room', { exact: false }),
    ).toBeVisible();
    await expect(meera.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    await ctx.close();
  });

  test('the output panel is accessible', async ({ browser }) => {
    const ctx = await browser.newContext();
    const meera = await enter(ctx, 'meera', 'interviewer', 'open', { problem: true });
    await ready(meera);
    await emit(
      meera,
      ROOM,
      'room.run',
      'e4',
      view({ status: 'done', verdict: 'AC', timeMs: 5, output: 'hi\n', stderr: 'warn\n' }),
      `room:${ROOM}`,
    );
    await expect(meera.getByText('warn')).toBeVisible();
    const results = await new AxeBuilder({ page: meera }).include('#main').analyze();
    expect(results.violations).toEqual([]);
    await ctx.close();
  });
});

test.describe('CP-05: private interviewer notes', () => {
  test('FR-PAD-09: the interviewer has a Notes tab; typing saves once after a pause, with the chain of base times; leaving the box saves at once', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const meera = await enter(ctx, 'meera', 'interviewer');
    await ready(meera);
    await meera.getByRole('tab', { name: 'Notes' }).click();
    const box = meera.getByLabel('Private notes: only you can see these');
    await expect(box).toBeEnabled();
    const log = notesLog.get(meera)!;
    expect(log.filter((c) => c.method === 'GET')).toHaveLength(1);

    await box.pressSequentially('thinks aloud well', { delay: 30 }); // many keystrokes...
    expect(log.filter((c) => c.method === 'PUT')).toHaveLength(0); // ...none of them saves
    await expect
      .poll(() => log.filter((c) => c.method === 'PUT').length, { timeout: 5000 })
      .toBe(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(log.filter((c) => c.method === 'PUT')).toHaveLength(1); // ...and one save in the end
    expect(log.find((c) => c.method === 'PUT')!.body).toEqual({
      body: 'thinks aloud well',
      baseUpdatedAt: null,
    });
    await expect(meera.getByText(/^Saved \d/)).toBeVisible();

    await box.fill('thinks aloud well, slow start');
    await meera.getByRole('tab', { name: 'Code' }).click(); // leaving the box saves at once, not after the pause
    await expect.poll(() => log.filter((c) => c.method === 'PUT').length, { timeout: 500 }).toBe(2);
    const second = log.filter((c) => c.method === 'PUT')[1]!.body!;
    expect(second.body).toBe('thinks aloud well, slow start');
    expect(second.baseUpdatedAt).toBe(new Date(Date.UTC(2026, 9, 10, 14, 0, 1)).toISOString()); // what the first save returned
    await ctx.close();
  });

  test('FR-PAD-09: a candidate and an observer have no Notes tab and never ask for the notes; the text is nowhere in the shared document', async ({
    browser,
  }) => {
    const [ca, cb, cc] = [
      await browser.newContext(),
      await browser.newContext(),
      await browser.newContext(),
    ];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate');
    const ravi = await enter(cc, 'ravi', 'observer');
    for (const p of [meera, asha, ravi]) await ready(p);
    await expect(meera.getByRole('tab', { name: 'Notes' })).toBeVisible();
    for (const p of [asha, ravi]) {
      await expect(p.getByRole('tab', { name: 'Notes' })).toHaveCount(0);
      await expect(p.getByLabel('Private notes: only you can see these')).toHaveCount(0);
    }
    await meera.getByRole('tab', { name: 'Notes' }).click();
    await meera.getByLabel('Private notes: only you can see these').fill('NOTE-ONLY-FOR-ME');
    await expect
      .poll(() => notesLog.get(meera)!.filter((c) => c.method === 'PUT').length, { timeout: 5000 })
      .toBe(1);
    // the shared code is untouched, for everyone including the interviewer's own Code tab
    await meera.getByRole('tab', { name: 'Code' }).click();
    await type(meera, 'print(1)');
    await expect.poll(() => editorText(asha), { timeout: 10_000 }).toContain('print(1)');
    for (const p of [meera, asha, ravi])
      expect(await editorText(p)).not.toContain('NOTE-ONLY-FOR-ME');
    for (const p of [asha, ravi]) {
      expect(await p.content()).not.toContain('NOTE-ONLY-FOR-ME');
      expect(notesLog.get(p)).toEqual([]); // not a single request to the notes endpoint
    }
    await Promise.all([ca.close(), cb.close(), cc.close()]);
  });

  test('a save from another window is not overwritten silently: the interviewer chooses', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    let refuse = true;
    const meera = await enter(ctx, 'meera', 'interviewer', 'open', {
      notes: (b) =>
        refuse
          ? {
              status: 409,
              body: {
                title: 'Changed elsewhere',
                status: 409,
                code: 'conflict',
                detail: 'saved from another window',
              },
            }
          : { status: 200, body: { body: b.body, updatedAt: '2026-10-10T14:30:00.000Z' } },
    });
    await ready(meera);
    await meera.getByRole('tab', { name: 'Notes' }).click();
    const box = meera.getByLabel('Private notes: only you can see these');
    await box.fill('mine');
    await expect(meera.getByText('saved from another window', { exact: false })).toBeVisible({
      timeout: 5000,
    });
    const log = notesLog.get(meera)!;
    const putsBefore = log.filter((c) => c.method === 'PUT').length;
    await box.fill('mine, more'); // typing during a conflict does not keep hammering the server
    await new Promise((r) => setTimeout(r, 1500));
    expect(log.filter((c) => c.method === 'PUT').length).toBe(putsBefore);

    refuse = false;
    await meera.getByRole('button', { name: 'Keep mine' }).click();
    await expect
      .poll(() => log.filter((c) => c.method === 'PUT').at(-1)?.body?.body, { timeout: 5000 })
      .toBe('mine, more');
    await expect(meera.getByText(/^Saved \d/)).toBeVisible();
    await expect(meera.getByRole('button', { name: 'Keep mine' })).toHaveCount(0);
    await ctx.close();
  });

  test('the notes panel is accessible and fits a phone', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const meera = await enter(ctx, 'meera', 'interviewer');
    await ready(meera);
    await meera.getByRole('tab', { name: 'Notes' }).click();
    await expect(meera.getByLabel('Private notes: only you can see these')).toBeVisible();
    expect(
      await meera.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    const results = await new AxeBuilder({ page: meera }).include('#main').analyze();
    expect(results.violations).toEqual([]);
    await ctx.close();
  });
});

test.describe('CP-07: the document size cap', () => {
  test('FR-PAD-13: a paste past the cap is refused with a clear message; the others keep the saved code', async ({
    browser,
  }) => {
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate');
    await ready(meera);
    await ready(asha);
    await type(meera, 'saved code');
    await expect.poll(() => editorText(asha), { timeout: 10_000 }).toContain('saved code');
    const length = (p: Page) =>
      p.evaluate(() =>
        (
          globalThis as unknown as {
            monaco: { editor: { getModels: () => { getValueLength: () => number }[] } };
          }
        ).monaco.editor
          .getModels()[0]!
          .getValueLength(),
      );
    const block = ('x'.repeat(99) + '\n').repeat(Math.floor(DOC_CAP / 2 / 100));
    await asha.locator('.monaco-editor').first().click();
    await asha.keyboard.insertText(block); // fits: about half the cap
    await expect.poll(() => length(meera), { timeout: 10_000 }).toBe(block.length + 10);
    await asha.keyboard.insertText(block); // would pass the cap
    await expect(asha.getByRole('alert').filter({ hasText: '2 MB limit' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(asha.getByRole('alert').filter({ hasText: 'not saved' })).toBeVisible();
    // the editor sends a big paste as many small changes: the server takes them until the cap and no further
    await new Promise((r) => setTimeout(r, 500));
    const kept = await length(meera);
    expect(kept).toBeGreaterThan(block.length);
    expect(kept).toBeLessThanOrEqual(DOC_CAP);
    expect(kept).toBeLessThan(block.length * 2 + 10);
    // the interviewer is not disturbed, and clearing the full pad is never refused. (History is kept for the replay,
    // so deleting does not make room again: that is what the cap is for.)
    await meera.locator('.monaco-editor').first().click();
    await meera.keyboard.press('ControlOrMeta+A');
    await meera.keyboard.press('Delete');
    await expect.poll(() => length(meera), { timeout: 20_000 }).toBe(0);
    await ca.close();
    await cb.close();
  });
});

test.describe('CP-07: restoring a version', () => {
  const show = async (pages: Page[], runId: string) => {
    for (const p of pages) {
      await listening(p);
      await emit(
        p,
        ROOM,
        'room.run',
        `e-${runId}`,
        view({ runId, status: 'done', verdict: 'AC' }),
        `room:${ROOM}`,
      );
    }
  };

  test('FR-PAD-12: the interviewer restores a run and the candidate sees the code and the language go back, without reloading', async ({
    browser,
  }) => {
    const asked: Record<string, unknown>[] = [];
    const saved = new Map([['r1', { text: 'int main() {}', language: 'cpp17' }]]);
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    let interviewerId = '';
    const meera = await enter(ca, 'meera', 'interviewer', 'open', {
      // the API: look the version up, then ask the real collab server to apply it
      restore: async (b) => {
        asked.push(b);
        const snap = saved.get('r1')!;
        const res = await fetch(`http://127.0.0.1:${PORT}/internal/rooms/${ROOM}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-service-token': SERVICE_TOKEN },
          body: JSON.stringify({ ...snap, userId: interviewerId || randomUUID() }),
        });
        return { status: res.status === 200 ? 200 : 500, body: { runId: b.runId } };
      },
    });
    interviewerId = randomUUID();
    const asha = await enter(cb, 'asha', 'candidate');
    await ready(meera);
    await ready(asha);

    await type(meera, 'int main() {}');
    await expect.poll(() => editorText(asha), { timeout: 10_000 }).toContain('int main() {}');
    await show([meera, asha], 'r1');
    // the candidate has no way to restore
    await expect(asha.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);

    await type(asha, ' // and then a lot of other code');
    await asha.getByLabel('Language').selectOption('python3');
    await expect.poll(() => editorText(meera), { timeout: 10_000 }).toContain('other code');
    await expect(meera.getByLabel('Language')).toHaveValue('python3');

    await meera.getByRole('button', { name: 'Restore this version' }).click();
    const dialog = meera.getByRole('dialog', { name: 'Restore this version?' });
    await expect(dialog).toContainText('Everyone in the room will see the code go back');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();

    await expect(meera.getByText(/^Restored the code from @meera's run at/)).toBeVisible();
    expect(asked).toEqual([{ runId: 'r1' }]);
    for (const p of [meera, asha]) {
      await expect.poll(() => editorText(p), { timeout: 10_000 }).toBe('int main() {}');
      await expect(p.getByLabel('Language')).toHaveValue('cpp17');
    }
    await ca.close();
    await cb.close();
  });

  test('FR-PAD-12: the button is only for the interviewer, and a refusal is shown in words', async ({
    browser,
  }) => {
    const [ca, cb, cc] = [
      await browser.newContext(),
      await browser.newContext(),
      await browser.newContext(),
    ];
    const meera = await enter(ca, 'meera', 'interviewer', 'open', {
      restore: async () => ({ status: 404, body: { code: 'not-found', title: 'Not found' } }),
    });
    const asha = await enter(cb, 'asha', 'candidate');
    const ravi = await enter(cc, 'ravi', 'observer');
    for (const p of [meera, asha, ravi]) await ready(p);
    await show([meera, asha, ravi], 'old-run');
    await expect(meera.getByRole('button', { name: 'Restore this version' })).toBeVisible();
    for (const p of [asha, ravi]) {
      await expect(p.getByText('@meera')).toBeVisible();
      await expect(p.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
    }
    await meera.getByRole('button', { name: 'Restore this version' }).click();
    await meera.getByRole('dialog').getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(meera.getByText('That run has no saved version.')).toBeVisible();
    await ca.close();
    await cb.close();
    await cc.close();
  });

  test('the restore dialog is accessible and fits a phone', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const meera = await enter(ctx, 'meera', 'interviewer');
    await ready(meera);
    await show([meera], 'phone-run');
    await meera.getByRole('button', { name: 'Restore this version' }).click();
    await expect(meera.getByRole('dialog', { name: 'Restore this version?' })).toBeVisible();
    expect(
      await meera.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    const results = await new AxeBuilder({ page: meera }).analyze();
    expect(results.violations).toEqual([]);
    await ctx.close();
  });
});

test.describe('ED-01: code suggestions in the pad', () => {
  const widget = (p: Page) => p.locator('.suggest-widget.visible');
  const typeAt = async (p: Page, text: string) => {
    await p.locator('.monaco-editor').first().click();
    await p.keyboard.press('Control+A');
    await p.keyboard.press('Delete');
    await p.keyboard.type(text, { delay: 40 });
  };

  test('FR-EDIT-03: the interviewer switches suggestions off and on, and the candidate follows live without reloading', async ({
    browser,
  }) => {
    const changes: Record<string, unknown>[] = [];
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer', 'open', {
      settings: (b) => (changes.push(b), { status: 200, body: b }),
    });
    const asha = await enter(cb, 'asha', 'candidate');
    await ready(meera);
    await ready(asha);
    await listening(asha);
    // on at first, for both
    await typeAt(asha, 'whi');
    await expect(widget(asha)).toBeVisible();
    await asha.keyboard.press('Escape');
    // only the interviewer has the switch
    await expect(asha.getByRole('button', { name: /^Suggestions/ })).toHaveCount(0);
    const toggle = meera.getByRole('button', { name: 'Suggestions: on' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect.poll(() => changes).toEqual([{ suggestions: false }]);
    await expect(meera.getByRole('button', { name: 'Suggestions: off' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // the server tells the room; the candidate's editor stops suggesting
    await emit(asha, ROOM, 'room.settings', 's1', { suggestions: false }, `room:${ROOM}`);
    await typeAt(asha, 'whi');
    await asha.waitForTimeout(800);
    await expect(widget(asha)).toHaveCount(0);
    await asha.keyboard.press('Control+Space');
    await asha.waitForTimeout(400);
    await expect(widget(asha)).toHaveCount(0);
    // and back on
    await meera.getByRole('button', { name: 'Suggestions: off' }).click();
    await expect.poll(() => changes.length).toBe(2);
    expect(changes[1]).toEqual({ suggestions: true });
    await emit(asha, ROOM, 'room.settings', 's2', { suggestions: true }, `room:${ROOM}`);
    await typeAt(asha, 'whi');
    await expect(widget(asha)).toBeVisible();
    await ca.close();
    await cb.close();
  });

  test('FR-EDIT-03: a room created with suggestions off starts off for everyone, observers included', async ({
    browser,
  }) => {
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer', 'open', { suggestionsOff: true });
    const asha = await enter(cb, 'asha', 'candidate', 'open', { suggestionsOff: true });
    await ready(meera);
    await ready(asha);
    await expect(meera.getByRole('button', { name: 'Suggestions: off' })).toBeVisible();
    await typeAt(asha, 'whi');
    await asha.waitForTimeout(800);
    await expect(widget(asha)).toHaveCount(0);
    await ca.close();
    await cb.close();
  });

  test('FR-EDIT-03: a refused change says so and leaves the switch where it was', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const meera = await enter(ctx, 'meera', 'interviewer', 'open', {
      settings: () => ({
        status: 410,
        body: { code: 'room-closed', title: 'Room is closed', detail: 'The room has ended' },
      }),
    });
    await ready(meera);
    await meera.getByRole('button', { name: 'Suggestions: on' }).click();
    await expect(meera.getByRole('alert').filter({ hasText: /ended|closed/i })).toBeVisible();
    await expect(meera.getByRole('button', { name: 'Suggestions: on' })).toBeVisible();
    await ctx.close();
  });
});

test.describe('CP-08: real browsers converge under concurrent typing', () => {
  test('FR-PAD-07: two people typing at the same moment and an observer end with the same text, and no keystroke is lost', async ({
    browser,
  }) => {
    const [ca, cb, cc] = [
      await browser.newContext(),
      await browser.newContext(),
      await browser.newContext(),
    ];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate');
    const ravi = await enter(cc, 'ravi', 'observer');
    for (const p of [meera, asha, ravi]) await ready(p);
    await Promise.all([meera, asha].map((p) => p.locator('.monaco-editor').first().click()));
    // both type 40 characters at once, 25 ms apart, into the same empty document
    await Promise.all([
      meera.keyboard.type('A'.repeat(40), { delay: 25 }),
      asha.keyboard.type('b'.repeat(40), { delay: 25 }),
    ]);
    const count = (t: string, ch: string) => t.split(ch).length - 1;
    for (const p of [meera, asha, ravi])
      await expect
        .poll(
          async () => {
            const t = await editorText(p);
            return `${count(t, 'A')} ${count(t, 'b')}`;
          },
          { timeout: 15_000 },
        )
        .toBe('40 40');
    const texts = await Promise.all([meera, asha, ravi].map(editorText));
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
    await ca.close();
    await cb.close();
    await cc.close();
  });
});

test.describe('CP-09: offline editing', () => {
  const lost = /The connection to the room was lost/;
  const idbNames = (p: Page) =>
    p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));

  test('FR-PAD-14: edits made while the connection is down are kept, shown with a banner, and merge with what others typed when it returns', async ({
    browser,
  }) => {
    const gate = newGate();
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate', 'open', { gate });
    await ready(meera);
    await ready(asha);
    await type(meera, 'shared ');
    await expect.poll(() => editorText(asha), { timeout: 10_000 }).toContain('shared');

    cutOff(gate);
    await expect(asha.getByText(lost)).toBeVisible({ timeout: 15_000 });
    await expect(asha.getByText(/saved on this device/)).toBeVisible();
    await expect(asha.getByText('Reconnecting').first()).toBeVisible();
    await type(asha, 'OFFLINE-ASHA ');
    await type(meera, 'ONLINE-MEERA ');
    // while apart, neither sees the other's new text
    await expect.poll(() => editorText(meera)).toContain('ONLINE-MEERA');
    expect(await editorText(meera)).not.toContain('OFFLINE-ASHA');
    expect(await editorText(asha)).not.toContain('ONLINE-MEERA');

    gate.blocked = false;
    for (const p of [meera, asha])
      await expect
        .poll(
          async () => {
            const t = await editorText(p);
            return t.includes('OFFLINE-ASHA') && t.includes('ONLINE-MEERA');
          },
          { timeout: 45_000 },
        )
        .toBe(true);
    expect(await editorText(asha)).toBe(await editorText(meera));
    await expect(asha.getByText(lost)).toHaveCount(0);
    await ca.close();
    await cb.close();
  });

  test('FR-PAD-14: a reload while the room cannot be reached still shows the code kept on this device, and it merges later', async ({
    browser,
  }) => {
    const gate = newGate();
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate', 'open', { gate });
    await ready(meera);
    await ready(asha);
    await type(meera, 'start ');
    await expect.poll(() => editorText(asha), { timeout: 10_000 }).toContain('start');

    cutOff(gate);
    await expect(asha.getByText(lost)).toBeVisible({ timeout: 15_000 });
    await type(asha, 'KEPT-ACROSS-RELOAD ');
    await asha.waitForTimeout(800); // written to the browser's database a moment after typing
    await asha.reload();
    // still cut off: the page opens from the copy on this device
    await expect.poll(() => editorText(asha), { timeout: 30_000 }).toContain('KEPT-ACROSS-RELOAD');
    await expect(asha.getByText(lost)).toBeVisible();
    await type(meera, 'MEERA-MEANWHILE ');

    gate.blocked = false;
    for (const p of [meera, asha])
      await expect
        .poll(
          async () => {
            const t = await editorText(p);
            return (
              t.includes('KEPT-ACROSS-RELOAD') &&
              t.includes('MEERA-MEANWHILE') &&
              t.includes('start')
            );
          },
          { timeout: 45_000 },
        )
        .toBe(true);
    expect(await editorText(asha)).toBe(await editorText(meera));
    await ca.close();
    await cb.close();
  });

  test('FR-PAD-14: a first visit does not show an empty editor before the room answers', async ({
    browser,
  }) => {
    const gate = newGate();
    gate.blocked = true; // the room cannot be reached from the start, and nothing was kept
    const ctx = await browser.newContext();
    const asha = await enter(ctx, 'asha', 'candidate', 'open', { gate });
    await expect(asha.getByText('Joining the room')).toBeVisible();
    await asha.waitForTimeout(2000);
    await expect(asha.getByText('Joining the room')).toBeVisible();
    await expect(asha.locator('.monaco-editor')).toHaveCount(0);
    await ctx.close();
  });

  test('FR-PAD-14: the copy kept on this device is removed when the room has ended', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const asha = await enter(ctx, 'asha', 'candidate');
    await ready(asha);
    await type(asha, 'something worth keeping');
    await expect.poll(() => idbNames(asha)).toContain(`codearena-pad:${ROOM}`);
    // the same person opens the room's link again after it ended (same browser, same stored data)
    const again = await enter(ctx, 'asha', 'candidate', 'closed');
    await expect(again.getByText('This room has ended.')).toBeVisible();
    await expect
      .poll(() => idbNames(again), { timeout: 10_000 })
      .not.toContain(`codearena-pad:${ROOM}`);
    await ctx.close();
  });

  test('FR-PAD-14: without browser storage the pad works, and the banner does not promise what is not kept; an observer is only told it reconnects', async ({
    browser,
  }) => {
    const gate = newGate();
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const asha = await enter(ca, 'asha', 'candidate', 'open', { gate, noStorage: true });
    const ravi = await enter(cb, 'ravi', 'observer', 'open', { gate: gate });
    await ready(asha);
    await ready(ravi);
    await type(asha, 'works without storage');
    await expect.poll(() => editorText(ravi), { timeout: 10_000 }).toContain('works without');
    cutOff(gate);
    await expect(asha.getByText(/not saved if you close this tab/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(asha.getByText(/saved on this device/)).toHaveCount(0);
    await expect(
      ravi.getByText('The connection to the room was lost. Reconnecting…'),
    ).toBeVisible();
    await expect(ravi.getByText(/saved on this device/)).toHaveCount(0);
    await ca.close();
    await cb.close();
  });

  test('the offline banner is accessible and fits a phone', async ({ browser }) => {
    const gate = newGate();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const asha = await enter(ctx, 'asha', 'candidate', 'open', { gate });
    await ready(asha);
    cutOff(gate);
    await expect(asha.getByText(lost)).toBeVisible({ timeout: 15_000 });
    expect(
      await asha.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    const results = await new AxeBuilder({ page: asha }).include('#main').analyze();
    expect(results.violations).toEqual([]);
    await ctx.close();
  });
});

test.describe('CP-10: whiteboard', () => {
  const openBoard = async (p: Page) => {
    await p.getByRole('tab', { name: 'Whiteboard' }).click();
    await expect(p.getByRole('toolbar', { name: 'Whiteboard tools' })).toBeVisible();
  };
  const shapes = (p: Page) => p.locator('svg[data-board] g[data-shape-id]');
  const kinds = async (p: Page) =>
    shapes(p).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  /** A point on the board, in the page's pixels (the board is 1200 × 800 units, drawn to fit). */
  const where = async (p: Page, bx: number, by: number) => {
    const b = (await p.locator('svg[data-board]').boundingBox())!;
    const scale = Math.min(b.width / 1200, b.height / 800);
    return {
      x: b.x + (b.width - 1200 * scale) / 2 + bx * scale,
      y: b.y + (b.height - 800 * scale) / 2 + by * scale,
    };
  };
  const tool = (p: Page, name: string) => p.getByRole('button', { name, exact: true }).click();

  test('FR-PAD-15: a rectangle added with a button and a stroke drawn with the mouse reach the other person; erasing is shared too', async ({
    browser,
  }) => {
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate');
    await ready(meera);
    await ready(asha);
    await openBoard(meera);
    await openBoard(asha);

    await meera.getByRole('button', { name: 'Add rectangle' }).click();
    await expect.poll(() => kinds(asha)).toEqual(['rect']);

    await tool(asha, 'Pen');
    const a = await where(asha, 200, 600);
    await asha.mouse.move(a.x, a.y);
    await asha.mouse.down();
    for (let i = 1; i <= 12; i++) {
      const q = await where(asha, 200 + i * 30, 600 - Math.sin(i / 2) * 60);
      await asha.mouse.move(q.x, q.y);
    }
    await asha.mouse.up();
    await expect.poll(() => kinds(meera)).toEqual(['rect', 'pen']);
    // everyone's list names the shapes
    for (const p of [meera, asha]) {
      const list = p.getByRole('region', { name: 'Shapes on the board' });
      await expect(list).toContainText('Rectangle 1');
      await expect(list).toContainText('Pen stroke 2');
    }

    // the eraser removes the rectangle for both: click on its edge (it is 240 × 140 around the middle)
    await tool(asha, 'Eraser');
    const edge = await where(asha, 480, 400);
    await asha.mouse.click(edge.x, edge.y);
    await expect.poll(() => kinds(meera)).toEqual(['pen']);
    await expect.poll(() => kinds(asha)).toEqual(['pen']);
    await ca.close();
    await cb.close();
  });

  test('FR-PAD-15: everything has a way without dragging: the arrow keys and buttons move a shape, Delete removes it, the list selects it', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const meera = await enter(ctx, 'meera', 'interviewer');
    await ready(meera);
    await openBoard(meera);
    await meera.getByRole('button', { name: 'Add rectangle' }).click();
    await meera.getByRole('button', { name: 'Add arrow' }).click();
    const rectX = () => meera.locator('g[data-kind="rect"] rect').first().getAttribute('x');
    expect(await rectX()).toBe('480');

    // choose it from the list (no pointer on the board), then move it with the buttons and with the keys
    await meera
      .getByRole('region', { name: 'Shapes on the board' })
      .getByRole('button', { name: 'Rectangle 1' })
      .click();
    await meera.getByRole('button', { name: 'Move right' }).click(); // 40
    await expect.poll(rectX).toBe('520');
    await meera.getByRole('button', { name: 'Move up' }).click();
    await meera.getByLabel('Whiteboard canvas').focus();
    await meera.keyboard.press('ArrowLeft'); // 8
    await meera.keyboard.press('ArrowLeft');
    await meera.keyboard.press('Shift+ArrowLeft'); // 40
    await expect.poll(rectX).toBe(String(520 - 8 - 8 - 40));
    // Delete removes the selected shape
    await meera.keyboard.press('Delete');
    await expect.poll(() => kinds(meera)).toEqual(['arrow']);
    await meera.getByRole('button', { name: 'Arrow 1' }).click();
    await meera.getByRole('button', { name: 'Delete selected' }).click();
    await expect.poll(() => kinds(meera)).toEqual([]);
    await expect(meera.getByText('Nothing has been drawn yet.')).toBeVisible();
    await ctx.close();
  });

  test('FR-PAD-15: a stroke and a rectangle can be drawn with the keyboard alone, and the other person sees them', async ({
    browser,
  }) => {
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate');
    await ready(meera);
    await ready(asha);
    await openBoard(meera);
    await openBoard(asha);

    await tool(meera, 'Pen');
    await meera.getByLabel('Whiteboard canvas').focus();
    await meera.keyboard.press('Space'); // pen down in the middle
    for (let i = 0; i < 6; i++) await meera.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 4; i++) await meera.keyboard.press('Shift+ArrowDown');
    await meera.keyboard.press('Space'); // pen up
    await expect.poll(() => kinds(asha)).toEqual(['pen']);

    await tool(meera, 'Rectangle');
    await meera.getByLabel('Whiteboard canvas').focus();
    await meera.keyboard.press('Space'); // first corner
    for (let i = 0; i < 5; i++) await meera.keyboard.press('Shift+ArrowLeft');
    for (let i = 0; i < 3; i++) await meera.keyboard.press('Shift+ArrowUp');
    await meera.keyboard.press('Space'); // opposite corner
    await expect.poll(() => kinds(asha)).toEqual(['pen', 'rect']);
    const w = await asha.locator('g[data-kind="rect"] rect').first().getAttribute('width');
    expect(Number(w)).toBe(200);

    // and the eraser works from the keyboard: the cursor is still at the rectangle's corner, which is also where the stroke ends
    await tool(meera, 'Eraser');
    await meera.getByLabel('Whiteboard canvas').focus();
    await meera.keyboard.press('Space'); // the topmost shape under the cursor: the rectangle
    await expect.poll(() => kinds(asha)).toEqual(['pen']);
    await meera.keyboard.press('Space'); // then the stroke
    await expect.poll(() => kinds(asha)).toEqual([]);
    await meera.keyboard.press('Space');
    await expect(meera.getByText('Nothing under the cursor.')).toBeVisible();
    await ca.close();
    await cb.close();
  });

  test('FR-PAD-15: text goes where it is clicked or into the middle, is shown as plain text, and a clear needs confirming', async ({
    browser,
  }) => {
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer');
    const asha = await enter(cb, 'asha', 'candidate');
    await ready(meera);
    await ready(asha);
    await openBoard(meera);
    await openBoard(asha);

    await meera.getByLabel('Text to place').fill('O(n log n)');
    await meera.getByRole('button', { name: 'Add text' }).click();
    await expect(asha.locator('g[data-kind="text"] text')).toHaveText('O(n log n)');
    // click placement
    await tool(asha, 'Text');
    await asha.getByLabel('Text to place').fill('<img src=x onerror="window.__pwned=1">');
    const at = await where(asha, 300, 200);
    await asha.mouse.click(at.x, at.y);
    await expect(meera.locator('g[data-kind="text"] text').nth(1)).toHaveText(
      '<img src=x onerror="window.__pwned=1">',
    );
    expect(
      await meera.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    expect(await meera.locator('svg[data-board] img').count()).toBe(0);
    // an empty text asks for text instead of adding an empty shape
    await asha.getByRole('button', { name: 'Add text' }).click();
    await expect(asha.getByText('Type the text in the box first.')).toBeVisible();
    expect(await kinds(asha)).toEqual(['text', 'text']);

    await asha.getByRole('button', { name: 'Clear board' }).click();
    const dialog = asha.getByRole('dialog', { name: 'Clear the whole board?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await kinds(asha)).toEqual(['text', 'text']);
    await asha.getByRole('button', { name: 'Clear board' }).click();
    await asha.getByRole('dialog').getByRole('button', { name: 'Clear board' }).click();
    await expect.poll(() => kinds(meera)).toEqual([]);
    await ca.close();
    await cb.close();
  });

  test('FR-PAD-15: an observer sees the board live but has no tools and cannot select', async ({
    browser,
  }) => {
    const [ca, cb] = [await browser.newContext(), await browser.newContext()];
    const meera = await enter(ca, 'meera', 'interviewer');
    const ravi = await enter(cb, 'ravi', 'observer');
    await ready(meera);
    await ready(ravi);
    await openBoard(meera);
    await ravi.getByRole('tab', { name: 'Whiteboard' }).click();
    await meera.getByRole('button', { name: 'Add rectangle' }).click();
    await expect.poll(() => kinds(ravi)).toEqual(['rect']);
    await expect(ravi.getByRole('toolbar', { name: 'Whiteboard tools' })).toHaveCount(0);
    await expect(
      ravi.getByText('Read-only board: you can see what is drawn but not draw on it.'),
    ).toBeVisible();
    await expect(ravi.getByRole('button', { name: 'Rectangle 1' })).toBeDisabled();
    // clicking the board does nothing
    const p = await where(ravi, 480, 400);
    await ravi.mouse.click(p.x, p.y);
    expect(await ravi.locator('svg[data-board] [data-selection]').count()).toBe(0);
    await ca.close();
    await cb.close();
  });

  test('FR-PAD-15: the whiteboard is not offered on a phone, and the tab is accessible on a desktop', async ({
    browser,
  }) => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await enter(phone, 'meera', 'interviewer');
    await ready(p);
    await expect(p.getByRole('tab', { name: 'Whiteboard' })).toBeHidden();
    await phone.close();

    const ctx = await browser.newContext();
    const meera = await enter(ctx, 'meera', 'interviewer');
    await ready(meera);
    await openBoard(meera);
    await meera.getByRole('button', { name: 'Add rectangle' }).click();
    await meera.getByLabel('Text to place').fill('hello');
    await meera.getByRole('button', { name: 'Add text' }).click();
    const results = await new AxeBuilder({ page: meera }).include('#main').analyze();
    expect(results.violations).toEqual([]);
    await ctx.close();
  });
});
