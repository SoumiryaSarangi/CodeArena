import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';

const URL = '/p/sum-two-numbers';
const openCoach = async (page: Page) => {
  await page.goto(URL);
  await page.getByRole('tab', { name: 'Coach' }).click();
};
const level = (page: Page, n: number) =>
  page.getByRole('region', { name: new RegExp(`^Level ${n}:`) });

test('UI-06: the ladder shows costs, locks level 2 until level 1, and unlocking asks for confirmation (FR-AI-01, FR-AI-04)', async ({
  page,
}) => {
  const { calls } = await stubApi(page);
  await openCoach(page);
  await expect(level(page, 1)).toContainText('−10% points');
  await expect(level(page, 2)).toContainText('−25% points');
  await expect(level(page, 3)).toContainText('−50% points');
  await expect(level(page, 2)).toContainText('Unlock level 1 first');
  await expect(level(page, 2).getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('points')).toHaveText('100 points');

  await level(page, 1).getByRole('button', { name: 'Unlock level 1' }).click();
  const dialog = page.getByRole('dialog', { name: /Unlock level 1: Concept/ });
  await expect(dialog).toContainText('lowers this problem');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(calls.hints).toHaveLength(0);

  await level(page, 1).getByRole('button', { name: 'Unlock level 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock level 1' }).click();
  await expect(level(page, 1)).toContainText('Hint text for level 1');
  await expect(level(page, 1).locator('strong')).toHaveText('sorting'); // Markdown is rendered
  await expect(page.getByTestId('points')).toHaveText('100 → 90 points');
  await expect(level(page, 2).getByRole('button', { name: 'Unlock level 2' })).toBeEnabled();
  expect(calls.hints).toEqual([{ level: 1 }]);

  // the highest level counts, not the sum
  await level(page, 2).getByRole('button', { name: 'Unlock level 2' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock level 2' }).click();
  await expect(level(page, 2)).toContainText('Hint text for level 2');
  await expect(page.getByTestId('points')).toHaveText('100 → 75 points');
});

test('UI-06: "Was this helpful?" has text labels, is pressed state, and sends the rating (FR-AI-05)', async ({
  page,
}) => {
  const { calls } = await stubApi(page);
  await openCoach(page);
  await level(page, 1).getByRole('button', { name: 'Unlock level 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock level 1' }).click();
  const helpful = level(page, 1).getByRole('button', { name: 'Helpful', exact: true });
  const notHelpful = level(page, 1).getByRole('button', { name: 'Not helpful' });
  await expect(helpful).toHaveAttribute('aria-pressed', 'false');
  await helpful.click();
  await expect(helpful).toHaveAttribute('aria-pressed', 'true');
  await notHelpful.click();
  await expect(notHelpful).toHaveAttribute('aria-pressed', 'true');
  await expect(helpful).toHaveAttribute('aria-pressed', 'false');
  expect(calls.ratings.map((r) => r.helpful)).toEqual([true, false]);
});

test('UI-06: when AI is busy the error says so; a nudge is shown and nothing is unlocked', async ({
  page,
}) => {
  await stubApi(page, { hints: { reply: 'busy' } });
  await openCoach(page);
  await level(page, 1).getByRole('button', { name: 'Unlock level 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock level 1' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Hints are busy' })).toHaveText(
    'Hints are busy, try again in a minute.',
  );
  await expect(level(page, 1).getByRole('button', { name: 'Unlock level 1' })).toBeEnabled();

  const nudge = await page.context().newPage();
  await stubApi(nudge, { hints: { reply: 'nudge' } });
  await openCoach(nudge);
  await level(nudge, 1).getByRole('button', { name: 'Unlock level 1' }).click();
  await nudge.getByRole('dialog').getByRole('button', { name: 'Unlock level 1' }).click();
  await expect(nudge.getByText('Write and run an attempt first')).toBeVisible();
  await expect(level(nudge, 1)).not.toContainText('Hint text');
});

test('UI-06: levels 2 and 3 say they need an attempt, and stay disabled until there is one', async ({
  page,
}) => {
  await stubApi(page, { hints: { noAttempt: true } });
  await openCoach(page);
  await level(page, 1).getByRole('button', { name: 'Unlock level 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock level 1' }).click();
  await expect(level(page, 1)).toContainText('Hint text for level 1'); // level 1 needs no attempt
  await expect(level(page, 2)).toContainText('Submit an attempt for this problem first');
  await expect(level(page, 2).getByRole('button', { name: 'Unlock level 2' })).toBeDisabled();
});

test('UI-06: a nudge from the server appears inside the level that asked', async ({ page }) => {
  await stubApi(page, { hints: { reply: 'nudge' } });
  await openCoach(page);
  await level(page, 1).getByRole('button', { name: 'Unlock level 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock level 1' }).click();
  await expect(level(page, 1).getByRole('status')).toHaveText(
    'Write and run an attempt first, then ask again.',
  );
});

test('UI-06: guests are asked to sign in; hints switched off show the reason and no unlock buttons', async ({
  page,
}) => {
  await stubApi(page, { signedIn: false });
  await openCoach(page);
  await expect(page.getByText('Sign in to ask the Coach for a hint.')).toBeVisible();

  const off = await page.context().newPage();
  await stubApi(off, {
    hints: { off: "Hints are off during contests — they'll be back after it ends." },
  });
  await openCoach(off);
  await expect(
    off.getByRole('status').filter({ hasText: 'Hints are off during contests' }),
  ).toBeVisible();
  await expect(off.getByRole('button', { name: /^Unlock level/ })).toBeDisabled();
});

for (const width of [1280, 390]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`UI-06 a11y: the Coach tab with a delivered hint at ${width}px in ${theme} has no violations and no page-level horizontal scroll`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page);
      await page.goto(URL);
      // narrow layout: the drawer (and its Coach tab) sits under the Console tab
      if (width < 1024) await page.getByRole('tab', { name: 'Console' }).click();
      await page.getByRole('tab', { name: 'Coach' }).click();
      await level(page, 1).getByRole('button', { name: 'Unlock level 1' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Unlock level 1' }).click();
      await expect(level(page, 1)).toContainText('Hint text for level 1');
      const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(scrolls).toBe(false);
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations.map((v) => v.id + ' ' + v.nodes.map((n) => n.target.join('>')).join('|')),
      ).toEqual([]);
    });
  }
}
