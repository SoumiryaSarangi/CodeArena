import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';
import { brow, stubContests } from './stub-contests';

const RUNNING = { startsInSec: -30 * 60, durationMin: 180, registered: true };
const LONG = 'a_very_long_handle_that_keeps_going_and_going_2026_campus_cohort';
const noSideScroll = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('UI-12 S10: your standing is shown large above the table, and your row has a marker beyond colour (AUDIT 4, 21)', async ({
  page,
}) => {
  await stubApi(page);
  await stubContests(page, RUNNING);
  await page.goto('/c/warm-up-1/board');
  const standing = page.getByRole('region', { name: 'Your standing' });
  await expect(standing).toContainText('#2');
  await expect(standing).toContainText('of 4');
  await expect(page.locator('tr[data-me] td').first()).toHaveClass(/inset/); // a bar, not only a tint
});

test('UI-12 S10: 150 rows with 64-character handles stay inside the page on a phone, handles truncated (AUDIT 12)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  const st = await stubContests(page, RUNNING);
  st.board.rows = [
    brow('u1', 'riya_k', { A: { acMinute: 30 } }),
    ...Array.from({ length: 150 }, (_, i) =>
      brow(`n${i}`, `${LONG}_${i}`, { A: { acMinute: 40 } }),
    ),
  ];
  await page.goto('/c/warm-up-1/board');
  await expect(page.getByRole('region', { name: 'Your standing' })).toBeVisible();
  expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
  await expect(page.locator('tbody th span[title]').first()).toHaveAttribute('title', /.+/);
});

test('UI-12 S11: the rating change is also said in words, with one next step (AUDIT 4)', async ({
  page,
}) => {
  await stubApi(page);
  await stubContests(page, {
    startsInSec: -4 * 3600,
    durationMin: 120,
    finalized: true,
    reviews: 'mixed',
  });
  await page.goto('/c/warm-up-1/results');
  const summary = page.getByRole('region', { name: 'My result' });
  await expect(summary).toContainText('▼ -7');
  await expect(summary).toContainText('Your rating went down by 7, from 1500 to 1493.');
  await expect(summary.getByRole('link', { name: /^Upsolve B\./ })).toHaveAttribute(
    'href',
    /\/p\//,
  );
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('UI-12 S07: one filled action per row: Register when you are not in, quiet Enter/Open beside it (AUDIT 10)', async ({
  page,
}) => {
  await stubApi(page);
  await stubContests(page);
  await page.goto('/contests');
  await expect(page.getByRole('button', { name: 'Register for Live Now Cup' })).toHaveClass(
    /bg-primary/,
  );
  await expect(page.getByRole('link', { name: 'Enter Live Now Cup' })).not.toHaveClass(
    /bg-primary/,
  );
  const filled = await page
    .locator('li')
    .evaluateAll((rows) =>
      rows.map(
        (r) => r.querySelectorAll('a[class*="bg-primary"],button[class*="bg-primary"]').length,
      ),
    );
  expect(Math.max(...filled)).toBeLessThanOrEqual(1);
});

test('UI-12 S12: a 64-character handle does not widen the page, and graph labels keep their size on a phone (AUDIT 5, 18)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state } = await stubApi(page);
  state.profile.handle = LONG;
  await stubContests(page, { startsInSec: 3600 });
  await page.goto(`/u/${LONG}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('a_very_long_handle');
  expect(await noSideScroll(page)).toBeLessThanOrEqual(0);
  const label = page.locator('svg[role="img"] text').first();
  await expect(label).toBeVisible();
  const px = await label.evaluate((e) => {
    const svg = (e as SVGTextElement).ownerSVGElement!;
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return parseFloat(getComputedStyle(e).fontSize) * scale;
  });
  expect(px).toBeGreaterThanOrEqual(11.5);
});

test('UI-12 S09: in the full view on a phone the Run/Submit bar sits at the screen edge (no bottom bar to clear)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await stubContests(page, RUNNING);
  await page.goto('/c/warm-up-1/A');
  const bar = page.getByRole('button', { name: 'Submit' });
  await expect(bar).toBeVisible();
  const bottom = await bar.evaluate(
    (b) => (b.parentElement as HTMLElement).getBoundingClientRect().bottom,
  );
  expect(Math.round(bottom)).toBe(844);
});
