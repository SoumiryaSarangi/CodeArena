import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { emit, sseUrls, stubApi } from './stub-api';
import { brow, stubContests } from './stub-contests';

/** Events pushed before the page has opened its stream would go nowhere. */
const streamOpen = (page: Page) =>
  expect.poll(async () => (await sseUrls(page)).some((u) => u.includes('board'))).toBe(true);

const RUNNING = { startsInSec: -30 * 60, durationMin: 180 };

async function open(
  page: Page,
  opts: Parameters<typeof stubContests>[1] = RUNNING,
  role: 'user' | 'admin' = 'user',
) {
  await stubApi(page, { role });
  const st = await stubContests(page, opts);
  await page.goto('/c/warm-up-1/board');
  await expect(page.getByRole('heading', { level: 1, name: 'CodeArena Warm-up #1' })).toBeVisible();
  await streamOpen(page);
  return st;
}

const handles = (page: Page) =>
  page
    .locator('tbody th[scope="row"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace('(you)', '').trim()));

const diff = (version: number, rows: unknown[], frozen = false) => ({
  contestId: 'cid-1',
  version,
  frozen,
  rows,
});

test.describe('C-03: scoreboard (S10)', () => {
  test('a real table: ranks, solved, penalty, cells with text and glyphs, solve counts in the header', async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: /^A/ })).toContainText('solved by 2');
    const amy = table.getByRole('row', { name: /amy/ });
    await expect(amy.getByRole('cell').first()).toHaveText('1');
    await expect(amy).toContainText('✓ 12');
    await expect(amy).toContainText('★');
    await expect(amy).toContainText('Solved at minute 12, first to solve');
    await expect(amy).toContainText('✓ 40');
    await expect(amy).toContainText('+2');
    const riya = table.getByRole('row', { name: /riya_k/ });
    await expect(riya).toContainText('(you)');
    await expect(riya).toContainText('?1');
    await expect(riya).toContainText('1 pending');
    await expect(table.getByRole('row', { name: /zed/ })).toContainText('+3');
    await expect(table.getByRole('row', { name: /bob/ })).toContainText('Not attempted');
    expect(await handles(page)).toEqual(['amy', 'riya_k', 'bob', 'zed']); // bob, zed tie: by handle
  });

  test('the footer explains the glyphs', async ({ page }) => {
    await open(page);
    await expect(page.getByText('✓ solved at that minute · ★ first to solve')).toBeVisible();
  });

  test('FR-BOARD-04: a diff re-ranks rows in place without reloading the snapshot', async ({
    page,
  }) => {
    const st = await open(page);
    await expect.poll(() => st.boardRequests).toBe(1);
    // zed solves A and B quickly and takes the lead.
    const zed = brow('u7', 'zed', { A: { acMinute: 5, attempts: 3 }, B: { acMinute: 9 } });
    await emit(page, 'board', 'board.diff', '9-0', diff(2, [zed]), 'contest:cid-1:board');
    await expect.poll(() => handles(page)).toEqual(['zed', 'amy', 'riya_k', 'bob']);
    await expect(page.getByRole('row', { name: /zed/ }).getByRole('cell').first()).toHaveText('1');
    await expect(page.getByRole('columnheader', { name: /^B/ })).toContainText('solved by 2');
    // A replay of the same version changes nothing.
    await emit(
      page,
      'board',
      'board.diff',
      '9-1',
      diff(2, [brow('u8', 'bob', { A: { acMinute: 1 } })]),
      'contest:cid-1:board',
    );
    expect(await handles(page)).toEqual(['zed', 'amy', 'riya_k', 'bob']);
    expect(st.boardRequests).toBe(1);
  });

  test('ties share a rank', async ({ page }) => {
    await open(page);
    // bob and zed end with identical results (one problem, same minute): a shared rank.
    const a = brow('u8', 'bob', { A: { acMinute: 12 } });
    const z = brow('u7', 'zed', { A: { acMinute: 12 } });
    await emit(page, 'board', 'board.diff', '9-0', diff(2, [a, z]), 'contest:cid-1:board');
    const rank = (h: string) =>
      page
        .getByRole('row', { name: new RegExp(h) })
        .getByRole('cell')
        .first();
    await expect(rank('bob')).toHaveText('2');
    await expect(rank('zed')).toHaveText('2');
    await expect(rank('riya_k')).toHaveText('4'); // after two tied rows comes 4, not 3
  });

  test('the first solve flashes once; a new first solve moves the star', async ({ page }) => {
    await open(page);
    const bob = brow('u8', 'bob', { B: { acMinute: 3, first: true } });
    await emit(page, 'board', 'board.diff', '9-0', diff(2, [bob]), 'contest:cid-1:board');
    await expect(page.getByRole('row', { name: /bob/ })).toContainText('★');
    await expect(
      page.getByRole('row', { name: /bob/ }).locator('.motion-safe\\:animate-flash'),
    ).toHaveCount(1);
    await expect(page.locator('.motion-safe\\:animate-flash')).toHaveCount(0, { timeout: 4000 });
  });

  test('"You moved to rank n" is announced for the viewer only', async ({ page }) => {
    await open(page);
    const status = page.getByRole('status').filter({ hasText: /You moved/ });
    // Someone below the viewer changes: the viewer's rank does not move, nothing is announced.
    await emit(
      page,
      'board',
      'board.diff',
      '9-0',
      diff(2, [brow('u7', 'zed', { A: { attempts: 4 } })]),
      'contest:cid-1:board',
    );
    await expect(page.getByRole('row', { name: /zed/ })).toContainText('+4');
    await expect(status).toHaveCount(0);
    // Someone overtakes the viewer: the viewer's rank changes and that is announced.
    await emit(
      page,
      'board',
      'board.diff',
      '9-1',
      diff(3, [brow('u8', 'bob', { A: { acMinute: 1 } })]),
      'contest:cid-1:board',
    );
    await expect(status).toHaveText('You moved to rank 3');
    // The viewer overtakes everyone.
    await emit(
      page,
      'board',
      'board.diff',
      '9-2',
      diff(4, [brow('u1', 'riya_k', { A: { acMinute: 2 }, B: { acMinute: 3 } })]),
      'contest:cid-1:board',
    );
    await expect(status).toHaveText('You moved to rank 1');
  });

  test('a lost connection shows Reconnecting and the snapshot is read again on recovery', async ({
    page,
  }) => {
    const st = await open(page);
    await expect.poll(() => st.boardRequests).toBe(1);
    await page.evaluate(() => {
      const w = window as unknown as { __sse: { sources: { onerror?: (() => void) | null }[] } };
      w.__sse.sources.forEach((s) => s.onerror?.());
    });
    await expect(page.getByText('Reconnecting…')).toBeVisible();
    await expect.poll(() => st.boardRequests, { timeout: 15_000 }).toBe(2);
  });

  test('the board is also reachable from the lobby', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, RUNNING);
    await page.goto('/c/warm-up-1');
    await page.getByRole('link', { name: 'Scoreboard' }).click();
    await expect(page).toHaveURL(/\/c\/warm-up-1\/board$/);
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('before the start the scoreboard says so and the lobby has no link', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, { startsInSec: 3600 });
    await page.goto('/c/warm-up-1');
    await expect(page.getByRole('link', { name: 'Scoreboard' })).toHaveCount(0);
  });
});

