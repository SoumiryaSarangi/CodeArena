import { expect, test, type Page } from '@playwright/test';
import { emit, sseUrls, stubApi } from './stub-api';
import { brow, stubContests } from './stub-contests';

const RUNNING = { startsInSec: -30 * 60, durationMin: 180, registered: true };
const streamOpen = (page: Page) =>
  expect.poll(async () => (await sseUrls(page)).some((u) => u.includes('board'))).toBe(true);
const diff = (version: number, rows: unknown[]) => ({
  contestId: 'cid-1',
  version,
  frozen: false,
  rows,
});

test('UI-18 S10: rows are 36 px, and ranks 1 to 3 are marked beside the number', async ({
  page,
}) => {
  await stubApi(page);
  await stubContests(page, RUNNING);
  await page.goto('/c/warm-up-1/board');
  const row = page.locator('tbody tr').first();
  await expect(row).toBeVisible();
  const h = (await row.boundingBox())!.height;
  expect(h).toBeLessThanOrEqual(37);
  await expect(page.locator('[data-podium="1"]')).toHaveCount(1);
  await expect(page.locator('[data-podium="2"]')).toHaveCount(1);
  await expect(page.locator('[data-podium="4"]')).toHaveCount(0);
});

test('UI-18 S10: your own row stays at the edge of the scroll box when you are far down the list', async ({
  page,
}) => {
  await stubApi(page);
  const st = await stubContests(page, RUNNING);
  st.board.rows = [
    brow('u1', 'riya_k', {}), // last: nothing solved
    ...Array.from({ length: 80 }, (_, i) =>
      brow(`n${i}`, `student_${i}`, { A: { acMinute: 20 + i } }),
    ),
  ];
  await page.goto('/c/warm-up-1/board');
  const box = page.getByLabel('Scoreboard, scrollable');
  await expect(box).toBeVisible();
  await box.evaluate((e) => (e.scrollTop = 0)); // look at the top of a long list
  const me = await page.locator('[data-me]').boundingBox();
  const b = (await box.boundingBox())!;
  expect(me!.y).toBeGreaterThanOrEqual(b.y - 1);
  expect(me!.y + me!.height).toBeLessThanOrEqual(b.y + b.height + 1);
});

test('UI-18 S10: on a phone Solved and Penalty become one short column so two problems fit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await stubContests(page, RUNNING);
  await page.goto('/c/warm-up-1/board');
  await expect(page.getByRole('columnheader', { name: 'Solved · penalty' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Solved', exact: true })).toBeHidden();
  await expect(page.getByRole('row', { name: /riya_k/ })).toContainText('1 · 50');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(0);
});

test('UI-18 S10: the wire on a row follows the board events: judging when something is sent, the verdict when it comes back, gone after a few seconds', async ({
  page,
}) => {
  await stubApi(page);
  await stubContests(page, RUNNING);
  await page.goto('/c/warm-up-1/board');
  await streamOpen(page);
  const mine = page.locator('[data-me]');
  await expect(mine.locator('[data-wire]')).toHaveCount(0);
  // riya sends another attempt on B (the stub row has one pending already)
  const sent = brow('u1', 'riya_k', { A: { acMinute: 30, attempts: 1 }, B: { pending: 2 } });
  await emit(page, 'board', 'board.diff', '9-0', diff(2, [sent]), 'contest:cid-1:board');
  await expect(mine.locator('[data-wire="judging"]')).toBeVisible();
  const solved = brow('u1', 'riya_k', { A: { acMinute: 30, attempts: 1 }, B: { acMinute: 50 } });
  await emit(page, 'board', 'board.diff', '9-1', diff(3, [solved]), 'contest:cid-1:board');
  await expect(mine.locator('[data-wire="AC"]')).toBeVisible();
  await expect(mine.locator('[data-wire]')).toHaveCount(0, { timeout: 9000 });
});

test('UI-18 S07: each row carries its clock, and a running or finished contest links to its standings', async ({
  page,
}) => {
  await stubApi(page);
  await stubContests(page);
  await page.goto('/contests');
  await expect(page.getByText(/^starts in /).first()).toBeVisible();
  await expect(page.getByText(/^ends in /).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Standings of Live Now Cup' })).toHaveAttribute(
    'href',
    '/c/live-now/board',
  );
});

test('UI-18 S12: a long tag list shows the top 10 with the rest one tap away', async ({ page }) => {
  const { state } = await stubApi(page);
  (state.profile.solved as { byTag: unknown }).byTag = Array.from({ length: 40 }, (_, i) => ({
    tag: `tag${i}`,
    count: 40 - i,
  }));
  await stubContests(page, { startsInSec: 3600 });
  await page.goto('/u/riya_k');
  const list = page.getByRole('list', { name: 'By tag (top 10)' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  await page.getByRole('button', { name: 'Show all 40' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(40);
});

test('UI-18 S08: the details list is one column on a phone and the freeze line has no nested brackets', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await stubContests(page, { startsInSec: 3600, registered: true });
  await page.goto('/c/warm-up-1');
  const freeze = page.getByText(/before the end, at /);
  await expect(freeze).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(0);
});

test('UI-19: with reduced motion a new first solve is marked by a ring instead of the flash', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await stubApi(page);
  await stubContests(page, RUNNING);
  await page.goto('/c/warm-up-1/board');
  await streamOpen(page);
  const bob = brow('u8', 'bob', { B: { acMinute: 3, first: true } });
  await emit(page, 'board', 'board.diff', '9-0', diff(2, [bob]), 'contest:cid-1:board');
  await expect(
    page.getByRole('row', { name: /bob/ }).locator('.motion-reduce\\:ring-accent'),
  ).toHaveCount(1);
  await ctx.close();
});
