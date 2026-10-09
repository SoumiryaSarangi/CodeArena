import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';

// Google needs real privacy and terms pages to publish the sign-in app; they must stay reachable,
// readable and accessible, and be linked from the footer and the sign-in page.
for (const [path, heading] of [
  ['/privacy', 'Privacy'],
  ['/terms', 'Terms of use'],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`${path} renders, is accessible in the ${theme} theme and has no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page, { signedIn: false });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText(/Last updated/)).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
      await ctx.close();
    });
  }
}

test('the privacy page says what is stored and how to ask for deletion', async ({ page }) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/privacy');
  for (const text of [
    'name, e-mail address and',
    'Cookies',
    'What is recorded during a contest',
    'deleted 30 days after the contest ends',
    'Who can see it',
    'Deletion is not self-service yet',
  ])
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  await expect(
    page.getByRole('link', { name: /github.com\/SoumiryaSarangi\/CodeArena\/issues/ }),
  ).toBeVisible();
});

test('the footer and the sign-in page link to both', async ({ page }) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/signin');
  for (const name of ['Privacy', 'Terms']) {
    await expect(page.getByRole('link', { name, exact: true }).first()).toHaveAttribute(
      'href',
      `/${name.toLowerCase()}`,
    );
  }
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Terms' })).toBeVisible();
});