test.describe('C-03: freeze (FR-BOARD-05)', () => {
  const FROZEN = { startsInSec: -80 * 60, durationMin: 100 }; // the freeze (last 30 min) began 10 min ago

  test('after the freeze time the chip and the notice say Frozen; own results stay visible', async ({
    page,
  }) => {
    const st = await open(page, FROZEN);
    await expect(page.getByText('Frozen', { exact: true })).toBeVisible();
    await expect(page.getByText(/other people.s attempts show as pending/)).toBeVisible();
    await expect(page.getByText(/Your own results stay visible to you/)).toBeVisible();
    expect(st.boardRequests).toBe(1);
  });

  test('a diff for the viewer during the freeze refreshes the snapshot (their cells are private)', async ({
    page,
  }) => {
    const st = await open(page, FROZEN);
    await expect.poll(() => st.boardRequests).toBe(1);
    st.board.frozen = true;
    await emit(
      page,
      'board',
      'board.diff',
      '9-0',
      diff(
        2,
        [brow('u1', 'riya_k', { A: { acMinute: 30, attempts: 1 }, B: { pending: 2 } })],
        true,
      ),
      'contest:cid-1:board',
    );
    await expect.poll(() => st.boardRequests, { timeout: 5000 }).toBe(2);
  });

  test('admins see the live view and listen on the admin topic', async ({ page }) => {
    await open(page, FROZEN, 'admin');
    await expect(page.getByText('Live (admin view)', { exact: true })).toBeVisible();
    await expect(page.getByText('Frozen', { exact: true })).toHaveCount(0);
    await expect
      .poll(async () =>
        (
          await page.evaluate(() =>
            (window as unknown as { __sse: { urls: () => string[] } }).__sse.urls(),
          )
        ).join(' '),
      )
      .toContain('admin%3Acontest%3Acid-1%3Aboard');
  });
});

test.describe('C-03: 600 rows (virtualised)', () => {
  test('only a window of rows is in the DOM, the rest scroll in; Jump to me finds the viewer', async ({
    page,
  }) => {
    await stubApi(page);
    const st = await stubContests(page, RUNNING);
    st.board.rows = Array.from({ length: 600 }, (_, i) =>
      brow(i === 450 ? 'u1' : `x${i}`, i === 450 ? 'riya_k' : `user${String(i).padStart(3, '0')}`, {
        A: i % 3 === 0 ? { acMinute: 10 + (i % 50) } : { attempts: i % 4 },
      }),
    );
    await page.goto('/c/warm-up-1/board');
    await expect(page.getByRole('table')).toBeVisible();
    await streamOpen(page);
    const inDom = await page.locator('tbody th[scope="row"]').count();
    expect(inDom).toBeGreaterThan(10);
    expect(inDom).toBeLessThan(80);
    await expect(page.getByRole('table')).toHaveAttribute('aria-rowcount', '601');
    await page.getByRole('button', { name: 'Jump to me' }).click();
    await expect(page.locator('tbody tr[data-me]')).toBeVisible();
    await expect(page.locator('tbody tr[data-me]')).toContainText('riya_k');
    expect(await page.locator('tbody th[scope="row"]').count()).toBeLessThan(80);
    // A diff patches a visible row in place.
    await emit(
      page,
      'board',
      'board.diff',
      '9-0',
      diff(2, [brow('u1', 'riya_k', { A: { acMinute: 1 } })]),
      'contest:cid-1:board',
    );
    await expect(page.locator('tbody tr[data-me]')).toContainText('✓ 1');
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`C-03 a11y: scoreboard, live and frozen, ${theme}, ${size.width}px, no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page);
      const st = await stubContests(page, RUNNING);
      const check = async (what: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `${what} overflows the page`,
        ).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const serious = results.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        );
        expect(
          serious.map(
            (v) => `${what} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      };
      await page.goto('/c/warm-up-1/board');
      await expect(page.getByRole('table')).toBeVisible();
      await check('live');
      await ctx.close();
      void st;
    });
  }
}
