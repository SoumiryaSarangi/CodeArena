import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { stubApi } from './stub-api';

/**
 * CP-02: the real collab server (apps/collab) and the real web app in real browsers; only the REST API is stubbed.
 * A stand-in for `POST /api/internal/rooms/{id}/authorize` recognises the tickets the stubbed ticket route hands out.
 */
const PORT = Number(process.env.COLLAB_E2E_PORT ?? 1299);
const SERVICE_TOKEN = 'e'.repeat(40);
const ROOM = randomUUID();

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
function roomJson(role: Role, status = 'open') {
  const now = Date.now();
  return {
    id: ROOM,
    role,
    status,
    language: 'cpp17',
    durationMin: 45,
    problem: null,
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

/** A signed-in person in a room: their own browser context, the stubbed REST API, a ticket per connection. */
async function enter(
  context: BrowserContext,
  handle: string,
  role: Role,
  status = 'open',
): Promise<Page> {
  const page = await context.newPage();
  const colorIndex = colour++ % 8;
  await stubApi(page, { handle });
  await page.route(`**/api/rooms/${ROOM}`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(roomJson(role, status)),
    }),
  );
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
    expect(posts).toEqual([{ language: 'python3', durationMin: 60 }]);
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
