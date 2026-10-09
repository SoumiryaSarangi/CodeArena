import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

test('AI-03 follow-up: a published editorial is linked from the problem and rendered on its own page', async ({
  page,
}) => {
  await stubApi(page, { editorial: true });
  await page.goto('/p/sum-two-numbers');
  await page.getByRole('link', { name: 'Editorial', exact: true }).click();
  await expect(page).toHaveURL(/\/p\/sum-two-numbers\/editorial$/);
  await expect(
    page.getByRole('heading', { level: 1, name: /Editorial · Two Numbers/ }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Idea' })).toBeVisible();
  await expect(page.locator('strong')).toHaveText('64-bit');
  await page.getByRole('link', { name: 'Back to the problem' }).click();
  await expect(page).toHaveURL(/\/p\/sum-two-numbers$/);
});

test('without a published editorial there is no link, and the page says when editorials appear', async ({
  page,
}) => {
  await stubApi(page);
  await page.goto('/p/sum-two-numbers');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Editorial', exact: true })).toHaveCount(0);
  await page.goto('/p/sum-two-numbers/editorial');
  await expect(page.getByText('There is no editorial for this problem yet.')).toBeVisible();
  await expect(
    page.getByText('published when the contest that used the problem is finalised'),
  ).toBeVisible();
});

test('the results page links each problem to its editorial', async ({ page }) => {
  await stubApi(page);
  await stubContests(page, {
    startsInSec: -4 * 3600,
    durationMin: 120,
    finalized: true,
    reviews: 'mixed',
  });
  await page.goto('/c/warm-up-1/results');
  await expect(
    page.getByRole('region', { name: 'Problem A' }).getByRole('link', { name: 'Editorial' }),
  ).toHaveAttribute('href', '/p/sum-two-numbers/editorial');
});

test('a queued review is picked up when the background writer finishes it, without a reload', async ({
  page,
}) => {
  await page.clock.install();
  await stubApi(page);
  const st = await stubContests(page, {
    startsInSec: -4 * 3600,
    durationMin: 120,
    finalized: true,
    reviews: 'mixed',
    reviewsBusy: true,
  });
  await page.goto('/c/warm-up-1/results');
  const b = page.getByRole('region', { name: 'Problem B' });
  await expect(b).toContainText('Your review is queued');
  // the background writer finishes it
  const item = st.reviews.items.find((i) => i.label === 'B')!;
  item.status = 'ready';
  item.contentMd =
    '### Complexity\nFine.\n### Edge cases you missed\nTest 4.\n### Compared with the intended approach\nSame.\n### Readability\nOK.';
  await page.clock.fastForward(25_000);
  await expect(b.getByRole('heading', { name: 'Complexity' })).toBeVisible();
  await expect(b).not.toContainText('Your review is queued');
});

test('Home shows how many of my contest reviews are ready, and links to them', async ({ page }) => {
  await stubApi(page, { homeReviews: { ready: 2, total: 5 } });
  await page.goto('/home');
  const card = page.getByRole('status').filter({ hasText: 'AI reviews are ready' });
  await expect(card).toContainText('2 of 5 AI reviews are ready for CodeArena Warm-up #1');
  await card.getByRole('link', { name: 'Open your results' }).click();
  await expect(page).toHaveURL(/\/c\/warm-up-1\/results$/);

  const done = await page.context().newPage();
  await stubApi(done, { homeReviews: { ready: 5, total: 5 } });
  await done.goto('/home');
  await expect(
    done.getByText('All 5 AI reviews are ready for CodeArena Warm-up #1.'),
  ).toBeVisible();

  const none = await page.context().newPage();
  await stubApi(none);
  await none.goto('/home');
  await expect(none.getByText('AI review')).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(`editorial page at ${width}px: no violations, no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page, { editorial: true });
    await page.goto('/p/sum-two-numbers/editorial');
    await expect(page.getByRole('heading', { name: 'Idea' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const r = await new AxeBuilder({ page }).analyze();
    expect(
      r.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join('>')).join('|')}`),
    ).toEqual([]);
  });
}
