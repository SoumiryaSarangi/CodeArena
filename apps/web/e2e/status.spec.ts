import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';

const badge = (page: Page) =>
  page.route('https://github.com/**', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="20"/>',
    }),
  );

async function open(page: Page, tweak?: (s: Record<string, unknown>) => void) {
  await badge(page);
  const { state } = await stubApi(page, { signedIn: false });
  tweak?.(state.status);
  await page.goto('/status');
  await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();
  return state;
}

test.describe('O-02: status page (S18)', () => {
  test('health: a headline, every component with a word and a detail, speed, totals and the queue', async ({
    page,
  }) => {
    await open(page);
    await expect(
      page.getByRole('status').filter({ hasText: 'All systems operational' }),
    ).toBeVisible();
    const list = page.getByRole('list', { name: 'Components' });
    await expect(list.getByRole('listitem')).toHaveCount(6);
    await expect(list.getByRole('listitem').nth(3)).toContainText('Judges');
    await expect(list.getByRole('listitem').nth(3)).toContainText('Operational');
    await expect(list.getByRole('listitem').nth(3)).toContainText('2 judges reporting');
    await expect(list.getByRole('listitem').nth(5)).toContainText('Interview pad');
    await expect(list.getByRole('listitem').nth(5)).toContainText('Not released');
    const right = page.getByRole('term').locator('xpath=..');
    await expect(right.filter({ hasText: 'p50' })).toContainText('1.2 s');
    await expect(right.filter({ hasText: 'p95' })).toContainText('3.4 s');
    await expect(right.filter({ hasText: 'Submissions judged' })).toContainText('1,234');
    await expect(right.filter({ hasText: 'Contests hosted' })).toContainText('2');
    await expect(
      page.getByText('contest 0 · interactive 0 · practice 3 · rejudge 0'),
    ).toBeVisible();
  });

  test('a degraded or down part changes the headline and the words, not only colours', async ({
    page,
  }) => {
    await open(page, (s) => {
      s.overall = 'down';
      const c = s.components as { id: string; state: string; detail: string }[];
      c[3] = { ...c[3]!, state: 'down', detail: 'No judge is reporting; submissions wait' };
      c[2] = { ...c[2]!, state: 'degraded', detail: '25 contest jobs waiting' };
    });
    await expect(page.getByRole('status').filter({ hasText: 'Judging is down' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Components' });
    await expect(list.getByRole('listitem').nth(3)).toContainText('Down');
    await expect(list.getByRole('listitem').nth(3)).toContainText('No judge is reporting');
    await expect(list.getByRole('listitem').nth(2)).toContainText('Degraded');
  });

  test('when the status service does not answer, the page says so', async ({ page }) => {
    await badge(page);
    await stubApi(page, { signedIn: false });
    await page.route('**/api/status', (r) =>
      r.fulfill({ status: 503, body: '{}', contentType: 'application/json' }),
    );
    await page.goto('/status');
    await expect(page.getByText('Status unavailable')).toBeVisible();
  });

  test('it explains judging in five steps, draws the architecture, and describes the security checks', async ({
    page,
  }) => {
    await open(page);
    await expect(
      page
        .getByRole('list')
        .filter({ has: page.getByText('You submit.') })
        .getByRole('listitem'),
    ).toHaveCount(5);
    await expect(page.getByText('The verdict streams back.')).toBeVisible();
    await expect(
      page.getByRole('img', { name: /Architecture: the browser reaches the web app/ }),
    ).toBeVisible();
    await expect(page.getByText('28 attack programs')).toBeVisible();
    await expect(page.getByRole('link', { name: /Nightly runs on GitHub/ })).toHaveAttribute(
      'href',
      /actions\/workflows\/nightly-attack\.yml$/,
    );
    await expect(page.getByRole('table', { name: /Burst test results by number/ })).toContainText(
      '26.6 s / 50.8 s',
    );
    await expect(page.getByRole('row', { name: /^2 / })).toContainText('0.4 s / 2.1 s');
  });

  test('the top bar shows the same state in words and links to the page', async ({ page }) => {
    await badge(page);
    const { state } = await stubApi(page, { signedIn: false });
    await page.goto('/practice');
    const dot = page.getByRole('link', { name: 'Systems normal' });
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('href', '/status');
    state.status.overall = 'degraded';
    await page.goto('/practice');
    await expect(page.getByRole('link', { name: 'Degraded performance' })).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`O-02 a11y: status page, ${theme}, ${size.width}px, no horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await badge(page);
      await stubApi(page, { signedIn: false });
      await page.goto('/status');
      await expect(page.getByRole('list', { name: 'Components' })).toBeVisible();
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
  }
}
