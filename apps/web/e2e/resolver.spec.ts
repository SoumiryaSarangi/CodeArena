import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { BoardCell, BoardRow } from '@codearena/contracts';
import { packScore, totalsOf } from '../lib/resolver';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

const ENDED = { startsInSec: -300 * 60, durationMin: 120 };

const cell = (over: Partial<BoardCell>): BoardCell => ({
  attempts: 0,
  acMinute: null,
  pending: 0,
  first: false,
  ...over,
});
/** A row with the real packed score, as the API sends it (penalty 20 per rejected attempt). */
const prow = (userId: string, handle: string, cells: Record<string, Partial<BoardCell>>) => {
  const full = Object.fromEntries(Object.entries(cells).map(([l, c]) => [l, cell(c)]));
  const t = totalsOf(full, 20);
  return {
    userId,
    handle,
    solved: t.solved,
    penalty: t.penalty,
    lastAcMinute: t.lastAc,
    score: packScore(t),
    cells: full,
  } satisfies Omit<BoardRow, 'rank'>;
};

/** Live: amy 2 (92), riya 2 (105), bob 1 (8), zed 1 (110). The freeze hid riya B, bob A and zed A. */
const LIVE = [
  prow('u9', 'amy', { A: { acMinute: 12, first: true }, B: { acMinute: 40, attempts: 2 } }),
  prow('u1', 'riya_k', { A: { acMinute: 30, attempts: 1 }, B: { acMinute: 55 } }),
  prow('u8', 'bob', { A: { acMinute: 8 } }),
  prow('u7', 'zed', { A: { acMinute: 70, attempts: 2 } }),
];
const FROZEN = [
  LIVE[0]!,
  prow('u1', 'riya_k', { A: { acMinute: 30, attempts: 1 }, B: { pending: 1 } }),
  prow('u8', 'bob', { A: { pending: 1 } }),
  prow('u7', 'zed', { A: { attempts: 1, pending: 2 } }),
];

async function open(page: Page, role: 'user' | 'admin' = 'admin') {
  await stubApi(page, { role });
  const st = await stubContests(page, ENDED);
  st.board.rows = LIVE;
  st.frozenRows = FROZEN;
  await page.goto('/c/warm-up-1/board?present=1');
  return st;
}

const order = (page: Page) =>
  page
    .locator('tbody th[scope="row"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
const status = (page: Page) =>
  page.getByRole('status').filter({ hasText: /Revealing|Final|Nothing/ });

test.describe('C-06: resolver ceremony (FR-BOARD-06)', () => {
  test('starts from the frozen board and reveals one cell per Space, bottom rank first', async ({
    page,
  }) => {
    await open(page);
    await expect(status(page)).toHaveText('Revealing 0/3');
    expect(await order(page)).toEqual(['amy', 'riya_k', 'bob', 'zed']);
    await expect(page.getByRole('row', { name: /riya_k/ })).toContainText('?1');

    await page.keyboard.press('Space'); // zed (last): A is accepted at minute 70 with 2 rejected
    await expect(status(page)).toHaveText('Revealing 1/3');
    await expect(page.getByRole('row', { name: /zed/ })).toContainText('✓ 70');
    await expect(page.getByText('zed, problem A: accepted')).toBeVisible();
    await expect.poll(() => order(page)).toEqual(['amy', 'riya_k', 'zed', 'bob']); // zed passes bob

    await page.keyboard.press('Space'); // bob (now last): A accepted at 8, a better penalty than riya_k's
    await expect(page.getByRole('row', { name: /bob/ })).toContainText('✓ 8');
    await expect.poll(() => order(page)).toEqual(['amy', 'bob', 'riya_k', 'zed']);

    await page.keyboard.press('Space'); // riya_k: B accepted at 55 → 2 solved, behind amy only
    await expect(status(page)).toHaveText('Final standings.');
    await expect(page.getByRole('row', { name: /riya_k/ })).toContainText('✓ 55');
    await expect(page.getByRole('row', { name: /riya_k/ })).not.toContainText('?');
    await expect.poll(() => order(page)).toEqual(['amy', 'riya_k', 'bob', 'zed']);
  });

  test('the end equals the live scoreboard (ranks, penalties, cells)', async ({
    page,
    context,
  }) => {
    await open(page);
    await page.getByRole('button', { name: /Skip to final/ }).click();
    await expect(status(page)).toHaveText('Final standings.');
    const read = (p: Page) =>
      p.locator('tbody tr').evaluateAll((trs) =>
        trs.map((tr) =>
          [...tr.querySelectorAll('th,td')]
            // what a person sees: the phone-only merged column of the live board is not displayed here (UI-18)
            .filter((c) => getComputedStyle(c).display !== 'none')
            .map((c) => (c.textContent ?? '').replace('(you)', '').trim())
            .join('|'),
        ),
      );
    const resolved = await read(page);
    const board = await context.newPage();
    await stubApi(board, { role: 'admin' });
    const st = await stubContests(board, ENDED);
    st.board.rows = LIVE;
    await board.goto('/c/warm-up-1/board');
    await expect(board.getByRole('table')).toBeVisible();
    expect(await read(board)).toEqual(resolved);
  });

  test('A runs on its own, one reveal per 1.2 s, and stops at the end', async ({ page }) => {
    await open(page);
    await expect(status(page)).toHaveText('Revealing 0/3');
    await page.keyboard.press('a');
    await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
    await expect(status(page)).toHaveText('Final standings.', { timeout: 8000 });
    await expect(page.getByRole('button', { name: /Auto|Pause/ })).toBeDisabled();
  });

  test('Start over returns to the frozen board; Esc leaves for the scoreboard', async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(status(page)).toHaveText('Revealing 0/3');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/c\/warm-up-1\/board$/);
  });

  test('only admins; the scoreboard offers the presenter link to admins after the end', async ({
    page,
    browser,
  }) => {
    await open(page, 'user');
    await expect(page.getByText('Only admins can run the resolver.')).toBeVisible();
    const ctx = await browser.newContext();
    const admin = await ctx.newPage();
    await stubApi(admin, { role: 'admin' });
    await stubContests(admin, ENDED);
    await admin.goto('/c/warm-up-1/board');
    await admin.getByRole('link', { name: 'Present resolver' }).click();
    await expect(admin).toHaveURL(/present=1/);
    await expect(status(admin)).toBeVisible();
    await ctx.close();
  });

  test('a contest the freeze changed nothing in has no steps', async ({ page }) => {
    await stubApi(page, { role: 'admin' });
    const st = await stubContests(page, ENDED);
    st.board.rows = LIVE;
    await page.goto('/c/warm-up-1/board?present=1');
    await expect(status(page)).toHaveText('Nothing was hidden by the freeze.');
    await expect(page.getByRole('button', { name: /Next reveal/ })).toBeDisabled();
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`C-06 a11y: resolver, ${theme}, ${size.width}px`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await open(page);
      await expect(status(page)).toHaveText('Revealing 0/3');
      await page.keyboard.press('Space');
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
      await ctx.close();
    });
  }
}
