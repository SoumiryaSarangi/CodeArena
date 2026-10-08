import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubAdmin } from './stub-admin';
import { stubContests } from './stub-contests';

const ENDED = { startsInSec: -300 * 60, durationMin: 120, registered: true };
const ID = '11111111-1111-4111-8111-111111111111';

async function ops(page: Page) {
  await stubApi(page, { role: 'admin' });
  await stubAdmin(page);
  const st = await stubContests(page, ENDED);
  st.published = true;
  st.problemPuts.push({ items: [{ label: 'A', slug: 'hop-distances' }] });
  await page.goto(`/admin/contests/${ID}/ops`);
  await expect(page.getByRole('heading', { name: 'Queue and judges' })).toBeVisible();
  return st;
}

test.describe('C-08: finalising and ratings', () => {
  test('FR-CONT-07: Finalize asks first, then finalises; Recompute takes its place', async ({
    page,
  }) => {
    const st = await ops(page);
    await page.getByRole('button', { name: 'Finalize…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Finalize this contest?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(st.ops.finalizes).toBe(0);
    await page.getByRole('button', { name: 'Finalize…' }).click();
    await dialog.getByRole('button', { name: 'Finalize', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Finalised. Ratings changed for 3' }),
    ).toBeVisible();
    expect(st.ops.finalizes).toBe(1);
    await expect(page.getByRole('button', { name: 'Finalize…' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Recompute ratings' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'the same 3 results' })).toBeVisible();
    expect(st.ops.recomputes).toBe(1);
  });

  test('Finalize is only offered once the contest has ended', async ({ page }) => {
    await stubApi(page, { role: 'admin' });
    await stubAdmin(page);
    const st = await stubContests(page, { startsInSec: -30 * 60, durationMin: 180 });
    st.published = true;
    await page.goto(`/admin/contests/${ID}/ops`);
    await expect(page.getByRole('heading', { name: 'Queue and judges' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finalize…' })).toHaveCount(0);
  });

  test('FR-RATE-01: the final scoreboard shows each rating change next to the standings', async ({
    page,
  }) => {
    await stubApi(page);
    await stubContests(page, { ...ENDED, finalized: true });
    await page.goto('/c/warm-up-1/board');
    await expect(page.getByText('Final', { exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Rating' })).toBeVisible();
    const amy = page.getByRole('row', { name: /amy/ });
    await expect(amy).toContainText('1432 (+32)');
    await expect(amy).toContainText('rating changed from 1400 to 1432');
    await expect(page.getByRole('row', { name: /riya_k/ })).toContainText('1493 (−7)');
    await expect(page.getByRole('row', { name: /zed/ })).toContainText('1300 (±0)');
    await expect(page.getByRole('row', { name: /bob/ })).toContainText('—');
  });

  test('before the contest is final there is no rating column', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, ENDED);
    await page.goto('/c/warm-up-1/board');
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Rating' })).toHaveCount(0);
  });
});

test.describe('C-08: profile rating graph (S12)', () => {
  test('FR-RATE-03: rating, graph and contest history, newest first', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, ENDED);
    await page.goto('/u/riya_k');
    await expect(page.getByRole('heading', { level: 1, name: 'riya_k' })).toBeVisible();
    await expect(page.getByText('after 3 rated contests')).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'Rating over 3 contests, from 1400 to 1493' }),
    ).toBeVisible();
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows.nth(1)).toContainText('Warm-up #1');
    await expect(rows.nth(1)).toContainText('+73');
    await expect(rows.nth(2)).toContainText('Contest Two');
    await expect(rows.nth(2)).toContainText('−30');
    await expect(rows.nth(3)).toContainText('Contest One');
    await expect(page.getByRole('link', { name: 'Warm-up #1' })).toHaveAttribute(
      'href',
      '/c/warm-up-1/board',
    );
  });

  test('a new user has no graph, and an unknown handle is not found', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, ENDED);
    await page.goto('/u/newbie');
    await expect(page.getByText('unrated so far')).toBeVisible();
    await expect(page.getByText('Rated contests will show up here.')).toBeVisible();
    await expect(page.getByRole('img', { name: /Rating over/ })).toHaveCount(0);
    await page.goto('/u/ghost');
    await expect(page.getByText('No such user.')).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`C-08 a11y: profile and final scoreboard, ${theme}, ${size.width}px`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page);
      await stubContests(page, { ...ENDED, finalized: true });
      const check = async (what: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `${what} overflows the page`,
        ).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          results.violations
            .filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .map((v) => `${what} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
        ).toEqual([]);
      };
      await page.goto('/u/riya_k');
      await expect(page.getByRole('img', { name: /Rating over/ })).toBeVisible();
      await check('profile');
      await page.goto('/c/warm-up-1/board');
      await expect(page.getByRole('columnheader', { name: 'Rating' })).toBeVisible();
      await check('final scoreboard');
      await ctx.close();
    });
  }
}
