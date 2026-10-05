import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const shots = process.env.UI_SHOTS_DIR;

for (const [width, height] of [
  [1280, 900],
  [390, 844],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`F-07: /dev/ui at ${width}px in ${theme} theme is accessible and does not overflow`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await page.goto('/dev/ui');
      await expect(page.getByRole('heading', { name: 'UI kitchen sink' })).toBeVisible();

      // Theme follows the OS preference before first paint.
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      // WCAG 1.4.10 reflow: no page-level horizontal scroll.
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

      if (shots)
        await page.screenshot({ path: `${shots}/ui-${width}-${theme}.png`, fullPage: true });
      await ctx.close();
    });
  }
}

test('F-07: theme toggle flips and persists across reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/dev/ui');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});

test('F-07: Ctrl+K opens the palette, Esc closes it and returns focus', async ({ page }) => {
  await page.goto('/dev/ui');
  await page.getByRole('heading', { name: 'UI kitchen sink' }).waitFor();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('Type a command or search…').fill('shortcuts');
  await expect(palette.getByRole('option', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('F-07: ? opens the shortcut sheet but not while typing in a field', async ({ page }) => {
  await page.goto('/dev/ui');
  await page.getByLabel('Handle', { exact: true }).fill('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('F-07: data table rows move with arrow keys and the tab order reaches the main content', async ({
  page,
}) => {
  await page.goto('/dev/ui');
  const rows = page.getByRole('row').filter({ hasText: 'tourist_' });
  await rows.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('row').filter({ hasText: 'ayush' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
});
