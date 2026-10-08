import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { emit, runVerdict, sseUrls, stubApi } from './stub-api';
import { stubContests } from './stub-contests';

const editorReady = (page: Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
const RUNNING = { startsInSec: -30 * 60, durationMin: 180, registered: true };

async function open(
  page: Page,
  opts: Parameters<typeof stubContests>[1] = RUNNING,
  stub: Parameters<typeof stubApi>[1] = {},
  label = 'A',
) {
  const api = await stubApi(page, stub);
  const st = await stubContests(page, opts);
  await page.goto(`/c/warm-up-1/${label}`);
  return { ...api, st };
}

test.describe('C-04: contest arena (S09)', () => {
  test('the contest bar, the statement and the editor; no Coach in a contest', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
    await expect(page.getByText('Nothing special for A.')).toBeVisible();
    await expect(page.getByText('Time 500 ms')).toBeVisible();
    // The practice header's tags and rating would hint at the solution; a contest shows neither.
    await expect(page.getByLabel('Tags').locator('li')).toHaveCount(0);
    await editorReady(page);
    const bar = page.getByRole('navigation', { name: 'Contest problems' });
    await expect(bar.getByRole('link', { name: /Problem A, solved, solved by 2/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      bar.getByRole('link', { name: /Problem B, attempted, solved by 1/ }),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Coach' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Submissions' })).toBeVisible();
    await expect(page.getByText('Time left')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'href',
      '/c/warm-up-1/board',
    );
  });

  test('problem tabs switch problems without leaving the contest', async ({ page }) => {
    await open(page);
    await page.getByRole('link', { name: /Problem B/ }).click();
    await expect(page).toHaveURL(/\/c\/warm-up-1\/B$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'B. Lantern Lighting' }),
    ).toBeVisible();
    await expect(page.getByText('Nothing special for B.')).toBeVisible();
  });

  test('FR-SUB-03: submit and run go to the contest, not to practice', async ({ page }) => {
    const { calls } = await open(page);
    await editorReady(page);
    await page.getByRole('button', { name: 'Run this sample' }).first().click();
    await expect.poll(() => calls.runs.length).toBe(1);
    expect(calls.runs[0]!.body).toMatchObject({
      contestSlug: 'warm-up-1',
      label: 'A',
      sampleIds: [1],
    });
    expect(calls.runs[0]!.body).not.toHaveProperty('problemSlug');
    await page
      .getByRole('button', { name: /^Submit/ })
      .first()
      .click();
    await expect.poll(() => calls.submissions.length).toBe(1);
    expect(calls.submissions[0]!.body).toMatchObject({
      contestSlug: 'warm-up-1',
      label: 'A',
      language: 'cpp17',
    });
    expect(calls.submissions[0]!.body).not.toHaveProperty('problemSlug');
  });

  test('a verdict refreshes the problem states from the board', async ({ page }) => {
    const { st, calls } = await open(page);
    await editorReady(page);
    await expect.poll(() => st.boardRequests).toBe(1);
    await page
      .getByRole('button', { name: /^Submit/ })
      .first()
      .click();
    await expect.poll(() => calls.submissions.length).toBe(1);
    await expect.poll(() => sseUrls(page).then((u) => u.some((x) => x.includes('S1')))).toBe(true);
    await emit(page, 'S1', 'submission.verdict', '1-0', runVerdict('S1', 'AC'));
    await expect.poll(() => st.boardRequests, { timeout: 5000 }).toBe(2);
  });

  test('drafts are kept per contest problem, apart from the practice twin', async ({ page }) => {
    await open(page);
    await editorReady(page);
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('// contest draft');
    await page.waitForTimeout(800);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.some((k) => k.includes('warm-up-1~A'))).toBe(true);
    expect(keys.some((k) => k.includes('chai-bill'))).toBe(false);
  });

  test('the Alt+number shortcuts follow the three tabs a contest has', async ({ page }) => {
    await open(page);
    await editorReady(page);
    await page.keyboard.press('Alt+3');
    await expect(page.getByRole('tab', { name: 'Submissions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Alt+4');
    await expect(page.getByRole('tab', { name: 'Submissions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Alt 1–3')).toBeVisible();
  });

  test('FR-BOARD-05: the freeze banner appears from the freeze time', async ({ page }) => {
    await open(page, { startsInSec: -80 * 60, durationMin: 100, registered: true });
    await expect(page.getByText(/Standings are frozen for the last 30 min/)).toBeVisible();
    await expect(page.getByText(/You\s+still see your own results/)).toBeVisible();
  });

  test('no freeze banner before the freeze', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { name: 'A. Chai Bill' })).toBeVisible();
    await expect(page.getByText(/Standings are frozen/)).toHaveCount(0);
  });

  test('US-4.3: the last five minutes turn the timer to warning', async ({ page }) => {
    await open(page, { startsInSec: -(60 - 4) * 60, durationMin: 60, registered: true });
    await expect(page.locator('.text-warning.font-mono')).toBeVisible();
  });

  test('when the end passes, "Contest over" appears once with a link to the board', async ({
    page,
  }) => {
    await open(page, { startsInSec: -2, durationMin: 0.15, registered: true });
    // 6 s contest: it ends while the page is open.
    const dialog = page.getByRole('dialog', { name: 'Contest over' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText('Final results after the reveal.');
    await expect(dialog.getByRole('link', { name: 'Open the board' })).toHaveAttribute(
      'href',
      '/c/warm-up-1/board',
    );
    await dialog.getByRole('button', { name: 'Keep looking' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/Submissions now count as practice/)).toBeVisible();
  });

  test('opening an ended contest shows the practice note, not the modal', async ({ page }) => {
    await open(page, { startsInSec: -300 * 60, durationMin: 120, registered: true });
    await expect(page.getByRole('heading', { name: 'A. Chai Bill' })).toBeVisible();
    await expect(page.getByText(/Submissions now count as practice/)).toBeVisible();
    await expect(page.getByText('Contest ended')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('FR-PROB-09: before the start the problem is not available', async ({ page }) => {
    await open(page, { startsInSec: 3600, registered: true });
    await expect(page.getByText('This problem is not available (yet).')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the contest' })).toHaveAttribute(
      'href',
      '/c/warm-up-1',
    );
  });

  test('an unregistered visitor is sent to register', async ({ page }) => {
    await open(page, { startsInSec: -600, durationMin: 120, registered: false });
    await expect(page.getByText('Register for the contest to see its problems.')).toBeVisible();
  });

  test('a guest is asked to sign in', async ({ page }) => {
    await open(
      page,
      { startsInSec: -600, durationMin: 120, registered: false },
      { signedIn: false },
    );
    await expect(page.getByText('Sign in to take part in the contest.')).toBeVisible();
  });

  test('the lobby problem rows open the arena', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, RUNNING);
    await page.goto('/c/warm-up-1');
    await page.getByRole('link', { name: 'Lantern Lighting' }).click();
    await expect(page).toHaveURL(/\/c\/warm-up-1\/B$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'B. Lantern Lighting' }),
    ).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`C-04 a11y: arena, ${theme}, ${size.width}px, no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page);
      await stubContests(page, { startsInSec: -80 * 60, durationMin: 100, registered: true });
      await page.goto('/c/warm-up-1/A');
      await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
      if (size.width >= 1024) await editorReady(page);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .exclude('.monaco-editor')
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
