import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubAdmin } from './stub-admin';
import { stubContests } from './stub-contests';

const RUNNING = { startsInSec: -30 * 60, durationMin: 180, registered: true };
const ENDED = { startsInSec: -300 * 60, durationMin: 120, registered: true };
const ID = '11111111-1111-4111-8111-111111111111';

async function open(page: Page, opts: Parameters<typeof stubContests>[1] = RUNNING) {
  await stubApi(page, { role: 'admin' });
  await stubAdmin(page);
  const st = await stubContests(page, opts);
  st.published = true;
  st.problemPuts.push({
    items: [
      { label: 'A', slug: 'hop-distances' },
      { label: 'B', slug: 'lantern-lighting' },
    ],
  });
  await page.goto(`/admin/contests/${ID}/ops`);
  await expect(page.getByRole('heading', { name: 'Queue and judges' })).toBeVisible();
  return st;
}
const status = (page: Page) => page.getByRole('status').filter({ hasText: /\S/ });

test.describe('C-07: contest operations (S16)', () => {
  test('FR-OPS-01: tiles, lane depths and a workers table with stale heartbeats flagged', async ({
    page,
  }) => {
    await open(page);
    const tiles = page.getByRole('term').locator('xpath=..');
    await expect(tiles.filter({ hasText: 'Submissions / min' })).toContainText('4.2');
    await expect(tiles.filter({ hasText: 'Waiting in queue' })).toContainText('7');
    await expect(tiles.filter({ hasText: 'p50 / p95' })).toContainText('1.2 s / 3.4 s');
    await expect(tiles.filter({ hasText: 'Dead letters' })).toContainText('1');
    await expect(
      page.getByText('contest 2 · interactive 0 · practice 5 · rejudge 0'),
    ).toBeVisible();
    const w1 = page.getByRole('row', { name: /judge-1/ });
    await expect(w1).toContainText('Busy');
    await expect(w1).toContainText('1/2');
    await expect(w1).toContainText('1.5 s ago');
    const w2 = page.getByRole('row', { name: /judge-2/ });
    await expect(w2).toContainText('Unhealthy');
    await expect(w2.getByTestId('restarts')).toContainText('restarted 3×');
    await expect(w2).toContainText('14.0 s ago');
  });

  test('no judge reporting is an alert', async ({ page }) => {
    const st = await open(page);
    st.ops.summary = { ...st.ops.summary, workers: [] };
    await expect(page.getByRole('alert').filter({ hasText: 'No judge is reporting' })).toBeVisible({
      timeout: 8000,
    });
  });

  test('FR-CONT-05: Extend sends the minutes and confirms; an error is shown', async ({ page }) => {
    const st = await open(page);
    await page.getByRole('button', { name: '+10 min' }).click();
    await expect(status(page).first()).toContainText('Extended by 10 minutes');
    expect(st.ops.extended).toEqual([10]);
    st.ops.extendError = 'A contest is at most 1023 minutes';
    await page.getByRole('button', { name: '+5 min' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'at most 1023' })).toBeVisible();
    expect(st.ops.extended).toEqual([10]);
  });

  test('extend is disabled once the contest is over, and the resolver link appears', async ({
    page,
  }) => {
    await open(page, ENDED);
    await expect(page.getByRole('button', { name: '+10 min' })).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Open resolver' })).toHaveAttribute(
      'href',
      '/c/warm-up-1/board?present=1',
    );
  });

  test('hide and show a problem', async ({ page }) => {
    const st = await open(page);
    const list = page.getByRole('list', { name: 'Problem visibility' });
    await expect(list.getByRole('listitem').nth(1)).toContainText('Visible');
    await page.getByRole('button', { name: 'Hide problem B' }).click();
    await expect(status(page).first()).toContainText('Problem B is hidden');
    expect(st.ops.hidden).toEqual({ B: true });
    await expect(list.getByRole('listitem').nth(1)).toContainText('Hidden from contestants');
    await page.getByRole('button', { name: 'Show problem B' }).click();
    await expect(list.getByRole('listitem').nth(1)).toContainText('Visible');
    expect(st.ops.hidden).toEqual({ B: false });
  });

  test('FR-OPS-02: rejudge by contest, by problem and by submission, with urgent', async ({
    page,
  }) => {
    const st = await open(page);
    await page.getByRole('button', { name: 'Rejudge…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rejudge' });
    await dialog.getByRole('button', { name: 'Rejudge' }).click();
    await expect(status(page).first()).toContainText('Rejudge: 3 queued, 1 skipped.');
    expect(st.ops.rejudged.at(-1)).toEqual({ scope: 'contest', id: ID, urgent: false });

    await page.getByRole('button', { name: 'Rejudge…' }).click();
    await dialog.getByLabel('Every submission of one problem').check();
    await dialog.getByRole('combobox').selectOption({ label: 'B · Hop Distances' });
    await dialog.getByLabel(/^Urgent/).check();
    await dialog.getByRole('button', { name: 'Rejudge' }).click();
    await expect.poll(() => st.ops.rejudged.length).toBe(2);
    expect(st.ops.rejudged.at(-1)).toEqual({ scope: 'problem', id: 'pid-B', urgent: true });

    await page.getByRole('button', { name: 'Rejudge…' }).click();
    await dialog.getByLabel('One submission').check();
    const go = dialog.getByRole('button', { name: 'Rejudge' });
    await expect(go).toBeDisabled(); // needs an id
    await dialog.getByLabel('Submission id').fill('bbbbbbbb-2222-4222-8222-222222222222');
    await go.click();
    await expect.poll(() => st.ops.rejudged.length).toBe(3);
    expect(st.ops.rejudged.at(-1)).toMatchObject({
      scope: 'submission',
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
    });
  });

  test('rebuild the board', async ({ page }) => {
    const st = await open(page);
    await page.getByRole('button', { name: 'Rebuild board' }).click();
    await expect(status(page).first()).toContainText('The board was rebuilt');
    expect(st.ops.rebuilds).toBe(1);
  });

  test('FR-OPS-01: dead letters list and re-queue', async ({ page }) => {
    const st = await open(page);
    const item = page.getByRole('list', { name: 'Dead letters' }).getByRole('listitem');
    await expect(item).toContainText('aaaaaaaa');
    await expect(item).toContainText('crash-loop');
    await page.getByRole('button', { name: 'Re-queue aaaaaaaa' }).click();
    await expect(status(page).first()).toContainText('Put back on the contest lane');
    expect(st.ops.requeued).toEqual(['1700000000000-0']);
    await expect(page.getByText('Nothing parked.')).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`C-07 a11y: operations console, ${theme}, ${size.width}px, no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await open(page);
      await expect(page.getByRole('row', { name: /judge-2/ })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await page.getByRole('button', { name: 'Rejudge…' }).click();
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
