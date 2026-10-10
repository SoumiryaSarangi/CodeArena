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
  await expect(page.getByText('A verdict, at the 95th percentile.')).toBeVisible();
  await expect(page.getByText('2.1 s', { exact: true }).first()).toBeVisible();
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

test('UI-16 S01: the hero plays the six steps of one submission and ends lit, with only measured numbers beside it', async ({
  page,
}) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/');
  const steps = page.getByRole('figure').first().getByRole('listitem');
  await expect(steps).toHaveCount(6);
  await expect(steps.last()).toContainText('Verdict');
  await expect(steps.last()).toContainText('AC');
  // the end state: every step fully visible
  await expect
    .poll(() => steps.evaluateAll((l) => l.every((e) => getComputedStyle(e).opacity === '1')))
    .toBe(true);
  await expect(
    page.getByText(/queue wait 0\.0 s median, 0\.5 s at the 95th percentile/),
  ).toBeVisible();
});

test('UI-16 S01: with reduced motion the steps are lit at once', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await stubApi(page, { signedIn: false });
  await page.goto('/');
  const steps = page.getByRole('figure').first().getByRole('listitem');
  await expect(steps).toHaveCount(6);
  expect(await steps.evaluateAll((l) => l.every((e) => getComputedStyle(e).opacity === '1'))).toBe(
    true,
  );
  await ctx.close();
});

test('UI-16 S01: the live strip shows real rows, Pause stops the polling, Resume starts it again', async ({
  page,
}) => {
  const { state } = await stubApi(page, { signedIn: false });
  await page.goto('/');
  const strip = page.getByRole('region', { name: /Live from practice/ });
  await expect(strip).toContainText('Two Numbers, One Total');
  await expect(strip).toContainText('AC');
  await expect(strip).toContainText('41 ms');
  await expect(strip.getByText('Maze Runner')).toBeVisible();
  const reads = state.verdicts.reads;
  await strip.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(500);
  const paused = state.verdicts.reads;
  expect(paused).toBe(reads); // no request after Pause
  await strip.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => state.verdicts.reads).toBeGreaterThan(paused);
});

test('UI-16 S01: the live strip is absent, not zero, when there are no verdicts or the API fails', async ({
  page,
}) => {
  const { state } = await stubApi(page, { signedIn: false });
  state.verdicts.items = [];
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: /Live from practice/ })).toHaveCount(0);
  const failing = await page.context().newPage();
  const s2 = await stubApi(failing, { signedIn: false });
  s2.state.verdicts.fail = true;
  await failing.goto('/');
  await expect(failing.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(failing.getByRole('region', { name: /Live from practice/ })).toHaveCount(0);
});

test('UI-16 S01: the verdict mix says its four counts in words and they add up to the 500 of the load test', async ({
  page,
}) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/');
  const bar = page.getByRole('img', { name: /Verdicts of 500 submissions/ });
  await expect(bar).toHaveAttribute(
    'aria-label',
    /Accepted 337, Wrong answer 108, Time limit 44, Runtime error 11/,
  );
  expect(337 + 108 + 44 + 11).toBe(500);
  await expect(page.getByText('58 s')).toBeVisible();
  await expect(page.getByText('2 s', { exact: true })).toBeVisible();
});

test('UI-16 S01: the sample scoreboard says it is sample data', async ({ page }) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/');
  await expect(page.getByText(/^Sample data: made-up handles/)).toBeVisible();
  await expect(page.getByRole('region', { name: /Sample scoreboard/ })).toBeVisible();
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
