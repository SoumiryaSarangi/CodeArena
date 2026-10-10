import { expect, test } from '@playwright/test';
import { stubAdmin } from './stub-admin';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

const OPS = '/admin/contests/11111111-1111-4111-8111-111111111111/ops';

test('UI-13 S16: the page opens with what is wrong, then groups actions by risk (AUDIT 11, 10)', async ({
  page,
}) => {
  await stubApi(page, { role: 'admin' });
  await stubAdmin(page);
  await stubContests(page, { startsInSec: -30 * 60, durationMin: 180, registered: true });
  await page.goto(OPS);
  const banner = page.getByRole('note', { name: 'Judge health' });
  await expect(banner).toContainText('judge-2 has not reported');
  await expect(banner).toContainText('1 submission is parked as dead letters');
  // time first, then repairs that touch results: separate rows with their own labels
  await expect(page.getByText('Extend by', { exact: true })).toBeVisible();
  await expect(page.getByText('Repair results', { exact: true })).toBeVisible();
  // jargon is explained where it appears
  await expect(page.getByText(/Submissions a judge gave up on/)).toBeVisible();
  await expect(page.getByText(/a lane keeps one kind of work apart/)).toBeVisible();
});

test('UI-13 S15: the statement preview does not add a second h1 (AUDIT 7)', async ({ page }) => {
  await stubApi(page, { role: 'setter' });
  await stubAdmin(page);
  await page.goto('/admin/problems/hop-distances');
  await page.getByRole('tab', { name: 'Statement' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

test('UI-13 S18: diagram labels stay about 12 px on a phone (the diagram scrolls instead of shrinking) (AUDIT 18)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page, { signedIn: false });
  await page.goto('/status');
  const label = page.locator('svg[role="img"] text').first();
  await label.scrollIntoViewIfNeeded();
  const px = await label.evaluate((e) => {
    const svg = (e as SVGTextElement).ownerSVGElement!;
    return (
      parseFloat(getComputedStyle(e).fontSize) *
      (svg.getBoundingClientRect().width / svg.viewBox.baseVal.width)
    );
  });
  expect(px).toBeGreaterThanOrEqual(11.5);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});
