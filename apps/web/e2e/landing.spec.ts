import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

test('UI-10 S01: a signed-out visitor sees the tagline, one way in, the evidence, and no app rail', async ({
  page,
}) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'The place your campus codes together' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to start' })).toHaveAttribute(
    'href',
    /\/signin\?returnTo=/,
  );
  await expect(page.getByText('A verdict in 2.1 seconds, at the 95th percentile.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'See how it is built' })).toHaveAttribute(
    'href',
    '/status',
  );
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0); // AUDIT 14
  await expect(page.getByRole('button', { name: 'Open command palette' })).toHaveCount(0);
});

test('UI-10 S01: a signed-in visitor is offered their home, and keeps the rail', async ({
  page,
}) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Open your home' })).toHaveAttribute('href', '/home');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('UI-10 S04: on a phone the table keeps Status and Title, and the title carries the rest (AUDIT 12)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.route('**/api/problems?**', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            slug: 'peak-reading',
            title: 'Peak Reading',
            difficulty: 800,
            tags: ['arrays'],
            practicePoints: 8,
            acceptance: 91.2,
            status: 'solved',
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.goto('/practice');
  await expect(page.getByRole('columnheader', { name: 'Acceptance' })).toBeHidden();
  await expect(page.getByRole('columnheader', { name: 'Title' })).toBeVisible();
  await expect(page.getByText('91.2% accepted')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test('UI-10 S03: a 64-character handle does not widen the page on a phone (AUDIT 5)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page, {
    handle: 'a_very_long_handle_that_keeps_going_and_going_2026_campus_cohort',
  });
  await stubContests(page, { startsInSec: 3600 });
  await page.goto('/home');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('a_very_long_handle');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

for (const theme of ['dark', 'light'] as const)
  for (const width of [1280, 390])
    test(`UI-10 S01: the landing page at ${width}px in ${theme} is accessible with no horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width, height: 800 },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page, { signedIn: false });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
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
