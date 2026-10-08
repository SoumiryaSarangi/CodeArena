import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

const open = async (page: Page, opts: Parameters<typeof stubContests>[1], signedIn = true) => {
  await stubApi(page, { signedIn });
  const st = await stubContests(page, { startsInSec: -4 * 3600, durationMin: 120, ...opts });
  await page.goto('/c/warm-up-1/results');
  return st;
};

test('AI-03 / S11: my place and rating change, a ready review with its four sections, and a queued one written on opening', async ({
  page,
}) => {
  const st = await open(page, { finalized: true, reviews: 'mixed' });
  await expect(page.getByRole('heading', { level: 1, name: /Results/ })).toBeVisible();
  const summary = page.getByRole('region', { name: 'My result' });
  await expect(summary).toContainText('#2');
  await expect(summary).toContainText('▼ -7'); // text + glyph, never colour alone
  await expect(summary).toContainText('1500 → 1493');

  const a = page.getByRole('region', { name: 'Problem A' });
  await expect(a).toContainText('Two Numbers, One Total');
  for (const h of [
    'Complexity',
    'Edge cases you missed',
    'Compared with the intended approach',
    'Readability',
  ])
    await expect(a.getByRole('heading', { name: h })).toBeVisible();
  await expect(a.locator('strong')).toHaveText('loop');
  await expect(a.getByRole('link', { name: 'Upsolve' })).toHaveAttribute(
    'href',
    '/p/sum-two-numbers',
  );

  // B was queued: opening the page writes it on demand
  const b = page.getByRole('region', { name: 'Problem B' });
  await expect(b.getByRole('heading', { name: 'Complexity' })).toBeVisible();
  await expect(b).toContainText('Use sorting.');
  expect(st.reviews.opened).toEqual(['00000000-0000-4000-8000-0000000000b2']); // A was already ready: not reopened

  // rating
  const useful = a.getByRole('button', { name: 'Useful', exact: true });
  await expect(useful).toHaveAttribute('aria-pressed', 'false');
  await useful.click();
  await expect(useful).toHaveAttribute('aria-pressed', 'true');
  await expect(a.getByRole('button', { name: 'Not useful' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(st.reviews.ratings).toEqual([
    { id: '00000000-0000-4000-8000-0000000000a1', helpful: true },
  ]);
});

test('AI-03: when AI is busy the review says it is queued and the page does not pretend it failed', async ({
  page,
}) => {
  await open(page, { finalized: true, reviews: 'mixed', reviewsBusy: true });
  const b = page.getByRole('region', { name: 'Problem B' });
  await expect(b).toContainText('Your review is queued');
  await expect(b.getByRole('heading', { name: 'Complexity' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Problem A' })).toContainText(
    'Linear in the input size.',
  );
});

test('S11: before the contest is final there are no results yet; a guest is asked to sign in; no submissions say so', async ({
  page,
}) => {
  await open(page, { finalized: false, reviews: 'mixed' });
  await expect(
    page.getByText('The results are final once the organisers finalise the contest.'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'My result' })).toHaveCount(0);

  const guest = await page.context().newPage();
  await open(guest, { finalized: true }, false);
  await expect(guest.locator('#main').getByRole('link', { name: 'Sign in' })).toBeVisible();

  const empty = await page.context().newPage();
  await open(empty, { finalized: true, reviews: 'none' });
  await expect(empty.getByText('You did not submit anything in this contest')).toBeVisible();
});

test('S11: the lobby of a finalised contest links to the results', async ({ page }) => {
  await stubApi(page);
  await stubContests(page, { startsInSec: -4 * 3600, durationMin: 120, finalized: true });
  await page.goto('/c/warm-up-1');
  await page.getByRole('link', { name: 'Results and AI reviews' }).click();
  await expect(page).toHaveURL(/\/c\/warm-up-1\/results$/);
});

for (const width of [1280, 390]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`S11 a11y: results at ${width}px in ${theme}, no violations and no page-level horizontal scroll`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await open(page, { finalized: true, reviews: 'mixed' });
      await expect(
        page
          .getByRole('region', { name: 'Problem B' })
          .getByRole('heading', { name: 'Complexity' }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join('>')).join('|')}`),
      ).toEqual([]);
    });
  }
}
