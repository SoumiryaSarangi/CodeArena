import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';

const banner = (page: import('@playwright/test').Page) =>
  page.getByRole('status').filter({ hasText: "Can't reach the server right now." });

test.describe('UI-23: notice while the servers do not answer', () => {
  test('UI-23: no notice while the server answers', async ({ page }) => {
    await stubApi(page, { signedIn: false });
    await page.goto('/');
    await page.waitForTimeout(500);
    await expect(banner(page)).toHaveCount(0);
  });

  test('UI-23: after two failed checks a notice says the server cannot be reached, and it goes away when the server answers again', async ({
    page,
  }) => {
    await stubApi(page, { signedIn: false });
    let up = false;
    let checks = 0;
    await page.route('**/api/health/live', (r) => {
      checks++;
      return up
        ? r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' })
        : r.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
    });
    await page.clock.install();
    await page.goto('/');
    await page.clock.runFor(1000);
    // one failure is not enough: it could be a blip
    await expect(banner(page)).toHaveCount(0);
    await page.clock.runFor(3500);
    await expect(banner(page)).toBeVisible();
    expect(checks).toBeGreaterThanOrEqual(2); // the dev server mounts effects twice
    await expect(banner(page)).toContainText('goes away by itself');
    // it keeps asking, and clears itself
    up = true;
    await page.clock.runFor(16_000);
    await expect(banner(page)).toHaveCount(0);
  });

  test('UI-23: a network failure counts as down, and the notice has no accessibility violations at 390 px in both themes', async ({
    browser,
  }) => {
    for (const theme of ['dark', 'light'] as const) {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      await stubApi(page, { signedIn: false });
      await page.route('**/api/health/live', (r) => r.abort('connectionrefused'));
      await page.clock.install();
      await page.goto('/signin');
      await page.clock.runFor(4500);
      await expect(banner(page)).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => v.id),
      ).toEqual([]);
      await ctx.close();
    }
  });
});
